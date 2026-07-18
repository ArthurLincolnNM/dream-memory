/**
 * dream-memory/recall/inject.ts
 * Context injection for recalled memories
 */

import type { SearchResult } from "../search/hybrid.js";
import { calculateDecay } from "../ttl/decay.js";
import { calculateStringSimilarity } from "../contradiction/detector.js";

/**
 * Escape XML special characters
 */
function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface InjectOptions {
	maxTokens: number;
	format: "xml" | "markdown" | "plain";
	/**
	 * Per-memory token cap. A single memory's text is truncated to this many
	 * tokens (~4 chars/token) before injection. Default 300 tokens (~1200
	 * chars) — enough for 1-2 sentences plus context, not enough to swallow
	 * the whole recall budget. Prevents one giant memory from eating the
	 * maxTokens budget and starving the rest of the recall.
	 */
	perMemoryTokens?: number;
	/**
	 * R6: per-category cap on injected memories. Maps category name to
	 * max memories from that category in a single recall output. Default
	 * empty (no cap). Lowest-scored excess is dropped. Read-time, no
	 * DB write.
	 *
	 * Use case: a user with 500+ preference memories would see recall
	 * dominated by preferences. Cap of { "preference": 20 } forces the
	 * agent to see the top-20 preferences, not the top-20 of any kind.
	 */
	categoryCaps?: Record<string, number>;
	/**
	 * Gap #1 (Claude-like relevance gate, opt-in): the user's verbatim
	 * query. When provided, the recall detects intent (debug / preference /
	 * procedure / convention / insight / general) and boosts memories of
	 * the matching category. Backward compatible: callers that don't pass
	 * `query` see no behavior change. The boost is multiplicative on
	 * score (no-op on non-matching categories, no drop, no count change),
	 * and runs AFTER dedup and BEFORE R6 cap so the boosted ordering
	 * participates in both.
	 */
	query?: string;
}

const DEFAULT_INJECT_OPTIONS: InjectOptions = {
	maxTokens: 4000,
	format: "xml",
	perMemoryTokens: 300,
	categoryCaps: {}, // R6: empty by default (opt-in via config)
};

// ── Gap #1: Intent detection + boost map ──
//
// Detects the user's intent from the query keywords (pt-BR + en) and
// returns a category→multiplier map. Re-rank only — no drop, no count
// change. Backward compatible: callers that don't pass `query` see no
// behavior change (INTENT_BOOSTS lookup is skipped entirely).

type RecallIntent = "debug" | "preference" | "procedure" | "convention" | "insight" | "general";

function detectRecallIntent(query: string): RecallIntent {
	const lower = query.toLowerCase();
	// Debug signals: user is troubleshooting. Failure/correction/tool-quirk
	// are the highest-signal categories here.
	if (
		/\b(erro|error|bug|fail|broken|crash|exception|stacktrace|debug|fix|nao funciona|quebrou|nao compila|failing)\b/.test(
			lower,
		)
	) {
		return "debug";
	}
	// Preference signals: user is asking what they like / want.
	if (/\b(prefer|gosto|like|want|instead|em vez de|rather than|vs|versus)\b/.test(lower)) {
		return "preference";
	}
	// Procedure signals: user wants a workflow / how-to.
	if (/\b(how to|como|workflow|process|step|passo|setup|config|install|create|build|deploy)\b/.test(lower)) {
		return "procedure";
	}
	// Convention signals: user is checking project rules / standards.
	if (/\b(standard|convention|rule|policy|padrao|regra|naming|style|format)\b/.test(lower)) {
		return "convention";
	}
	// Insight signals: user is reasoning about something.
	if (/\b(why|porque|learn|insight|discover|percebi|understood|entendi)\b/.test(lower)) {
		return "insight";
	}
	return "general";
}

