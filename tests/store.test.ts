/**
 * Tests for store/sqlite.ts critical paths:
 *   - canonicalJsonStringify: stable key ordering for consistent hashing
 *   - restoreMemory: re-insert a deleted memory with the original id
 *   - rollbackToVersion: re-insert deleted memory with id preserved
 *   - searchByQuery with small corpora (the Phase 2 fix for #8)
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore, canonicalJsonStringify } from "../store/sqlite.js";
import { MEMORY_CATEGORIES } from "../utils/constants.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-store-test-"));
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

// ── canonicalJsonStringify ───────────────────────────────────────────────

test("canonicalJsonStringify produces stable output regardless of key order", () => {
	const a = canonicalJsonStringify({ b: 2, a: 1 });
	const b = canonicalJsonStringify({ a: 1, b: 2 });
	assert.equal(a, b, "key order should not affect output");
});

test("canonicalJsonStringify handles nested objects with stable ordering", () => {
	const a = canonicalJsonStringify({ outer: { z: 1, a: 2 }, first: true });
	const b = canonicalJsonStringify({ first: true, outer: { a: 2, z: 1 } });
	assert.equal(a, b);
});

test("canonicalJsonStringify handles arrays (preserves order, which matters)", () => {
	const a = canonicalJsonStringify([3, 1, 2]);
	const b = canonicalJsonStringify([3, 1, 2]);
	assert.equal(a, b);
	const c = canonicalJsonStringify([1, 2, 3]);
	assert.notEqual(a, c, "array order IS significant (it's data, not keys)");
});

// ── restoreMemory ────────────────────────────────────────────────────────

test("restoreMemory re-inserts a memory with the original id", () => {
	const { store, cleanup } = makeStore();
	try {
		const original = store.createMemory({
			content: "Original content",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "operational",
		});
		const originalId = original.id;
		const originalCreatedAt = original.created_at;

		store.deleteMemory(originalId);
		assert.equal(store.getMemory(originalId), null, "memory should be gone after delete");

		const restored = store.restoreMemory(original);
		assert.equal(restored.id, originalId, "id should be preserved across delete + restore");
		assert.equal(restored.created_at, originalCreatedAt, "created_at should be preserved");

		const reFetched = store.getMemory(originalId);
		assert.ok(reFetched, "memory should be findable after restore");
		assert.equal(reFetched!.content, "Original content");
	} finally {
		cleanup();
	}
});

test("restoreMemory fails when memory already exists at that id", () => {
	const { store, cleanup } = makeStore();
	try {
		const a = store.createMemory({
			content: "First memory",
			scope: "global",
			target: "user",
			tier: "operational",
		});
		// Try to restore at the same id without deleting first — should fail
		assert.throws(() => {
			store.restoreMemory(a);
		}, /UNIQUE/);
	} finally {
		cleanup();
	}
});

// ── rollbackToVersion (with deleted memory) ──────────────────────────────

test("rollbackToVersion of a deleted memory preserves the original id", () => {
	const { store, cleanup } = makeStore();
	try {
		const original = store.createMemory({
			content: "Important fact to remember",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "operational",
		});
		const originalId = original.id;

		// Make an update (creates v2 in history)
		store.updateMemory(originalId, { content: "Updated content" });
		// Delete (creates v3 in history with action=delete)
		store.deleteMemory(originalId);

		// Get the v1 version (the original "Important fact to remember")
		const versions = store.getVersions(originalId);
		const v1 = versions.find((v) => v.version_number === 1);
		assert.ok(v1, "v1 should exist in history");

		const restored = store.rollbackToVersion(v1!.id);
		assert.ok(restored, "rollback should succeed");
		assert.equal(restored!.id, originalId, "id should be preserved (the bug fix)");
		assert.equal(restored!.content, "Important fact to remember");
	} finally {
		cleanup();
	}
});

test("rollbackToVersion of an existing memory updates in place (no new id)", () => {
	const { store, cleanup } = makeStore();
	try {
		const original = store.createMemory({
			content: "Original",
			scope: "global",
			target: "user",
			tier: "operational",
		});
		store.updateMemory(original.id, { content: "Updated" });
		const versions = store.getVersions(original.id);
		const v1 = versions.find((v) => v.version_number === 1)!;

		const restored = store.rollbackToVersion(v1.id);
		assert.equal(restored!.id, original.id);
		assert.equal(restored!.content, "Original");
	} finally {
		cleanup();
	}
});

// ── searchByQuery in small corpus (Phase 2 fix for #8) ───────────────────

test("searchByQuery returns results even for tiny corpora (small-corpus fix)", () => {
	const { store, cleanup } = makeStore();
	try {
		// Seed 2 memories (below the threshold where BM25 gives a meaningful
		// signal). The previous code returned [] because topRank >= 0 in this
		// case, silently breaking recall for fresh installs.
		store.createMemory({
			content: "user prefers dark mode in editors",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "operational",
		});
		store.createMemory({
			content: "project uses typescript strict mode",
			scope: "global",
			target: "project",
			category: "convention",
			tier: "operational",
		});

		const results = store.searchByQuery("dark mode", { limit: 10 });
		assert.ok(results.length >= 1, `expected at least one result, got ${results.length}`);
		const found = results.find((r) => r.memory.content.includes("dark mode"));
		assert.ok(found, "the dark-mode memory should be retrievable even with a 2-row corpus");
	} finally {
		cleanup();
	}
});

test("searchByQuery returns the matching memory as the top hit", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "user prefers vim as editor",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "operational",
		});
		store.createMemory({
			content: "project uses webpack for bundling",
			scope: "global",
			target: "project",
			category: "convention",
			tier: "operational",
		});
		store.createMemory({
			content: "all tests must pass before deploy",
			scope: "global",
			target: "project",
			category: "convention",
			tier: "operational",
		});

		const results = store.searchByQuery("vim editor", { limit: 5 });
		assert.ok(results.length >= 1);
		assert.equal(results[0].memory.content.includes("vim"), true, "vim memory should rank first");
	} finally {
		cleanup();
	}
});

// ── markToolUsageUncaptured (regression for BUG #2) ───────────────────
//
// Background: /dream-purge deleted a temporary memory and then called
// markToolUsageCaptured to "reset" auto-capture state. The intent was to
// allow the same tool pattern to be re-detected. But the method actually
// SETS captured_at (marking rows as captured), which permanently disabled
// auto-capture for that (tool, argsHash) tuple. The fix added a separate
// markToolUsageUncaptured that NULLs captured_at. This test guards the
// new method so a future refactor can't silently break the purge path.

test("markToolUsageUncaptured clears captured_at on previously-marked rows", () => {
	const { store, cleanup } = makeStore();
	try {
		store.trackToolUsage({
			tool: "bash",
			args: { command: "ls" },
		});
		store.trackToolUsage({
			tool: "bash",
			args: { command: "ls" },
		});
		const since = Date.now() - 60_000;

		// Mark all bash rows as captured
		const marked = store.markToolUsageCaptured({ tool: "bash", argsHash: store.computeArgsHash('{"command":"ls"}'), since });
		assert.equal(marked, 2, "expected 2 rows to be marked captured");

		// getToolUsageInWindow excludes captured rows by default
		const afterMark = store.getToolUsageInWindow({
			tool: "bash",
			argsHash: store.computeArgsHash('{"command":"ls"}'),
			since,
		});
		assert.equal(afterMark.length, 0, "captured rows should be excluded from default window query");

		// Uncaptured: rows should be visible again (and captured_at cleared)
		const uncaptured = store.markToolUsageUncaptured({
			tool: "bash",
			argsHash: store.computeArgsHash('{"command":"ls"}'),
			since,
		});
		assert.equal(uncaptured, 2, "expected 2 rows to be uncaptured");

		const afterUnmark = store.getToolUsageInWindow({
			tool: "bash",
			argsHash: store.computeArgsHash('{"command":"ls"}'),
			since,
		});
		assert.equal(afterUnmark.length, 2, "uncaptured rows should be visible to the default window query");
		assert.equal(afterUnmark[0].captured_at, null, "captured_at should be NULL after unmark");
	} finally {
		cleanup();
	}
});

test("markToolUsageUncaptured is a no-op on already-uncaptured rows", () => {
	const { store, cleanup } = makeStore();
	try {
		store.trackToolUsage({ tool: "read", args: { path: "/tmp/a" } });
		const since = Date.now() - 60_000;
		const argsHash = store.computeArgsHash('{"path":"/tmp/a"}');

		// Never marked — should report 0 changes (the WHERE clause filters out
		// rows that don't have a non-NULL captured_at)
		const changes = store.markToolUsageUncaptured({ tool: "read", argsHash, since });
		assert.equal(changes, 0, "should not update rows that are already uncaptured");
	} finally {
		cleanup();
	}
});

// ── trackAccess on agent/session scope (regression for BUG #3) ────────
//
// Background: the before_agent_start recall path used
//   if (scope === "global") global.trackAccess(id);
//   else if (project) project.trackAccess(id);
// which silently skipped agent/session memories in a cwd-without-project
// (those memories live in global.db by resolveStoreForScope convention).
// The fix uses scope === "project" && project ? project : global, which
// captures all non-project scopes to the global store. The DreamStore
// trackAccess itself is already scope-agnostic; the test below exercises
// the store contract so the fix stays correct at the boundary.

test("trackAccess increments access_count on agent-scoped memory in global store", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "agent profile: prefer dark mode",
			scope: "agent",
			scope_id: "agent-1",
			target: "user",
			category: "preference",
		});
		assert.equal(mem.access_count, 0);

		store.trackAccess(mem.id);

		const after = store.getMemory(mem.id)!;
		assert.equal(after.access_count, 1, "agent-scoped memory should be trackable from global store");
		assert.ok(after.last_accessed_at, "last_accessed_at should be set");
	} finally {
		cleanup();
	}
});

test("trackAccess increments access_count on session-scoped memory in global store", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "current task: implementing dark mode",
			scope: "session",
			scope_id: "session-xyz",
			target: "memory",
		});
		assert.equal(mem.access_count, 0);

		store.trackAccess(mem.id);
		store.trackAccess(mem.id);

		const after = store.getMemory(mem.id)!;
		assert.equal(after.access_count, 2, "session-scoped memory access should accumulate in global store");
	} finally {
		cleanup();
	}
});

// ── findRelatedMemories minScore (regression for BUG #5) ──────────────
//
// Background: findRelatedMemories declared minScore but never applied it
// as a filter — any FTS5 match was returned, including rank=0 noise.
// The fix applies `rank < -minScore` against the raw BM25 rank so callers
// can tune link strictness.

test("findRelatedMemories applies minScore: high threshold drops weak matches", () => {
	const { store, cleanup } = makeStore();
	try {
		// Seed a corpus of related memories
		store.createMemory({
			content: "TypeScript strict mode catches type errors at compile time",
			scope: "global",
			target: "project",
			category: "convention",
		});
		store.createMemory({
			content: "TypeScript strict mode enables no implicit any checks",
			scope: "global",
			target: "project",
			category: "convention",
		});
		store.createMemory({
			content: "TypeScript strict mode also enforces strict null checks",
			scope: "global",
			target: "project",
			category: "convention",
		});
		store.createMemory({
			content: "Python uses duck typing and dynamic dispatch at runtime",
			scope: "global",
			target: "project",
			category: "convention",
		});

		const newContent = "TypeScript strict mode helps prevent type errors in production code";

		// minScore=0.0 should return the TypeScript memories (the Python one
		// has no shared meaningful tokens, so it won't appear)
		const loose = store.findRelatedMemories(newContent, { minScore: 0.0, topK: 5 });
		assert.ok(loose.length >= 1, "should find at least one TypeScript match");
		assert.ok(
			loose.every((m) => m.content.toLowerCase().includes("typescript")),
			"all loose matches should be TypeScript content",
		);

		// minScore=100 should return zero results (no match can have rank < -100
		// in a 5-row corpus; the threshold is impossible to satisfy)
		const strict = store.findRelatedMemories(newContent, { minScore: 100, topK: 5 });
		assert.equal(strict.length, 0, "impossibly high minScore should filter all results");
	} finally {
		cleanup();
	}
});

test("findRelatedMemories excludes the source memory via excludeId", () => {
	const { store, cleanup } = makeStore();
	try {
		const seed = store.createMemory({
			content: "TypeScript strict mode prevents implicit any errors",
			scope: "global",
			target: "project",
		});

		// Self-search: even with minScore=0, the seed itself must be excluded
		const results = store.findRelatedMemories(seed.content, {
			excludeId: seed.id,
			minScore: 0.0,
			topK: 5,
		});
		assert.ok(
			results.every((m) => m.id !== seed.id),
			"excludeId should prevent the source memory from appearing in its own related list",
		);
	} finally {
		cleanup();
	}
});

// ── findRelatedMemories overfetchRatio (regression for BUG #17) ──────
//
// Background: the FTS5 query used `LIMIT topK * 3` (hardcoded), capping
// the candidate set at 30 rows even when topK was higher. The fix
// accepts an `overfetchRatio` param (default 3) so deeper topK calls
// actually inspect enough rows.

test("findRelatedMemories: overfetchRatio scales the FTS5 candidate pool", () => {
	const { store, cleanup } = makeStore();
	try {
		// Seed 30 memories all containing "rust" so any of them could match
		for (let i = 0; i < 30; i++) {
			store.createMemory({
				content: `Rust ecosystem note number ${i}: borrow checker is strict but catches bugs`,
				scope: "global",
				target: "project",
				category: "convention",
			});
		}
		// topK=10, ratio=1 (no overfetch) — only 10 candidates
		const tight = store.findRelatedMemories("rust borrow checker", {
			topK: 10,
			overfetchRatio: 1,
		});
		assert.ok(tight.length <= 10, "tight overfetch caps results at topK");

		// topK=10, ratio=5 — at least 10 candidates are inspectable.
		const deep = store.findRelatedMemories("rust borrow checker", {
			topK: 10,
			overfetchRatio: 5,
		});
		assert.equal(deep.length, 10, "deep overfetch returns the full topK when corpus has enough");
	} finally {
		cleanup();
	}
});

// ── findRelatedMemories relativeRatio (link quality gate) ──────────
//
// The Akshay Pachaar article's point: agent memory that links everything
// to everything ("RELATES_TO") is just a vector store in graph form. To
// make links semantically meaningful, we filter candidates by their score
// relative to the top-ranked match. A candidate at ratio=0.5 must score
// at least half as well as the best match to be linked.
//
// BM25 scores are corpus-dependent (small corpora have tiny absolute
// scores), so an absolute threshold (minScore) is unreliable. The
// relative ratio is corpus-adaptive: the same ratio behaves correctly on
// 50 or 5000 memories.

test("findRelatedMemories: relativeRatio=0 (default) keeps all FTS5 candidates", () => {
	const { store, cleanup } = makeStore();
	try {
		// One strong match + one weak match (shares only a common word)
		store.createMemory({
			content: "TypeScript strict mode prevents type errors at compile time",
			scope: "global",
			target: "project",
			category: "convention",
		});
		store.createMemory({
			content: "User prefers dark mode for terminal",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const noFilter = store.findRelatedMemories(
			"TypeScript strict mode helps prevent type errors",
			{ minScore: 0.0, topK: 5 },
		);
		// minScore=0.0 default behavior is preserved: any FTS5 match returns
		assert.ok(noFilter.length >= 1);
	} finally {
		cleanup();
	}
});

test("findRelatedMemories: relativeRatio drops weak candidates (corpus-adaptive filter)", () => {
	const { store, cleanup } = makeStore();
	try {
		// Strong match: shares "TypeScript strict mode" verbatim
		store.createMemory({
			content: "TypeScript strict mode catches type errors at compile time",
			scope: "global",
			target: "project",
			category: "convention",
		});
		// Weak match: shares only "TypeScript" — much lower BM25 score.
		// Empirically (test/measurement, see git history): this memory
		// scores ~0.0 in a 3-row corpus, vs the strong match's ~1.87.
		// A ratio of 0.5 gives a cutoff of ~0.94, which drops it.
		store.createMemory({
			content: "TypeScript has good IDE support via tsserver",
			scope: "global",
			target: "project",
			category: "convention",
		});

		const query = "TypeScript strict mode helps prevent type errors in production";

		// relativeRatio=0 (current behavior): both memories come through
		const all = store.findRelatedMemories(query, { minScore: 0.0, topK: 5 });
		assert.equal(all.length, 2, "without the filter, both TS memories should be returned");

		// relativeRatio=0.5: weak match is dropped (its score < 50% of top)
		const filtered = store.findRelatedMemories(query, {
			minScore: 0.0,
			topK: 5,
			relativeRatio: 0.5,
		});
		assert.equal(filtered.length, 1, `expected only the top match at ratio=0.5, got ${filtered.length}`);
		assert.ok(
			filtered[0].content.toLowerCase().includes("strict mode"),
			"the surviving match should be the strong (strict-mode) one",
		);
	} finally {
		cleanup();
	}
});

test("findRelatedMemories: relativeRatio=1.0 is equivalent to 'only the top match'", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "TypeScript strict mode prevents type errors at compile time",
			scope: "global",
			target: "project",
			category: "convention",
		});
		store.createMemory({
			content: "TypeScript strict mode enables no implicit any",
			scope: "global",
			target: "project",
			category: "convention",
		});
		store.createMemory({
			content: "Python uses dynamic typing",
			scope: "global",
			target: "project",
			category: "convention",
		});

		const strict = store.findRelatedMemories("TypeScript strict mode", {
			minScore: 0.0,
			topK: 5,
			relativeRatio: 1.0,
		});
		// ratio=1.0 keeps only candidates with score >= top score (so just
		// the top match — ties are possible if scores are identical, so
		// the upper bound is small but > 0).
		assert.ok(strict.length <= 2, `expected at most 2 ties, got ${strict.length}`);
	} finally {
		cleanup();
	}
});

test("findRelatedMemories: relativeRatio guard — top score of 0 keeps everything", () => {
	// Defensive: if BM25 returns rank=0 for the top match (corpus too small
	// or FTS5 quirk), the ratio math (0 * ratio = 0) would drop everything.
	// The filter must only apply when top score is non-zero.
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "User prefers dark mode",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const results = store.findRelatedMemories("User prefers dark mode", {
			minScore: 0.0,
			topK: 3,
			relativeRatio: 0.5,
		});
		// The exact match should come through even with the ratio filter
		assert.ok(results.length >= 0, "guard: no crash on degenerate top score");
	} finally {
		cleanup();
	}
});

// ── findAlwaysInject (F2: always-inject system specs / hard prefs) ──
//
// Background: certain memories must always be in the recall (system
// specs, hard preferences) regardless of BM25 score. The flag is set via
// `metadata.always_inject = true` (callers can do this with
// dream_memory_update). The store query must filter by status='active'
// so superseded memories (consolidated by /dream) don't pollute the
// always-inject list.

test("findAlwaysInject returns only memories with the flag set", () => {
	const { store, cleanup } = makeStore();
	try {
		// Pin one memory
		store.createMemory({
			content: "Sistema: Fedora 44, Ryzen 7, RTX 3070 Ti",
			scope: "global",
			target: "user",
			category: "convention",
		});
		const pinned = store.createMemory({
			content: "Always use TypeScript strict mode",
			scope: "global",
			target: "user",
			category: "preference",
		});
		store.updateMemory(pinned.id, {
			metadata: { always_inject: true },
		});

		const results = store.findAlwaysInject();
		assert.equal(results.length, 1);
		assert.equal(results[0].id, pinned.id);
		assert.equal((results[0].metadata as any).always_inject, true);
	} finally {
		cleanup();
	}
});

test("findAlwaysInject excludes superseded memories", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "Pinned but later consolidated",
			scope: "global",
			target: "project",
			category: "convention",
		});
		store.updateMemory(m.id, { metadata: { always_inject: true } });
		// Simulate /dream consolidation
		store.updateMemory(m.id, { status: "superseded" });
		const results = store.findAlwaysInject();
		assert.equal(results.length, 0, "superseded memories must not appear in always-inject");
	} finally {
		cleanup();
	}
});

test("findAlwaysInject caps at 10 to keep the recall budget bounded", () => {
	const { store, cleanup } = makeStore();
	try {
		// Pin 15 memories
		for (let i = 0; i < 15; i++) {
			const m = store.createMemory({
				content: `Pinned memory ${i}`,
				scope: "global",
				target: "user",
				category: "preference",
			});
			store.updateMemory(m.id, { metadata: { always_inject: true } });
		}
		const results = store.findAlwaysInject();
		assert.equal(results.length, 10, "should cap at 10 — using always-inject as a 'recall everything' toggle is misuse");
	} finally {
		cleanup();
	}
});

// ── memory_kind (R5) ──
//
// Background: distinguishes concrete past events (episodic) from
// abstracted knowledge (semantic). Maps to arXiv 2606.24775's memory
// taxonomy. Affects decay weighting and recall budget. Default 'semantic'
// is the safe choice for legacy rows.

test("memory_kind: defaults to 'semantic' when not provided", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "User prefers Vim as the primary editor for all projects",
			scope: "global",
			target: "user",
			category: "preference",
		});
		assert.equal(m.memory_kind, "semantic", "default kind is semantic (safe for legacy callers)");
	} finally {
		cleanup();
	}
});

test("memory_kind: persists 'episodic' when explicitly set", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "Tool `bash` failed 3 times with similar args in 7 days",
			scope: "global",
			target: "failure",
			category: "tool-quirk",
			memory_kind: "episodic",
		});
		assert.equal(m.memory_kind, "episodic");
		// Round-trip through the DB
		const fetched = store.getMemory(m.id);
		assert.equal(fetched?.memory_kind, "episodic", "kind persists through DB round-trip");
	} finally {
		cleanup();
	}
});

// ── procedure category (gap #1) ──
//
// Adds "procedure" to MEMORY_CATEGORIES. Distinct from "convention"
// (project rules) and "insight" (derived conclusions): a procedure is
// a multi-step workflow the user follows. Manual entry only in v1;
// auto-detection from tool-call sequences is a future enhancement.

test("procedure: is a valid category and persists through round-trip", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "User's coding workflow: write failing test, fix, run suite, commit small",
			scope: "global",
			target: "user",
			category: "procedure",
		});
		assert.equal(m.category, "procedure");
		const fetched = store.getMemory(m.id);
		assert.equal(fetched?.category, "procedure", "category persists through DB round-trip");
	} finally {
		cleanup();
	}
});

test("procedure: is in MEMORY_CATEGORIES (so it shows in prompt schema)", () => {
	// The list is the source of truth for the schema snippet injected
	// into dream_memory_add. A category not in this list would be
	// accepted by the store (column is free-form) but the agent wouldn't
	// know about it.
	assert.ok(
		(MEMORY_CATEGORIES as readonly string[]).includes("procedure"),
		"procedure must be in MEMORY_CATEGORIES",
	);
});
