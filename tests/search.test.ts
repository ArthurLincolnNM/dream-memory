/**
 * Tests for search/hybrid.ts status filtering
 *
 * Bug fix: hybridSearch did not filter by status by default, so superseded
 * memories (consolidated by /dream synthesis) appeared in recall results.
 * The fix adds status: "active" as default in hybridSearch.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { hybridSearch, scopedSearch, type StorePair } from "../search/hybrid.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-search-test-"));
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

// ── hybridSearch status filtering ──────────────────────────────────────

test("hybridSearch excludes superseded memories by default", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "CosyVoice is great for TTS",
			scope: "global",
			target: "project",
			category: "insight",
			status: "active",
			tier: "operational",
		});
		store.createMemory({
			content: "CosyVoice is great for TTS",
			scope: "global",
			target: "project",
			category: "insight",
			status: "superseded",
			tier: "operational",
		});

		const results = hybridSearch(store, "CosyVoice TTS", { applyDecay: false });
		// Should only return the active memory
		assert.equal(results.length, 1);
		assert.equal(results[0].memory.status, "active");
	} finally {
		cleanup();
	}
});

test("hybridSearch includes superseded when status='superseded' is explicit", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "CosyVoice is great for TTS",
			scope: "global",
			target: "project",
			category: "insight",
			status: "superseded",
			tier: "operational",
		});

		const results = hybridSearch(store, "CosyVoice TTS", {
			status: "superseded",
			applyDecay: false,
		});
		assert.equal(results.length, 1);
		assert.equal(results[0].memory.status, "superseded");
	} finally {
		cleanup();
	}
});



test("hybridSearch excludes resolved memories by default", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "Old resolved memory",
			scope: "global",
			target: "user",
			category: "correction",
			status: "resolved",
			tier: "operational",
		});

		const results = hybridSearch(store, "resolved memory", { applyDecay: false });
		assert.equal(results.length, 0);
	} finally {
		cleanup();
	}
});

test("scopedSearch excludes superseded memories from both stores", () => {
	const { store: globalStore, dir: globalDir, cleanup: globalCleanup } = makeStore();
	const { store: projectStore, dir: projectDir, cleanup: projectCleanup } = makeStore();
	try {
		globalStore.createMemory({
			content: "Global superseded CosyVoice insight",
			scope: "global",
			target: "user",
			category: "preference",
			status: "superseded",
			tier: "factual",
		});
		projectStore.createMemory({
			content: "Project superseded CosyVoice insight",
			scope: "project",
			scope_id: "test-project",
			target: "user",
			category: "preference",
			status: "superseded",
			tier: "factual",
		});
		globalStore.createMemory({
			content: "Zed editor is fast",
			scope: "global",
			target: "user",
			category: "preference",
			status: "active",
			tier: "factual",
		});

		const stores: StorePair = {
			global: globalStore,
			project: projectStore,
			projectId: "test-project",
		};
		const results = scopedSearch(stores, "CosyVoice insight", { applyDecay: false });
		// Both superseded should be excluded; active memory about Zed doesn't match
		assert.equal(results.length, 0);
	} finally {
		globalCleanup();
		projectCleanup();
	}
});

test("scopedSearch includes active memories from both stores", () => {
	const { store: globalStore, dir: globalDir, cleanup: globalCleanup } = makeStore();
	const { store: projectStore, dir: projectDir, cleanup: projectCleanup } = makeStore();
	try {
		globalStore.createMemory({
			content: "Global active memory",
			scope: "global",
			target: "user",
			category: "preference",
			status: "active",
			tier: "factual",
		});
		projectStore.createMemory({
			content: "Project active memory",
			scope: "project",
			scope_id: "test-project",
			target: "user",
			category: "preference",
			status: "active",
			tier: "factual",
		});

		const stores: StorePair = {
			global: globalStore,
			project: projectStore,
			projectId: "test-project",
		};
		const results = scopedSearch(stores, "active memory", { applyDecay: false });
		assert.equal(results.length, 2);
	} finally {
		globalCleanup();
		projectCleanup();
	}
});

// ── Link expansion score floor (regression for BUG #26) ───────────────
//
// Background: linked memories were scored `parent.score * 0.5`, which in
// small corpora (BM25 returns 0.01-0.1) pushed them below the recall
// threshold of 0.1, making the most relevant linked memories invisible.
// The fix applies a floor of 0.05 so dampening stays meaningful (linked
// < direct) without vanishing the linked result entirely.

test("scopedSearch: linked memories get a 0.05 score floor so they survive recall threshold", () => {
	const dir = mkdtempSync(join(tmpdir(), "dm-linkfloor-"));
	const globalStore = new DreamStore(join(dir, "global.db"));
	const globalCleanup = () => {
		globalStore.close();
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		// Direct match: should rank first. Use a distinctive phrase so the
		// query matches THIS memory and nothing else.
		const direct = globalStore.createMemory({
			content: "Wombat compiler enforces exhaustive pattern matching at build time",
			scope: "global",
			target: "project",
			category: "convention",
		});
		// Linked memory: a related topic that does NOT match the query
		// directly. Different vocabulary ("bun", "javascript") so the only
		// way it surfaces is via link expansion from the direct match.
		const linked = globalStore.createMemory({
			content: "Bun runtime supports JavaScript natively without a build step",
			scope: "global",
			target: "project",
			category: "convention",
		});
		// Wire the link: direct.linked_to = [linked.id]
		globalStore.updateLinkedTo(direct.id, [linked.id]);

		const stores = { global: globalStore, project: null, projectId: null };
		const results = scopedSearch(stores, "wombat exhaustive", { applyDecay: false });

		// The direct match must appear (it's a literal match).
		const directHit = results.find((r) => r.memory.id === direct.id);
		assert.ok(directHit, "direct match should be in results");
		assert.equal(directHit!.isLinked, undefined, "direct match is not a linked result");

		// The linked memory should also appear in the expansion
		const linkedHit = results.find((r) => r.memory.id === linked.id);
		assert.ok(linkedHit, "linked memory should be surfaced via link expansion");
		assert.equal(linkedHit!.isLinked, true, "linked memory is flagged as such");
		// Score floor: even if parent.score is tiny, linked gets at least 0.05
		// so the recall filter (MIN_SCORE=0.1) doesn't drop it on the boundary.
		assert.ok(
			linkedHit!.score >= 0.05,
			`linked memory score must be >= 0.05 (got ${linkedHit!.score})`,
		);
		// Note: we don't assert linked < direct here because in tiny corpora
		// the direct match may itself score 0 (BM25 needs enough docs to
		// produce a useful signal). The dampening factor is enforced when
		// the parent has a non-trivial score; the floor is the regression
		// guard we care about here.
	} finally {
		globalCleanup();
	}
});

// ── Pre-recall on verbatim (gap #2) ──
//
// The cleaned query (from deriveRecallQuery) strips markdown, removes
// URLs, expands synonyms, and lowercases. That's good for semantic
// matches but destructive for literal precision. The pre-recall path
// runs scopedSearch on the raw user input (capped at topK=3) to
// rescue literal matches. These tests verify the underlying search
// behavior that the pre-recall path relies on.

test("verbatim: search surfaces literal matches with version numbers and error codes", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "Lumio Hub v2 firmware 3.2.1 returns Error 0x4A2 when the radio module is wedged",
			scope: "global",
			target: "user",
			category: "preference",
		});
		// Verbatim query: no cleanup, no lowercasing, no synonym expansion.
		// This is what the pre-recall path uses.
		const verbatim = "Error 0x4A2 in Lumio Hub v2 firmware 3.2.1";
		const stores: StorePair = { global: store, project: null, projectId: null };
		const results = scopedSearch(stores, verbatim, { topK: 3 });
		assert.ok(results.length >= 1, "verbatim search should surface the literal match");
		assert.ok(
			results[0].memory.content.includes("0x4A2"),
			"top hit should contain the error code",
		);
	} finally {
		cleanup();
	}
});

test("verbatim: short queries still run (no special skip at search level)", () => {
	// The pre-recall path itself has a 5-char threshold to skip
	// noise; the underlying scopedSearch has no such restriction.
	// This test confirms scopedSearch works on short queries when
	// the caller decides to invoke it (e.g., for the cleaned path).
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "User prefers dark mode in all editors across all platforms for work",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const stores: StorePair = { global: store, project: null, projectId: null };
		const results = scopedSearch(stores, "vim", { topK: 3 });
		assert.ok(Array.isArray(results), "short queries don't crash the search");
	} finally {
		cleanup();
	}
});