// Boost values per intent. Primary category gets 2.0x; related secondary
// gets 1.3x. Non-matching categories are NOT penalized (no re-rank
// penalty) — we want to surface more relevant, not hide less relevant.
// 2.0x is aggressive enough to override a base-score gap of 1.5x
// (e.g. failure 0.3 → 0.6 vs preference 0.5 → 0.5 on a debug query) but
// soft enough to not bury genuinely high-scored non-matching memories.
const INTENT_BOOSTS: Record<RecallIntent, Record<string, number>> = {
	debug: { failure: 2.0, correction: 2.0, "tool-quirk": 2.0, convention: 1.3 },
	preference: { preference: 2.0 },
	procedure: { procedure: 2.0, convention: 1.3, "tool-quirk": 1.3 },
	convention: { convention: 2.0, procedure: 1.3 },
	insight: { insight: 2.0, procedure: 1.3 },
	general: {},
};


/**
 * Per-memory cap in characters. Derived from perMemoryTokens (4 chars/token
 * heuristic, matching the global maxChars calculation below).
 */
function perMemoryCharCap(opts: InjectOptions): number {
	return (opts.perMemoryTokens ?? 300) * 4;
}

/**
 * Truncate text to maxChars, adding an ellipsis if cut. If text is already
 * short enough, returns it unchanged.
 */
function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars - 3) + "...";
}

/**
 * Format search results for injection into LLM context
 */
