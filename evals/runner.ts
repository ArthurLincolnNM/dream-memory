/**
 * dream-memory/evals/runner.ts
 *
 * Regression eval runner for the recall/scoring heuristics.
 *
 * Why this exists: dream-memory stacks four layers of heuristics for
 * search ranking (BM25 → score floor → time decay → IDF anchor). Changing
 * any constant in `search/hybrid.ts` or `ttl/decay.ts` can silently
 * worsen recall — there's no signal until the user notices "it stopped
 * remembering X". This runner makes that regression visible.
 *
 * Usage:
 *   import { runEvals } from "./evals/runner.js";
 *   const result = runEvals(store, { cases, topK: 5 });
 *
 * The runner is pure: it takes a `DreamStore` (and optional cases) and
 * returns a summary. It does NOT touch the real memory DB. The caller
 * (the `/dream-eval` command) decides which store to test against.
 *
 * Two modes are useful:
 *   1. Test against existing memories: pass the user's global.db and
 *      see which eval cases pass. Cases that fail = "the system can't
 *      find a memory that should exist" — usually a data gap.
 *   2. Seed-and-test: pass an empty (or fresh) store, populate it
 *      with the eval seeds (see evals/seeds.ts), then run. This
 *      measures recall quality independent of user data.
 */

import type { DreamStore, Memory } from "../store/sqlite.js";

export interface EvalCase {
	id: string;
	description?: string;
	query: string;
	expectedTarget: Memory["target"];
	expectedCategory?: Memory["category"];
	/** Substring that MUST appear in at least one of the top-K results. */
	mustContain?: string;
	/** Substring that MUST NOT appear in any of the top-K results. */
	mustNotContain?: string;
	/**
	 * F10: Adversarial/abstention threshold. If set, the case PASSES only
	 * if ALL top-K results have score below this value. Use for queries
	 * that should NOT match any memory (the system should abstain).
	 */
	maxScore?: number;
}

export interface EvalOptions {
	cases: EvalCase[];
	/** Top-K for precision/recall measurement. Default 5. */
	topK?: number;
	/** Optional filter by target before scoring. */
	targetFilter?: Memory["target"];
	/** Optional filter by category before scoring. */
	categoryFilter?: Memory["category"];
}

export interface CaseResult {
	caseId: string;
	passed: boolean;
	reason: string;
	/** Top-K memory ids that were returned (for debugging). */
	topResults: Array<{ id: string; content: string; score: number }>;
}

export interface EvalSummary {
	total: number;
	passed: number;
	failed: number;
	/** Cases that passed precision (at least one match in top-K). */
	precisionAtK: number;
	/** Cases that passed the mustNotContain check. */
	precisionNeg: number;
	/** Average rank of the first match (lower = better). Undefined for failed. */
	avgFirstMatchRank: number;
	durationMs: number;
	results: CaseResult[];
}

/**
 * Run a single case. Returns a CaseResult with pass/fail and diagnostics.
 */
function runCase(store: DreamStore, c: EvalCase, topK: number, options: { targetFilter?: Memory["target"]; categoryFilter?: Memory["category"] }): CaseResult {
	const opts: any = { limit: topK };
	if (options.targetFilter) opts.target = options.targetFilter;
	if (options.categoryFilter) opts.category = options.categoryFilter;
	const hits = store.searchByQuery(c.query, opts);
	const top = hits.slice(0, topK).map((h) => ({
		id: h.memory.id,
		content: h.memory.content,
		score: h.score,
	}));

	// Filter top by expected target/category (the raw search may have
	// returned wrong-target hits; we measure the filtered result).
	const filtered = top.filter(
		(r) => {
			const mem = store.getMemory(r.id);
			if (!mem) return false;
			if (mem.target !== c.expectedTarget) return false;
			if (c.expectedCategory && mem.category !== c.expectedCategory) return false;
			return true;
		},
	);

	// Check mustContain: at least one filtered result must contain the substring.
	const containHit = c.mustContain
		? filtered.find((r) => r.content.toLowerCase().includes(c.mustContain!.toLowerCase()))
		: undefined;

	// Check mustNotContain: no result (filtered OR unfiltered) should contain it.
	const violation = c.mustNotContain
		? top.find((r) => r.content.toLowerCase().includes(c.mustNotContain!.toLowerCase()))
		: undefined;

	if (c.mustNotContain && violation) {
		return {
			caseId: c.id,
			passed: false,
			reason: `mustNotContain "${c.mustNotContain}" found in result ${violation.id}`,
			topResults: top,
		};
	}

	// F10: Adversarial/abstention check. If maxScore is set, ALL results
	// must have score below the threshold. This tests that the system
	// correctly abstains when no relevant memory exists.
	if (c.maxScore !== undefined) {
		const violatingResult = top.find((r) => r.score >= c.maxScore!);
		if (violatingResult) {
			return {
				caseId: c.id,
				passed: false,
				reason: `maxScore ${c.maxScore} exceeded: result ${violatingResult.id} scored ${violatingResult.score.toFixed(3)}`,
				topResults: top,
			};
		}
		// Pass: no result exceeded the threshold
		return {
			caseId: c.id,
			passed: true,
			reason: `abstained (max score ${top.length > 0 ? top[0].score.toFixed(3) : "none"} < ${c.maxScore})`,
			topResults: top,
		};
	}

	if (c.mustContain && !containHit) {
		return {
			caseId: c.id,
			passed: false,
			reason: `mustContain "${c.mustContain}" not found in top-${topK} (expected target=${c.expectedTarget})`,
			topResults: top,
		};
	}

	if (filtered.length === 0 && c.mustContain) {
		// mustContain check above would have caught this, but if neither
		// filter is set, we still want a result.
		return {
			caseId: c.id,
			passed: false,
			reason: `no result with target=${c.expectedTarget} in top-${topK}`,
			topResults: top,
		};
	}

	// Find the rank of the first match (1-indexed) for diagnostics.
	const matchIdx = containHit
		? filtered.indexOf(containHit)
		: filtered.length > 0
		? 0
		: -1;
	const rank = matchIdx >= 0 ? matchIdx + 1 : -1;

	return {
		caseId: c.id,
		passed: true,
		reason: rank > 0 ? `matched at rank ${rank}` : "matched",
		topResults: top,
	};
}

