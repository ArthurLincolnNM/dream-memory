/**
 * Tests for synthesis scope routing (bug #3 fix).
 *
 * Background: `applySynthesis` hardcoded `scope: "global"` when creating
 * the synthesized memory. When called with the project output store, the
 * result was a global-scoped memory living in project.db — the global-only
 * recall path would never find it. The fix requires the caller to pass
 * the desired scope info, and the function uses it.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { applySynthesis, findSynthesisCandidates, reclusterStaleSyntheses, synthesize } from "../dream/synthesis.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-synth-test-"));
	const store = new DreamStore(join(dir, "test.db"));
	return {
		store,
		dir,
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("applySynthesis creates a memory with the passed scope=global + scopeId=null", () => {
	const { store, cleanup } = makeStore();
	try {
		// Seed 3 source memories (minClusterSize=3) so the candidate isn't filtered
		const sourceIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const mem = store.createMemory({
				content: `Source fact ${i} about the same topic`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "operational",
			});
			sourceIds.push(mem.id);
		}

		const result = applySynthesis(
			store,
			[
				{
					pattern: "same topic",
					synthesizedContent: "Synthesized fact about same topic",
					sourceIds,
					target: "user",
					category: "preference",
					tier: "operational",
					confidence: 0.9,
				},
			],
			{ scope: "global", scopeId: null },
		);

		assert.equal(result.created.length, 1);
		const created = store.getMemory(result.created[0].synthesizedContent.length > 0 ? "" : "");
		// The created memory lives in store now. Fetch by scanning since we don't
		// return the id directly in `created` (it's a SynthesisCandidate). Check
		// that exactly one synthesis memory exists and its scope matches.
		const allSynth = store
			.listMemories({})
			.filter((m) => m.metadata?.sourceType === "synthesis");
		assert.equal(allSynth.length, 1, "exactly one synthesis memory should be created");
		assert.equal(allSynth[0].scope, "global");
		assert.equal(allSynth[0].scope_id ?? null, null);
	} finally {
		cleanup();
	}
});

test("applySynthesis with scope=project + scopeId=projectA tags the memory as project-scoped", () => {
	const { store, cleanup } = makeStore();
	try {
		const sourceIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const mem = store.createMemory({
				content: `Source fact ${i} about a project-specific pattern`,
				scope: "project",
				scope_id: "projectA",
				target: "project",
				category: "convention",
				tier: "operational",
			});
			sourceIds.push(mem.id);
		}

		applySynthesis(
			store,
			[
				{
					pattern: "project pattern",
					synthesizedContent: "Synthesized project convention",
					sourceIds,
					target: "project",
					category: "convention",
					tier: "operational",
					confidence: 0.8,
				},
			],
			{ scope: "project", scopeId: "projectA" },
		);

		const allSynth = store
			.listMemories({})
			.filter((m) => m.metadata?.sourceType === "synthesis");
		assert.equal(allSynth.length, 1);
		assert.equal(allSynth[0].scope, "project", "synthesis should be tagged as project");
		assert.equal(allSynth[0].scope_id, "projectA", "synthesis should carry the project id");
	} finally {
		cleanup();
	}
});

test("applySynthesis marks all source memories as consolidated", () => {
	const { store, cleanup } = makeStore();
	try {
		const sourceIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const mem = store.createMemory({
				content: `Source fact ${i} about cluster topic`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "operational",
			});
			sourceIds.push(mem.id);
		}

		applySynthesis(
			store,
			[
				{
					pattern: "cluster topic",
					synthesizedContent: "Cluster synthesis",
					sourceIds,
					target: "user",
					category: "preference",
					tier: "operational",
					confidence: 0.7,
				},
			],
			{ scope: "global", scopeId: null },
		);

		// All source memories should be marked consolidated
		for (const id of sourceIds) {
			const mem = store.getMemory(id);
			assert.ok(mem, `source ${id} should still exist`);
			const meta = mem!.metadata as any;
			assert.equal(meta?.consolidated, true, `source ${id} should be marked consolidated`);
			assert.ok(meta?.consolidatedInto, `source ${id} should have consolidatedInto pointer`);
		}
	} finally {
		cleanup();
	}
});

test("applySynthesis skips when fewer than 3 sources are available", () => {
	const { store, cleanup } = makeStore();
	try {
		const sourceIds: string[] = [];
		for (let i = 0; i < 2; i++) {
			// Only 2 sources — below minClusterSize=3
			const mem = store.createMemory({
				content: `Source fact ${i}`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "operational",
			});
			sourceIds.push(mem.id);
		}

		const result = applySynthesis(
			store,
			[
				{
					pattern: "small cluster",
					synthesizedContent: "Should not be created",
					sourceIds,
					target: "user",
					category: "preference",
					tier: "operational",
					confidence: 0.7,
				},
			],
			{ scope: "global", scopeId: null },
		);

		assert.equal(result.created.length, 0, "should not synthesize with < 3 sources");
		const allSynth = store
			.listMemories({})
			.filter((m) => m.metadata?.sourceType === "synthesis");
		assert.equal(allSynth.length, 0);
	} finally {
		cleanup();
	}
});

// ── Synthesis tier (regression for BUG #8) ──────────────────────────────
//
// Background: synthesize() used `tier = target === "user" ? "factual" :
// "operational"`, marking ALL non-user synthesis as operational (7d TTL).
// A project-scoped synthesis — the most common case — would expire in a
// week. The fix promotes "project" to factual (permanent) too. Memory
// and failure targets stay operational (their content is ephemeral).

test("synthesis tier: user target → factual (permanent)", () => {
	const cluster = [
		{ id: "1", content: "prefers dark mode", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "2", content: "prefers dark mode everywhere", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "3", content: "prefers dark mode at night", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
	] as any;
	const result = synthesize(cluster, "user", "preference");
	assert.ok(result, "should produce a synthesis candidate");
	assert.equal(result!.tier, "factual", "user target must be factual (permanent)");
});

test("synthesis tier: project target → factual (permanent, was operational)", () => {
	const cluster = [
		{ id: "1", content: "project uses PostgreSQL for primary storage", scope: "project", scope_id: "myapp", target: "project", category: "convention", status: "active", tier: "operational", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "2", content: "project uses PostgreSQL with JSONB columns", scope: "project", scope_id: "myapp", target: "project", category: "convention", status: "active", tier: "operational", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "3", content: "project uses PostgreSQL and Redis together", scope: "project", scope_id: "myapp", target: "project", category: "convention", status: "active", tier: "operational", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
	] as any;
	const result = synthesize(cluster, "project", "convention");
	assert.ok(result, "should produce a synthesis candidate");
	assert.equal(result!.tier, "factual", "project target must be factual (permanent), was operational before fix");
});

test("synthesis tier: failure target → operational (ephemeral is correct here)", () => {
	const cluster = [
		{ id: "1", content: "test fails with timeout error often", scope: "global", scope_id: undefined, target: "failure", category: "tool-quirk", status: "active", tier: "operational", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "2", content: "test fails with timeout in CI", scope: "global", scope_id: undefined, target: "failure", category: "tool-quirk", status: "active", tier: "operational", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "3", content: "test fails with timeout when network slow", scope: "global", scope_id: undefined, target: "failure", category: "tool-quirk", status: "active", tier: "operational", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
	] as any;
	const result = synthesize(cluster, "failure", "tool-quirk");
	assert.ok(result, "should produce a synthesis candidate");
	assert.equal(result!.tier, "operational", "failure target stays operational — short TTL is correct for failure patterns");
});

// ── Synthesis content length cap (regression for BUG #25) ───────────
//
// Background: synthesize() produced content by joining 20 facts × 200
// chars = ~4000 chars. The recall path's perMemoryTokens=300 * 4 chars =
// 1200 char cap truncated the synthesis's own headline + first fact
// when it was injected. R2 v3 reduces the cap to 400 chars and changes
// the format from a fact list to a principle, forcing abstraction
// (Memory-as-a-Tool insight: synthesize rules, not logs).

test("synthesizedContent is capped at 400 chars for large clusters", () => {
	// Build 20 cluster members with a SINGLE long sentence (>200 chars) so
	// the best-sentence pick produces a 200+ char fact, which the approach
	// picker truncates to 180, which combined with 2 examples (70 each)
	// pushes the total content past 400 chars. This forces the cap to
	// actually trigger — short, sentence-split content produces ~324 chars
	// under the new R2 v3 template and wouldn't exercise the truncation
	// path.
	const cluster: any[] = [];
	for (let i = 0; i < 20; i++) {
		cluster.push({
			id: String(i),
			content: `Postgres query optimization requires understanding the planner statistics and the auto-vacuum daemon behavior in the background and updates visibility map for index-only scans configuration parameter ${i} tunes buffer behavior for the workload to handle concurrent queries efficiently in production.`,
			scope: "global",
			scope_id: undefined,
			target: "project",
			category: "convention",
			status: "active",
			tier: "factual",
			created_at: 0,
			updated_at: 0,
			access_count: 0,
			confidence: "explicit",
			metadata: {},
		});
	}
	const result = synthesize(cluster, "project", "convention");
	assert.ok(result, "should produce a synthesis candidate");
	assert.ok(
		result!.synthesizedContent.length <= 400,
		`synthesized content must be <= 400 chars (R2 v3, was 1500) (got ${result!.synthesizedContent.length})`,
	);
	// The cap is "slice + ellipsis", so the last 3 chars are dots
	assert.equal(
		result!.synthesizedContent.slice(-3),
		"...",
		"truncated content should end with ellipsis",
	);
});

test("synthesizedContent under 400 chars is NOT padded or modified", () => {
	const cluster: any[] = [
		{ id: "1", content: "TypeScript catches type errors at compile time", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "2", content: "TypeScript prevents implicit any errors at compile time", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "3", content: "TypeScript strict mode enforces no implicit any at compile time", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
	];
	const result = synthesize(cluster, "user", "preference");
	assert.ok(result);
	assert.ok(
		!result!.synthesizedContent.endsWith("..."),
		"short content should not be truncated",
	);
});

// ── R2 v3: Abstraction Layer Tests ──
//
// Background: synthesize() previously concatenated all source facts
// ("Facts: A | B | C | D | E"). This is a log, not a principle. R2 v3
// picks the most distinctive fact as "Approach:" (the reusable
// principle) and optionally includes 1-2 short examples for richer
// clusters (N >= 5). The output now reads like a guideline, not a
// transcript.

test("R2: output uses 'Approach:' not 'Facts:' (principle, not log)", () => {
	const cluster: any[] = [
		{ id: "1", content: "User uses vim for all editing tasks in their workflow", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "2", content: "User uses vim with custom keybindings and modal editing", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "3", content: "User uses vim because of the speed and ergonomics it provides", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
	];
	const result = synthesize(cluster, "user", "preference");
	assert.ok(result);
	assert.ok(result!.synthesizedContent.includes("Approach:"), "must use 'Approach:' as the principle line");
	assert.ok(!result!.synthesizedContent.includes("Facts:"), "must NOT use old 'Facts:' format");
});

test("R2: approach is the most top-term-rich fact", () => {
	const cluster: any[] = [
		// Short fact with few top-terms
		{ id: "1", content: "User uses editors", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		// Long fact with MANY top-terms — this should win as the approach
		{ id: "2", content: "User uses vim with extensive keybindings, modal editing, vimscript config, and custom mappings for navigation", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "3", content: "Vim workflow is preferred", scope: "global", scope_id: undefined, target: "user", category: "preference", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
	];
	const result = synthesize(cluster, "user", "preference");
	assert.ok(result);
	// Approach should be the longest, most top-term-rich sentence
	assert.ok(
		result!.synthesizedContent.includes("extensive keybindings"),
		"approach should be the fact with most top-terms (mem 2's content)",
	);
});

test("R2: small clusters (N=3-4) do NOT include 'Examples:' line", () => {
	const cluster: any[] = [
		{ id: "1", content: "Postgres is the primary database for this project", scope: "global", scope_id: undefined, target: "project", category: "convention", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "2", content: "Postgres handles JSONB columns and full text search", scope: "global", scope_id: undefined, target: "project", category: "convention", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "3", content: "Postgres configuration is tuned for read-heavy workloads", scope: "global", scope_id: undefined, target: "project", category: "convention", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "4", content: "Postgres backup uses pg_dump nightly", scope: "global", scope_id: undefined, target: "project", category: "convention", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
	];
	const result = synthesize(cluster, "project", "convention");
	assert.ok(result);
	assert.ok(
		!result!.synthesizedContent.includes("Examples:"),
		"N=4 cluster should be principle-only (no Examples line)",
	);
});

test("R2: large clusters (N>=5) include 'Examples:' line with up to 2 short facts", () => {
	const cluster: any[] = [];
	for (let i = 0; i < 6; i++) {
		cluster.push({
			id: String(i),
			content: `Rust borrow checker enforces ownership and prevents data races in concurrent code iteration ${i}`,
			scope: "global",
			scope_id: undefined,
			target: "project",
			category: "convention",
			status: "active",
			tier: "factual",
			created_at: 0,
			updated_at: 0,
			access_count: 0,
			confidence: "explicit",
			metadata: {},
		});
	}
	const result = synthesize(cluster, "project", "convention");
	assert.ok(result);
	assert.ok(
		result!.synthesizedContent.includes("Examples:"),
		"N=6 cluster should include an Examples line for concreteness",
	);
	// Should be 2 examples, each capped at 70 chars
	const examplesMatch = result!.synthesizedContent.match(/Examples: (.+?)\.$/);
	assert.ok(examplesMatch, "should have an Examples: ... . line");
	const examples = examplesMatch![1].split(" | ");
	assert.ok(examples.length <= 2, `should have at most 2 examples (got ${examples.length})`);
});

test("R2: pattern line includes top terms from the cluster", () => {
	const cluster: any[] = [
		{ id: "1", content: "Docker compose handles local development and production builds", scope: "global", scope_id: undefined, target: "project", category: "convention", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "2", content: "Docker compose simplifies multi-container deployment with YAML", scope: "global", scope_id: undefined, target: "project", category: "convention", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
		{ id: "3", content: "Docker compose is preferred over running containers manually", scope: "global", scope_id: undefined, target: "project", category: "convention", status: "active", tier: "factual", created_at: 0, updated_at: 0, access_count: 0, confidence: "explicit", metadata: {} },
	];
	const result = synthesize(cluster, "project", "convention");
	assert.ok(result);
	assert.ok(result!.synthesizedContent.includes("Pattern: docker, compose"), "should list top terms in pattern");
});

test("R2: approach sentence is hard-capped at 180 chars to prevent one fact dominating", () => {
	const cluster: any[] = [];
	for (let i = 0; i < 3; i++) {
		cluster.push({
			id: String(i),
			content: `Vim is a great editor ${"with extensive configuration options and plugin support that makes it highly customizable for power users who want full control over their editing environment ".repeat(3)}`,
			scope: "global",
			scope_id: undefined,
			target: "user",
			category: "preference",
			status: "active",
			tier: "factual",
			created_at: 0,
			updated_at: 0,
			access_count: 0,
			confidence: "explicit",
			metadata: {},
		});
	}
	const result = synthesize(cluster, "user", "preference");
	assert.ok(result);
	const approachMatch = result!.synthesizedContent.match(/Approach: (.+?)\./);
	assert.ok(approachMatch, "should have Approach line");
	// The approach sentence itself should be <= 180 chars (or end with ... if truncated)
	const approach = approachMatch![1];
	assert.ok(
		approach.length <= 180 || approach.endsWith("..."),
		`approach sentence should be <= 180 chars (got ${approach.length})`,
	);
});

// ── Focus boost (regression for BUG #9) ────────────────────────────────
//
// Background: /dream parsed "focus on X" instructions but never applied
// them — the comment in runDream said "we don't have a ranking hook here".
// The fix passes focusTerms into findSynthesisCandidates which adds
// +0.15 confidence to matching candidates and re-sorts by confidence.
// This test seeds two distinct clusters, focuses on one, and asserts the
// focused cluster ends up first in the result list.

test("findSynthesisCandidates: focusTerms boost confidence and reorder results", async () => {
	const { store, cleanup } = makeStore();
	try {
		// Cluster A: rust borrow checker (will NOT match focus "vim")
		for (let i = 0; i < 3; i++) {
			store.createMemory({
				content: `Rust borrow checker is strict and prevents data races ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
			});
		}
		// Cluster B: vim navigation (WILL match focus "vim")
		for (let i = 0; i < 3; i++) {
			store.createMemory({
				content: `Vim modal editing improves navigation speed ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
			});
		}

		// Without focus: both clusters are present, order is by their
		// natural confidence (driven by cluster cohesion). We don't assert
		// a specific order here — the next assertion checks that focus
		// changes the ordering.
		const unfocused = await findSynthesisCandidates(store, { minClusterSize: 3 });
		assert.equal(unfocused.length, 2);
		const unfocusedVim = unfocused.find((c) => c.synthesizedContent.toLowerCase().includes("vim"));
		const unfocusedRust = unfocused.find((c) => c.synthesizedContent.toLowerCase().includes("rust"));
		assert.ok(unfocusedVim && unfocusedRust, "both clusters present without focus");

		// With focus on "vim": vim cluster should bubble to the top via
		// the +0.15 confidence boost, and re-sort.
		const focused = await findSynthesisCandidates(store, {
			minClusterSize: 3,
			focusTerms: ["vim"],
		});
		assert.equal(focused.length, 2);
		const focusedVim = focused.find((c) => c.synthesizedContent.toLowerCase().includes("vim"))!;
		const focusedRust = focused.find((c) => c.synthesizedContent.toLowerCase().includes("rust"))!;
		assert.ok(focusedVim, "vim cluster must be in focused results");
		assert.ok(focusedRust, "rust cluster must be in focused results");
		assert.ok(
			focusedVim.confidence > focusedRust.confidence,
			`vim should outrank rust (vim=${focusedVim.confidence.toFixed(2)}, rust=${focusedRust.confidence.toFixed(2)})`,
		);
		assert.equal(focused[0], focusedVim, "vim cluster should be first in the focused result");
	} finally {
		cleanup();
	}
});

test("findSynthesisCandidates: confidence boost is capped at 0.95", async () => {
	const { store, cleanup } = makeStore();
	try {
		for (let i = 0; i < 3; i++) {
			store.createMemory({
				content: `Vim modal editing tip ${i} for fast navigation`,
				scope: "global",
				target: "user",
				category: "preference",
			});
		}
		const focused = await findSynthesisCandidates(store, {
			minClusterSize: 3,
			focusTerms: ["vim"],
		});
		assert.equal(focused.length, 1);
		assert.ok(
			focused[0].confidence <= 0.95,
			`confidence must be capped at 0.95 (got ${focused[0].confidence})`,
		);
	} finally {
		cleanup();
	}
});

// ── F4: Dream delta mode ────────────────────────────────────────────
//
// Background: /dream used to re-cluster the entire corpus on every run.
// For 5k+ memories this takes 30-60s. Delta mode restricts the candidate
// pool to memories updated since the last dream, so a typical delta
// touches <100 memories and finishes in <2s. Manual /dream defaults to
// delta; `--full` overrides.

test("findSynthesisCandidates with since: only returns post-since memories", async () => {
	const { store, cleanup } = makeStore();
	try {
		// Seed 3 old memories (created/updated 10 days ago). Use
		// distinct vocabulary so they form a separate cluster from the
		// fresh memories — share 0 key terms.
		for (let i = 0; i < 3; i++) {
			store.createMemory({
				content: `Postgres vacuum analyze updates planner statistics for query optimization ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
			});
		}
		// Backdate them to 10 days ago via direct SQL (the public API
		// doesn't expose updated_at manipulation)
		const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
		(store as any).db
			.prepare("UPDATE memories SET updated_at = ?")
			.run(tenDaysAgo);

		// Now seed 3 fresh memories (this second) — these should be in delta
		for (let i = 0; i < 3; i++) {
			store.createMemory({
				content: `Wombat modal editing improves navigation speed significantly ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
			});
		}

		// Full mode: returns both clusters
		const full = await findSynthesisCandidates(store, { minClusterSize: 3 });
		assert.equal(full.length, 2, "full mode sees both clusters");

		// Delta mode with since=now-1d: only the fresh cluster qualifies
		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
		const delta = await findSynthesisCandidates(store, {
			minClusterSize: 3,
			since: oneDayAgo,
		});
		assert.equal(delta.length, 1, "delta mode filters to post-since memories only");
		// The remaining cluster must be the fresh one (vim)
		assert.ok(
			delta[0].synthesizedContent.toLowerCase().includes("wombat"),
			"delta must keep the fresh cluster, not the old one",
		);
	} finally {
		cleanup();
	}
});

// ── R4 v3: reclusterStaleSyntheses tests ────────────────────────────────
//
// Background: syntheses are static at creation. R4 re-runs synthesize()
// on the union of (synthesis's source memories) + (new siblings), and
// updates the synthesis in place if content changes. Gated by:
//   - minNewSiblings (default 2): need enough new siblings to bother
//   - minDaysSinceUpdate (default 1): don't thrash on every /dream
//   - content actually changed: no-op otherwise

test("R4: recluster updates stale synthesis when new siblings arrive", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create initial 3 sources and run synthesis
		const sourceIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const mem = store.createMemory({
				content: `Postgres query optimization requires understanding the planner statistics iteration ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
				tier: "factual",
			});
			sourceIds.push(mem.id);
		}
		applySynthesis(
			store,
			[
				{
					pattern: "postgres, query, optimization",
					synthesizedContent: "Initial synthesis about Postgres optimization",
					sourceIds,
					target: "project",
					category: "convention",
					tier: "factual",
					confidence: 0.7,
				},
			],
			{ scope: "global", scopeId: null },
		);
		const synthMem = store.listMemories().find((m) => m.metadata?.sourceType === "synthesis");
		assert.ok(synthMem, "synthesis should exist");

		// Add 2 new siblings
		for (let i = 0; i < 2; i++) {
			store.createMemory({
				content: `Postgres query optimization needs vacuum daemon for index maintenance iteration ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
				tier: "factual",
			});
		}

		const recluster = reclusterStaleSyntheses(store, { minDaysSinceUpdate: 0 });
		assert.equal(recluster.checked, 1);
		assert.equal(recluster.reclustered, 1, "should recluster with 2 new siblings");
		assert.equal(recluster.updated.length, 1);
		assert.notEqual(
			recluster.updated[0].newContent,
			recluster.updated[0].oldContent,
			"new content should differ from old",
		);
	} finally {
		cleanup();
	}
});

test("R4: skips when fewer than minNewSiblings arrived", () => {
	const { store, cleanup } = makeStore();
	try {
		const sourceIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const mem = store.createMemory({
				content: `Docker compose simplifies local development and deployment iteration ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
				tier: "factual",
			});
			sourceIds.push(mem.id);
		}
		applySynthesis(
			store,
			[
				{
					pattern: "docker, compose, deployment",
					synthesizedContent: "Initial synthesis about Docker compose",
					sourceIds,
					target: "project",
					category: "convention",
					tier: "factual",
					confidence: 0.7,
				},
			],
			{ scope: "global", scopeId: null },
		);

		// Add only 1 new sibling (below default minNewSiblings=2)
		store.createMemory({
			content: "Docker compose needs volume mounts for persistent data",
			scope: "global",
			target: "project",
			category: "convention",
			tier: "factual",
		});

		const recluster = reclusterStaleSyntheses(store, { minDaysSinceUpdate: 0 });
		assert.equal(recluster.checked, 1);
		assert.equal(recluster.reclustered, 0, "should not recluster with only 1 new sibling");
		assert.equal(recluster.skipped, 1);
	} finally {
		cleanup();
	}
});

test("R4: dry-run does not write", () => {
	const { store, cleanup } = makeStore();
	try {
		const sourceIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const mem = store.createMemory({
				content: `TypeScript catches type errors at compile time with strict mode iteration ${i}`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "factual",
			});
			sourceIds.push(mem.id);
		}
		applySynthesis(
			store,
			[
				{
					pattern: "typescript, type, errors",
					synthesizedContent: "Initial synthesis about TypeScript",
					sourceIds,
					target: "user",
					category: "preference",
					tier: "factual",
					confidence: 0.7,
				},
			],
			{ scope: "global", scopeId: null },
		);
		const synth = store.listMemories().find((m) => m.metadata?.sourceType === "synthesis");
		assert.ok(synth);
		const originalContent = synth.content;

		// Add 2 new siblings
		for (let i = 0; i < 2; i++) {
			store.createMemory({
				content: `TypeScript strict mode prevents implicit any at compile time iteration ${i}`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "factual",
			});
		}

		const recluster = reclusterStaleSyntheses(store, { minDaysSinceUpdate: 0, dryRun: true });
		assert.equal(recluster.reclustered, 1, "dry-run reports what would change");
		// Verify the actual memory was NOT updated
		const synthAfter = store.getMemory(synth.id);
		assert.equal(synthAfter!.content, originalContent, "dry-run must not modify the memory");
	} finally {
		cleanup();
	}
});

test("R4: returns 0 reclustered when syntheses have no new siblings", () => {
	const { store, cleanup } = makeStore();
	try {
		const sourceIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const mem = store.createMemory({
				content: `Vim keybindings for modal editing speed up navigation iteration ${i}`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "factual",
			});
			sourceIds.push(mem.id);
		}
		applySynthesis(
			store,
			[
				{
					pattern: "vim, keybindings, modal",
					synthesizedContent: "Initial synthesis about Vim",
					sourceIds,
					target: "user",
					category: "preference",
					tier: "factual",
					confidence: 0.7,
				},
			],
			{ scope: "global", scopeId: null },
		);

		// No new siblings
		const recluster = reclusterStaleSyntheses(store, { minDaysSinceUpdate: 0 });
		assert.equal(recluster.reclustered, 0, "no reclustering with no new siblings");
	} finally {
		cleanup();
	}
});

// ── Gap #1: backfill (force option) ───────────────────────────────────
//
// After deploying a new synthesis template (e.g., R2 v3 "Approach:"),
// existing syntheses still use the old format. force=true bypasses the
// minNewSiblings and minDaysSinceUpdate gates so a one-shot migration
// can upgrade them all. The content-changed gate still applies, so
// already-current syntheses are no-ops.

test("Gap #1: force re-synthesizes old-format memories to new format", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create 3 sources and apply synthesis with the OLD "Facts:" format
		const sourceIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const mem = store.createMemory({
				content: `Rust borrow checker enforces ownership and prevents data races iteration ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
				tier: "factual",
			});
			sourceIds.push(mem.id);
		}
		// Simulate OLD-format synthesis by writing content with "Facts:" prefix
		const oldContent =
			"[Synthesized 2026-06-22 from 3 memories] Pattern: rust, borrow, checker. Facts: A | B | C";
		applySynthesis(
			store,
			[
				{
					pattern: "rust, borrow, checker",
					synthesizedContent: oldContent,
					sourceIds,
					target: "project",
					category: "convention",
					tier: "factual",
					confidence: 0.7,
				},
			],
			{ scope: "global", scopeId: null },
		);
		const synth = store.listMemories().find((m) => m.metadata?.sourceType === "synthesis");
		assert.ok(synth);
		assert.ok(synth.content.includes("Facts:"), "precondition: old format contains Facts:");
		assert.ok(!synth.content.includes("Approach:"), "precondition: old format lacks Approach:");

		// Run force recluster
		const result = reclusterStaleSyntheses(store, { force: true });
		assert.equal(result.reclustered, 1, "force should re-synthesize the old-format memory");
		assert.notEqual(result.updated[0].newContent, result.updated[0].oldContent);

		// Verify the new format
		const synthAfter = store.getMemory(synth.id);
		assert.ok(synthAfter!.content.includes("Approach:"), "force should produce Approach: format");
		assert.ok(!synthAfter!.content.includes("Facts:"), "force should remove Facts: prefix");
	} finally {
		cleanup();
	}
});

// ── Gap #2: reason field auto-generated for syntheses ─────────────────

test("Gap #2: synthesis metadata includes reason field", () => {
	const { store, cleanup } = makeStore();
	try {
		const sourceIds: string[] = [];
		for (let i = 0; i < 5; i++) {
			const mem = store.createMemory({
				content: `LSP provides language server protocol for code intelligence iteration ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
				tier: "factual",
			});
			sourceIds.push(mem.id);
		}
		applySynthesis(
			store,
			[
				{
					pattern: "language, server, protocol",
					synthesizedContent: "placeholder",
					sourceIds,
					target: "project",
					category: "convention",
					tier: "factual",
					confidence: 0.85,
				},
			],
			{ scope: "global", scopeId: null },
		);
		const synth = store.listMemories().find((m) => m.metadata?.sourceType === "synthesis");
		assert.ok(synth);
		const reason = (synth.metadata as any)?.reason;
		assert.ok(reason, "synthesis should have a reason field");
		assert.ok(reason.includes("5 sibling"), "reason should mention source count");
		assert.ok(reason.includes("85%"), "reason should include confidence");
		assert.ok(reason.includes("language, server, protocol"), "reason should include top terms");
	} finally {
		cleanup();
	}
});

// ── Gap #1.1: --verbose + --force flags on /dream-upgrade ─────────────
//
// After the user's confusion ("1 already current, but display still
// shows old format"), we added per-synthesis details to the result and
// --verbose / --force flags to the command. --verbose shows which gate
// fired for each skip; --force bypasses the content-unchanged gate so
// re-templating always writes (useful when date header hasn't changed).

test("Gap #1.1: details array reports which gate fired for each skip", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create a synthesis with too few sources (below minClusterSize=3)
		// to trigger Gate 2 (sources-deleted). We create the synthesis
		// directly via createMemory so we can control the sourceIds count
		// (applySynthesis filters to ≥3).
		const m1 = store.createMemory({
			content: "Single source for synthesis test",
			scope: "global",
			target: "project",
			category: "convention",
			tier: "factual",
		});
		store.createMemory({
			content: "[Synthesized 2026-06-22 from 1 memory] Pattern: single. Approach: Single source.",
			scope: "global",
			target: "project",
			category: "convention",
			tier: "factual",
			metadata: {
				synthesizedFrom: [m1.id],
				pattern: "single",
				confidence: 0.7,
				synthesizedAt: Date.now(),
				source: "synthesis:1 memories",
				sourceType: "synthesis",
			},
			confidence: "synthesized",
		});

		const result = reclusterStaleSyntheses(store, { force: true });
		assert.equal(result.skipped, 1, "should skip due to insufficient sources");
		assert.equal(result.details.length, 1);
		assert.equal(result.details[0].action, "skipped");
		assert.equal(result.details[0].reason, "sources-deleted (<3)");
	} finally {
		cleanup();
	}
});

test("Gap #1.1: bypassContentCheck forces re-write when content is unchanged", async () => {
	const { store, cleanup } = makeStore();
	try {
		// Create 3 sources and a real synthesis via findSynthesisCandidates +
		// applySynthesis. The synthesis content is generated by synthesize(),
		// not the placeholder passed in tests that pre-date R2 v3.
		const sourceIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const m = store.createMemory({
				content: `Vitest provides fast unit testing for modern JavaScript and TypeScript iteration ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
				tier: "factual",
			});
			sourceIds.push(m.id);
		}
		const candidates = await findSynthesisCandidates(store, { minClusterSize: 3 });
		assert.equal(candidates.length, 1, "should have one synthesis candidate");
		applySynthesis(store, candidates, { scope: "global", scopeId: null });

		const synth = store.listMemories().find((m) => m.metadata?.sourceType === "synthesis");
		assert.ok(synth);

		// Run without bypassContentCheck: re-synthesize produces same content
		// (same cluster, same date, deterministic algorithm), so gate 4 fires.
		const result1 = reclusterStaleSyntheses(store, { force: true });
		assert.equal(result1.reclustered, 0, "default skips when content unchanged");
		assert.equal(result1.details[0].reason, "content-unchanged");

		// Now with bypassContentCheck: re-writes even though content is same
		const result2 = reclusterStaleSyntheses(store, { force: true, bypassContentCheck: true });
		assert.equal(result2.reclustered, 1, "bypassContentCheck forces write");
		assert.equal(result2.details[0].reason, "forced-write");
	} finally {
		cleanup();
	}
});

test("Gap #1: force is NOT idempotent (date header changes between runs)", () => {
	// The synthesize() function embeds today's date in the content header.
	// Running force twice on the same cluster produces different content
	// (different dates) — the content-changed gate never fires. This is
	// the correct behavior: backfill updates the date stamp, marking
	// the synthesis as "freshly templated" by the current template.
	const { store, cleanup } = makeStore();
	try {
		const sourceIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const mem = store.createMemory({
				content: `Go interfaces enable polymorphism and composition iteration ${i}`,
				scope: "global",
				target: "project",
				category: "convention",
				tier: "factual",
			});
			sourceIds.push(mem.id);
		}
		// First synthesis (R2 v3 template — generated by synthesize())
		const result1 = applySynthesis(
			store,
			[
				{
					pattern: "interfaces, polymorphism, composition",
					synthesizedContent: "placeholder — will be overridden by synthesize()",
					sourceIds,
					target: "project",
					category: "convention",
					tier: "factual",
					confidence: 0.7,
				},
			],
			{ scope: "global", scopeId: null },
		);
		assert.equal(result1.created.length, 1);
		const synth = store.listMemories().find((m) => m.metadata?.sourceType === "synthesis");
		assert.ok(synth);
		const firstContent = synth.content;

		// Force recluster (gate 4 will fire because date header updates)
		const result = reclusterStaleSyntheses(store, { force: true });
		assert.equal(result.reclustered, 1, "force should always re-synthesize (date header changes)");
		const synthAfter = store.getMemory(synth.id);
		assert.ok(synthAfter, "synthesis still exists");
		// The content WILL differ from before (date stamp updated). This is
		// expected and is what makes force useful for one-shot migrations:
		// running /dream-upgrade after deploying R2 v3 ensures every
		// synthesis is re-templated with the current date stamp.
	} finally {
		cleanup();
	}
});