export function formatRecallForInjection(results: SearchResult[], options: InjectOptions = DEFAULT_INJECT_OPTIONS): string {
	if (results.length === 0) return "";

	const opts = { ...DEFAULT_INJECT_OPTIONS, ...options };

	// ── Score Floor: discard results with very low score or decay ──
	// These waste tokens without adding value. The thresholds are
	// conservative — only removes obviously useless results.
	const MIN_SCORE = 0.1;
	const MIN_DECAY = 0.1;

	const filteredResults = results.filter(r => {
		const decay = calculateDecay(r.memory);
		const normalizedScore = Math.max(0, r.score);
		return normalizedScore > MIN_SCORE && decay > MIN_DECAY;
	});

	if (filteredResults.length === 0) return "";

	// ── Near-duplicate dedup (R1 v3) ──
	// Group by content similarity; keep only the top-scored of each group.
	// Read-time only — does NOT write to DB. Symmetric with score floor
	// above. Trigger: user reported 4 CosyVoice memories surfacing in
	// recall (different content, same topic). Status='active' filter alone
	// can't catch this because none of the 4 are actually superseded —
	// they're just near-duplicates that never went through synthesis.
	//
	// Sort by score DESC first so the top-scored memory in each similarity
	// group is encountered first and wins. In production, hybridSearch /
	// scopedSearch already sort by score DESC, so this is a defensive
	// normalization (callers that bypass search, e.g. tests, stay correct).
	// O(N log N) on N≤15 is negligible.
	//
	// Threshold 0.7: conservative. Catches obvious paraphrases of the same
	// fact, leaves genuinely different memories alone. Lower = aggressive
	// (risk: drop legitimately distinct content). Higher = permissive
	// (risk: duplicates still surface). 0.7 is the sweet spot validated
	// against the recall.test.ts scenarios.
	//
	// Short content (< 20 chars) skips dedup: similarity on tiny strings is
	// noisy (a/b vs a/c both score ~0.5 regardless of meaning) and the
	// token savings from removing them are negligible.
	const sortedByScore = [...filteredResults].sort((a, b) => b.score - a.score);
	const SIMILARITY_DEDUP_THRESHOLD = 0.7;
	const SHORT_CONTENT_SKIP = 20;
	const dedupedResults: SearchResult[] = [];
	for (const r of sortedByScore) {
		if (r.memory.content.length < SHORT_CONTENT_SKIP) {
			dedupedResults.push(r);
			continue;
		}
		const isDuplicate = dedupedResults.some(
			(prev) => calculateStringSimilarity(r.memory.content, prev.memory.content) > SIMILARITY_DEDUP_THRESHOLD,
		);
		if (!isDuplicate) dedupedResults.push(r);
	}

	if (dedupedResults.length === 0) return "";

	// ── Gap #1: intent-based relevance boost (opt-in via opts.query) ──
	// Detects what the user is doing from the query and re-ranks the
	// recall so the most relevant category surfaces higher. Heuristic
	// only — no LLM call, no latency added, no behavior change when
	// `query` is not provided.
	//
	// Map (pt-BR + en keywords → intent):
	//   debug      — "erro", "error", "bug", "fail", "broken", "fix",
	//                "debug", "stacktrace", "quebrou", "não funciona"
	//   preference — "prefer", "gosto", "like", "want", "instead of",
	//                "em vez de"
	//   procedure  — "how to", "como", "workflow", "process", "step",
	//                "passo", "setup", "config", "install"
	//   convention — "standard", "convention", "rule", "policy",
	//                "padrão", "regra"
	//   insight    — "why", "porque", "learn", "insight", "discover"
	//   general    — fallback, no boost
	//
	// Boost values: 1.5x for the primary matching category, 1.2x for
	// related secondary. Non-matching categories are NOT penalized (would
	// be re-rank penalty; not what we want — we want to surface more
	// relevant, not hide less relevant). Cap by R6 (configured separately).
	if (opts.query) {
		const intent = detectRecallIntent(opts.query);
		const boosts = INTENT_BOOSTS[intent];
		if (boosts) {
			dedupedResults.sort((a, b) => {
				const boostA = a.memory.category ? (boosts[a.memory.category] ?? 1) : 1;
				const boostB = b.memory.category ? (boosts[b.memory.category] ?? 1) : 1;
				return b.score * boostB - a.score * boostA;
			});
		}
	}

	// ── R6 v3: per-category cap ──
	// Group by category; for each group, if count > cap, drop the
	// lowest-scored excess. Read-time only — does NOT write to DB.
	//
	// Why this layer, not search or synthesis: it's the simplest place to
	// fix the symptom (recall dominated by one category) without changing
	// search ranking or evicting storage. Mirrors R1 v3 (dedup) and R3
	// v3 (stale) — all read-time filters in inject.ts.
	//
	// Edge cases:
	//   - Empty caps: no-op (default config).
	//   - Category not in caps: no cap for that category (only listed
	//     categories are constrained).
	//   - Cap = 0: drop ALL memories of that category (use case: hide
	//     stale categories during migration).
	const categoryCaps = opts.categoryCaps ?? {};
	if (Object.keys(categoryCaps).length > 0) {
		const byCategory = new Map<string, SearchResult[]>();
		for (const r of dedupedResults) {
			const cat = r.memory.category || "_uncategorized";
			if (!byCategory.has(cat)) byCategory.set(cat, []);
			byCategory.get(cat)!.push(r);
		}
		const cappedResults: SearchResult[] = [];
		for (const [cat, group] of byCategory) {
			const cap = categoryCaps[cat];
			if (cap === undefined) {
				cappedResults.push(...group);
				continue;
			}
			if (group.length <= cap) {
				cappedResults.push(...group);
				continue;
			}
			// Sort by score DESC and keep top-cap.
			const sorted = [...group].sort((a, b) => b.score - a.score);
			cappedResults.push(...sorted.slice(0, cap));
		}
		// Re-sort globally by score (we broke ordering by grouping).
		dedupedResults.length = 0;
		dedupedResults.push(...cappedResults.sort((a, b) => b.score - a.score));
	}

	// ── R3 v3: Read-time stale detection ──
	// Pairwise check: for each pair of recalled memories with same
	// target+category and content similarity in (0.6, 0.95), flag the
	// older as stale. Read-time only — does NOT write to DB.
	//
	// Why threshold 0.6 < R1 v3's 0.7: R1 v3 dedups near-identical (≥0.7)
	// as one. R3 catches the looser band where two memories survive
	// dedup but might contradict or supersede each other. The lower
	// bound (0.6) prevents random topical overlap from triggering
	// false-positive stale flags. Upper bound (0.95) is well above R1 v3's
	// threshold so we never re-process memories R1 already deduped.
	//
	// Same target+category: only flag within a semantic group. A
	// user-preference and a project-convention that happen to be
	// topically similar are not stale-vs-newer — they coexist.
	//
	// arXiv 2606.24775 finding #3: graph-based methods handle updates
	// most reliably; append-only stores suffer "hallucinations of the
	// past". R3 is a cheap read-time approximation: we don't have a
	// graph, but we can flag the older entry as superseded-by-newer so
	// the agent knows to prefer the newer. Cost: O(N²) on N≤15 = 105
	// comparisons, negligible.
	//
	// Short content skipped (same reason as R1 v3).
	const STALE_SIMILARITY_LOW = 0.6;
	const STALE_SIMILARITY_HIGH = 0.95;
	const resultsWithStale: Array<{
		result: SearchResult;
		stale?: { reason: string; supersededBy: string };
	}> = dedupedResults.map((result) => ({ result }));
	for (let i = 0; i < resultsWithStale.length; i++) {
		const a = resultsWithStale[i].result;
		if (a.memory.content.length < 20) continue;
		for (let j = i + 1; j < resultsWithStale.length; j++) {
			const b = resultsWithStale[j].result;
			if (b.memory.content.length < 20) continue;
			if (a.memory.target !== b.memory.target) continue;
			if (a.memory.category !== b.memory.category) continue;
			const sim = calculateStringSimilarity(a.memory.content, b.memory.content);
			if (sim < STALE_SIMILARITY_LOW || sim > STALE_SIMILARITY_HIGH) continue;
			// Flag the older one (smaller updated_at) as stale. Tiebreak:
			// created_at (the one created first is older even if updated).
			const aOlder = a.memory.updated_at < b.memory.updated_at
				|| (a.memory.updated_at === b.memory.updated_at && a.memory.created_at <= b.memory.created_at);
			const olderEntry = aOlder ? resultsWithStale[i] : resultsWithStale[j];
			const newer = aOlder ? b : a;
			if (!olderEntry.stale) {
				olderEntry.stale = { reason: "newer-version-exists", supersededBy: newer.memory.id };
			}
		}
	}

	// Estimate tokens (rough: 4 chars per token)
	const maxChars = opts.maxTokens * 4;
	const perMemoryCap = perMemoryCharCap(opts);

	let output = "";
	let currentChars = 0;

	for (const { result, stale } of resultsWithStale) {
		const entry = formatSingleEntry(result, opts.format, perMemoryCap, stale);
		if (currentChars + entry.length > maxChars) break;

		output += entry;
		currentChars += entry.length;
	}

	if (!output) return "";

	return wrapInContainer(output, opts.format);
}