/**
 * Run all eval cases against a store. Returns a summary.
 */
export function runEvals(store: DreamStore, options: EvalOptions): EvalSummary {
	const start = Date.now();
	const topK = options.topK ?? 5;
	const results: CaseResult[] = [];

	for (const c of options.cases) {
		results.push(
			runCase(store, c, topK, {
				targetFilter: options.targetFilter,
				categoryFilter: options.categoryFilter,
			}),
		);
	}

	const passed = results.filter((r) => r.passed).length;
	const failed = results.length - passed;
	const ranks = results
		.filter((r) => r.passed && r.reason.startsWith("matched at rank"))
		.map((r) => Number(r.reason.split(" ")[2]));
	const avgFirstMatchRank = ranks.length > 0 ? ranks.reduce((a, b) => a + b, 0) / ranks.length : 0;

	// Precision at K: fraction of cases with at least one relevant result.
	// Recall is implicit: if a case is in the corpus, we expect 1 hit.
	// We measure precision by counting cases that passed.
	const precisionAtK = results.length > 0 ? passed / results.length : 0;

	// Negative precision: how many cases that had mustNotContain passed it.
	const negCases = results.filter((r) => r.reason.includes("mustNotContain"));
	const precisionNeg =
		negCases.length > 0
			? negCases.filter((r) => r.passed).length / negCases.length
			: 1.0; // no negative cases = 100% by default

	return {
		total: results.length,
		passed,
		failed,
		precisionAtK,
		precisionNeg,
		avgFirstMatchRank,
		durationMs: Date.now() - start,
		results,
	};
}

/**
 * Format an EvalSummary as a human-readable table.
 * Used by the /dream-eval command.
 */
export function formatEvalSummary(summary: EvalSummary): string {
	const lines: string[] = [];
	lines.push(`Evals: ${summary.passed}/${summary.total} passed (${(summary.precisionAtK * 100).toFixed(0)}%)`);
	lines.push(`Precision: ${(summary.precisionAtK * 100).toFixed(1)}% | Negative precision: ${(summary.precisionNeg * 100).toFixed(1)}%`);
	if (summary.avgFirstMatchRank > 0) {
		lines.push(`Avg first-match rank: ${summary.avgFirstMatchRank.toFixed(2)}`);
	}
	lines.push(`Duration: ${summary.durationMs}ms`);
	lines.push("");

	if (summary.failed > 0) {
		lines.push("Failed cases:");
		for (const r of summary.results.filter((x) => !x.passed)) {
			lines.push(`  ✗ [${r.caseId}] ${r.reason}`);
		}
		lines.push("");
	}

	lines.push("All cases:");
	for (const r of summary.results) {
		const mark = r.passed ? "✓" : "✗";
		lines.push(`  ${mark} [${r.caseId}] ${r.reason}`);
	}

	return lines.join("\n");
}

// ── Persistence (used by /dream-eval to save, /dream-doctor to read) ────

export interface SavedEvalScore {
	passed: number;
	total: number;
	timestamp: number;
	durationMs: number;
}

const EVAL_SCORE_KEY = "eval_last_score";

/**
 * Save the eval summary to the store's `stats` table. Called by /dream-eval
 * after a successful run so /dream-doctor can display the latest score
 * without re-running the eval.
 */
export function saveEvalScore(store: DreamStore, summary: EvalSummary): void {
	const payload: SavedEvalScore = {
		passed: summary.passed,
		total: summary.total,
		timestamp: Date.now(),
		durationMs: summary.durationMs,
	};
	store.setStat(EVAL_SCORE_KEY, JSON.stringify(payload));
}

/**
 * Load the last saved eval score. Returns null if never run.
 */
export function loadEvalScore(store: DreamStore): SavedEvalScore | null {
	const raw = store.getStat(EVAL_SCORE_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as SavedEvalScore;
	} catch {
		return null;
	}
}

/**
 * Format a saved score for display in /dream-doctor. Compact one-liner
 * so it fits in the doctor report without bloating it.
 */
export function formatEvalScoreForDoctor(score: SavedEvalScore | null): string {
	if (!score) {
		return "Evals: not run yet — /dream-eval to baseline";
	}
	const pct = score.total > 0 ? Math.round((score.passed / score.total) * 100) : 0;
	const date = new Date(score.timestamp).toISOString().split("T")[0];
	return `Evals: ${score.passed}/${score.total} passed (${pct}%) — last run ${date}, /dream-eval to refresh`;
}