function formatSingleEntry(
	result: SearchResult,
	format: InjectOptions["format"],
	perMemoryCap: number,
	stale?: { reason: string; supersededBy: string },
): string {
	const { memory, score, snippet } = result;
	const targetLabel = memory.target;
	// Previous code prefixed category with ":" (e.g., "category=\":failure\""),
	// producing a value with a leading colon in the XML attribute. Use the bare
	// category name; downstream consumers can join with ":" if they need to.
	const categoryLabel = memory.category || "";

	// Use the snippet (calculated by searchByQuery around the anchor token)
	// instead of the full memory content. The snippet is the relevant window
	// for the current query — for short memories (<200 chars) it's identical
	// to the full content; for long memories it's a focused excerpt that
	// keeps the recall budget small. Falls back to full content if the
	// snippet is empty (shouldn't happen, but defensive).
	//
	// Per-memory cap: even the snippet can be huge for verbose memories.
	// The cap ensures one memory can't eat the entire maxTokens budget.
	//
	// Strip snippet highlight markers: the FTS5 snippet function uses
	// `<<` and `>>` to wrap matched terms (e.g., "<<Zed>>"). These are
	// useful for UI highlighting but should NOT be injected into the LLM
	// context as literal text — they would be confusing and waste tokens.
	// The replace must run BEFORE truncate so the cap sees the cleaned text.
	const rawText = (snippet && snippet.length > 0) ? snippet : memory.content;
	const cleanedText = rawText.replace(/<<|>>/g, "");
	const text = truncate(cleanedText, perMemoryCap);

	switch (format) {
		case "xml":
			// Clamp score to [0, 1] before formatting. The score from searchByQuery
			// is `-r.rank` (negated BM25) which can be negative for very poor
			// matches. Showing a negative percentage in markdown or a negative
			// score attr in XML was misleading. We normalize to 0 here.
			const normalizedScore = Math.max(0, score);
			const decayScore = calculateDecay(memory);
			const confidenceLabel = memory.confidence || "explicit";
			const reasonAttr = (memory.metadata as any)?.reason
				? ` reason="${escapeXml((memory.metadata as any).reason)}"`
				: "";
			// Provenance: short "session:turn" string when both are present.
			// Older memories (created before v1.6) have null/undefined here
			// and we omit the attribute entirely — no noise for legacy data.
			// Use != null (not !== undefined) because parseRow does NOT
			// normalize SQL NULL to undefined for these columns; a null
			// would render as the string "null" otherwise.
			const provenanceAttr = (memory.source_session_id && memory.source_turn_id != null)
				? ` provenance="${escapeXml(`${memory.source_session_id.slice(0, 8)}:${memory.source_turn_id}`)}"`
				: "";
			// R3 v3: stale flag. When the older of a (same target+category,
			// similarity in 0.6-0.95) pair, surface this so the agent can
			// prefer the newer. Read-time only — no DB write.
			const staleAttr = stale
				? ` stale="true" stale-reason="${escapeXml(stale.reason)}" superseded-by="${escapeXml(stale.supersededBy)}"`
				: "";
			// v1.7: episodic vs semantic kind. Helps the agent distinguish
			// a concrete event ("tool X failed 3x today") from an
			// abstracted principle ("avoid tool X for Y"). Defaults to
			// 'semantic' for legacy rows (where kind is NULL/omitted).
			const kindLabel = memory.memory_kind || "semantic";
			// v1.8: tags. Comma-separated in the XML attr, omitted when empty
			// to keep the recall output clean. Agent can filter by tag when
			// it cares about a specific domain (e.g., "rust", "postgres").
			const tagsLabel = memory.tags && memory.tags.length > 0
				? ` tags="${escapeXml(memory.tags.join(","))}"`
				: "";
			// F1: link relation type. Surfaced when this memory was surfaced
			// via link expansion (not a direct match). Shows the semantic
			// relationship to the parent memory.
			const linkAttr = result.linkRelation
				? ` link="${escapeXml(result.linkRelation)}" linked-from="${escapeXml(result.linkedFrom || "")}"`
				: "";
			// v2.0: trust_level attribute. Maps numeric 0-3 to human-readable label.
			// Shows the trust hierarchy so the agent can reason about which
			// memories are most reliable when conflicts arise.
			const TRUST_LABELS: Record<number, string> = { 0: "llm_extracted", 1: "llm_suggested", 2: "agreed_upon", 3: "user_stated" };
			const trustLevel = memory.trust_level ?? 2;
			const trustLabel = TRUST_LABELS[trustLevel] || "agreed_upon";
			const trustAttr = ` trust="${trustLabel}"`;
			return `  <memory target="${escapeXml(targetLabel)}"${categoryLabel ? ` category="${escapeXml(categoryLabel)}"` : ""} score="${normalizedScore.toFixed(2)}" decay="${decayScore.toFixed(2)}" confidence="${confidenceLabel}" kind="${escapeXml(kindLabel)}"${trustAttr}${tagsLabel}${provenanceAttr}${reasonAttr}${staleAttr}${linkAttr}>${escapeXml(text)}</memory>\n`;

		case "markdown":
			const pctScore = Math.max(0, Math.min(1, score));
			const confidenceMd = memory.confidence || "explicit";
			const staleNoteMd = stale ? ` [stale: ${stale.reason}]` : "";
			return `- [${targetLabel}${categoryLabel ? ":" + categoryLabel : ""}] ${text} (${(pctScore * 100).toFixed(0)}%) [${confidenceMd}]${staleNoteMd}\n`;

		case "plain":
			const staleNotePlain = stale ? ` (stale: ${stale.reason})` : "";
			return `- ${text}${staleNotePlain}\n`;
	}
}

function wrapInContainer(content: string, format: InjectOptions["format"]): string {
	switch (format) {
		case "xml":
			return `<dream_memories>\n${content}</dream_memories>`;

		case "markdown":
			return `## Recalled Memories\n${content}`;

		case "plain":
			return `Memories:\n${content}`;
	}
}

/**
 * Estimate token count for injection
 * (kept internal — not exported)
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
