/**
 * Tests for Feature 1 (Decay) and Feature 2 (Confidence)
 *
 * Feature 1: Decay funcional — BM25 scores are multiplied by a temporal
 * decay factor. Newer and frequently-accessed memories rank higher.
 *
 * Feature 2: Confidence tagging — memories carry provenance metadata
 * (explicit, inferred, synthesized, outdated) persisted in the schema.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { calculateDecay } from "../ttl/decay.js";
import { calculateDecay, applyDecayToResults } from "../ttl/decay.js";
import { hybridSearch, scopedSearch } from "../search/hybrid.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-decay-test-"));
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

// ── Feature 1: Decay ──────────────────────────────────────────────────────

test("calculateDecay returns high value for fresh memory", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "test memory",
			scope: "global",
			target: "user",
			tier: "factual",
		});
		const decay = calculateDecay(mem);
		// Fresh memory: decay factor ≈ 1.0 (no days passed), capped at 0.95
		assert.ok(decay > 0.8, `Expected decay > 0.8 for fresh memory, got ${decay}`);
		assert.ok(decay <= 0.95, `Expected decay <= 0.95 (MAX_DECAY), got ${decay}`);
	} finally {
		cleanup();
	}
});

test("calculateDecay returns lower value for old memory", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "old memory",
			scope: "global",
			target: "user",
			tier: "operational",
		});
		// Simulate age: set created_at to 30 days ago
		store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
			Date.now() - 30 * 86400000,
			mem.id,
		);
		const refreshed = store.getMemory(mem.id)!;
		const decay = calculateDecay(refreshed);
		// 30 days old, no access: 0.95^30 ≈ 0.214
		assert.ok(decay < 0.5, `Expected decay < 0.5 for 30-day-old memory, got ${decay}`);
	} finally {
		cleanup();
	}
});

test("calculateDecay boosts frequently accessed memories", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "frequently accessed",
			scope: "global",
			target: "user",
			tier: "factual",
		});
		// Simulate 10 accesses
		for (let i = 0; i < 10; i++) {
			store.trackAccess(mem.id);
		}
		// Make the boosted memory old (30 days) so the decay factor drops,
		// allowing the access boost to make a visible difference.
		store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
			Date.now() - 30 * 86400000,
			mem.id,
		);
		const boosted = store.getMemory(mem.id)!;
		const decayBoosted = calculateDecay(boosted);

		const mem2 = store.createMemory({
			content: "never accessed",
			scope: "global",
			target: "user",
			tier: "factual",
		});
		// Also make the unaccessed one old (same age) for fair comparison
		store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
			Date.now() - 30 * 86400000,
			mem2.id,
		);
		const unaccessed = store.getMemory(mem2.id)!;
		const decayUnaccessed = calculateDecay(unaccessed);

		assert.ok(
			decayBoosted > decayUnaccessed,
			`Boosted memory (${decayBoosted.toFixed(3)}) should score higher than unaccessed (${decayUnaccessed.toFixed(3)})`,
		);
	} finally {
		cleanup();
	}
});

test("applyDecayToResults re-ranks results by decay", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create two memories with same content (same BM25 score)
		const old = store.createMemory({
			content: "preference: usa vim",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "factual",
		});
		// Make old memory 60 days old
		store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
			Date.now() - 60 * 86400000,
			old.id,
		);

		const fresh = store.createMemory({
			content: "preference: usa vim",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "factual",
		});

		// Both have same BM25 score; applyDecayToResults should rank fresh first
		const results = [
			{ memory: store.getMemory(old.id)!, score: 5.0, snippet: "old" },
			{ memory: store.getMemory(fresh.id)!, score: 5.0, snippet: "fresh" },
		];
		const decayed = applyDecayToResults(results);
		assert.equal(
			decayed[0].memory.id,
			fresh.id,
			"Fresh memory should rank first after decay",
		);
	} finally {
		cleanup();
	}
});

test("hybridSearch applies decay by default", () => {
	const { store, cleanup } = makeStore();
	try {
		const old = store.createMemory({
			content: "user prefere portugues",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "operational",
		});
		store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(
			Date.now() - 90 * 86400000,
			old.id,
		);

		const fresh = store.createMemory({
			content: "user prefere portugues",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "operational",
		});

		// Search with decay (default)
		const withDecay = hybridSearch(store, "user prefere portugues", { limit: 10 });
		// Search without decay
		const noDecay = hybridSearch(store, "user prefere portugues", { limit: 10, applyDecay: false });

		// With decay, fresh should be first
		assert.equal(withDecay[0].memory.id, fresh.id, "Fresh memory ranks first with decay");
		// Without decay, order depends on BM25 (could be either, but scores should be equal)
		assert.equal(noDecay.length, 2, "Both memories returned without decay");
	} finally {
		cleanup();
	}
});

// ── Feature 2: Confidence ─────────────────────────────────────────────────

test("createMemory defaults confidence to 'explicit'", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "test",
			scope: "global",
			target: "user",
			tier: "factual",
		});
		assert.equal(mem.confidence, "explicit", "Default confidence should be 'explicit'");
	} finally {
		cleanup();
	}
});

test("createMemory accepts explicit confidence value", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "auto-captured pattern",
			scope: "global",
			target: "project",
			tier: "operational",
			confidence: "inferred",
		});
		assert.equal(mem.confidence, "inferred");
	} finally {
		cleanup();
	}
});

test("confidence persists through getMemory", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "synthesized insight",
			scope: "global",
			target: "user",
			tier: "factual",
			confidence: "synthesized",
		});
		const fetched = store.getMemory(mem.id);
		assert.ok(fetched, "Memory should be retrievable");
		assert.equal(fetched!.confidence, "synthesized");
	} finally {
		cleanup();
	}
});

test("updateMemory can change confidence", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "test",
			scope: "global",
			target: "user",
			tier: "factual",
			confidence: "explicit",
		});
		const updated = store.updateMemory(mem.id, { confidence: "outdated" });
		assert.ok(updated, "updateMemory should return the updated memory");
		assert.equal(updated!.confidence, "outdated");

		// Verify persistence
		const fetched = store.getMemory(mem.id);
		assert.equal(fetched!.confidence, "outdated");
	} finally {
		cleanup();
	}
});

test("confidence is included in listMemories results", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "explicit memory",
			scope: "global",
			target: "user",
			tier: "factual",
			confidence: "explicit",
		});
		store.createMemory({
			content: "inferred memory",
			scope: "global",
			target: "user",
			tier: "operational",
			confidence: "inferred",
		});

		const all = store.listMemories({ scope: "global" });
		const explicit = all.find((m) => m.content === "explicit memory");
		const inferred = all.find((m) => m.content === "inferred memory");

		assert.ok(explicit, "Explicit memory found");
		assert.ok(inferred, "Inferred memory found");
		assert.equal(explicit!.confidence, "explicit");
		assert.equal(inferred!.confidence, "inferred");
	} finally {
		cleanup();
	}
});

test("confidence survives moveMemoryOut", () => {
	const { store, cleanup } = makeStore();
	const dir2 = mkdtempSync(join(tmpdir(), "dm-decay-move-"));
	const store2 = new DreamStore(join(dir2, "dest.db"));
	try {
		const mem = store.createMemory({
			content: "moving this memory",
			scope: "global",
			target: "user",
			tier: "factual",
			confidence: "inferred",
		});

		const moved = store.moveMemoryOut(
			mem.id,
			join(dir2, "dest.db"),
			"project",
			"test-project",
			{ target: "user", tier: "factual" },
		);
		assert.ok(moved, "Memory should be moved");
		// Confidence should be preserved (moveMemoryOut copies all fields)
		assert.equal(moved!.confidence, "inferred", "Confidence should survive cross-store move");
	} finally {
		store2.close();
		rmSync(dir2, { recursive: true, force: true });
		cleanup();
	}
});

// ── F3: utility_score multiplier in calculateDecay ───────────────────
//
// Background: the recall feedback loop boosts utility_score when a
// recalled memory was used (+0.05) and penalizes it when a contradiction
// was discarded (-0.10). The decay module now applies utility_score as
// a multiplier: high utility keeps the memory alive longer, low utility
// ages it out faster. Bounded in [0.5, 1.25] so a single boost can't
// permanently pin a memory.

test("calculateDecay: utility_score=0 → neutral multiplier (no change)", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "neutral utility memory",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const decayed = calculateDecay(m);
		assert.ok(decayed > 0, "decay must be positive");
		assert.ok(decayed < 1, "decay must be < 1.0 (capped at MAX_DECAY)");
	} finally {
		cleanup();
	}
});

test("calculateDecay: utility_score=1.0 → 1.25x boost (memory lasts longer)", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create memories with stale last_accessed_at so the utility
		// multiplier is visible (fresh memories hit the MAX_DECAY cap
		// before the multiplier matters). 30 days stale: 0.95^30 ≈ 0.215.
		const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
		const now = Date.now();
		const baseline = store.createMemory({
			content: "neutral memory",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const useful = store.createMemory({
			content: "very useful memory",
			scope: "global",
			target: "user",
			category: "preference",
		});
		// Backdate both to 30 days ago so decay isn't capped at MAX_DECAY
		// (the `db` accessor is private but used here for the backdating
		// setup that the public API doesn't expose).
		(store as any).db
			.prepare("UPDATE memories SET last_accessed_at = ?, created_at = ? WHERE id = ?")
			.run(now - THIRTY_DAYS, now - THIRTY_DAYS, baseline.id);
		(store as any).db
			.prepare("UPDATE memories SET last_accessed_at = ?, created_at = ? WHERE id = ?")
			.run(now - THIRTY_DAYS, now - THIRTY_DAYS, useful.id);
		// Re-fetch so calculateDecay sees the backdated timestamp
		const baselineFresh = store.getMemory(baseline.id)!;
		const usefulFresh = store.getMemory(useful.id)!;
		store.adjustUtility(usefulFresh.id, 10); // saturates to 1.0

		// Re-fetch AFTER adjustUtility: the snapshot usefulFresh was taken
		// before the boost, so its utility_score is still 0.0.
		const usefulAfter = store.getMemory(usefulFresh.id)!;
		const baselineDecay = calculateDecay(baselineFresh);
		const usefulDecay = calculateDecay(usefulAfter);
		assert.ok(
			usefulDecay > baselineDecay,
			`useful memory decay (${usefulDecay}) should exceed neutral (${baselineDecay})`,
		);
		// 1.25x upper bound — useful decay is at most 1.25x baseline.
		// Allow small float slack.
		assert.ok(
			usefulDecay <= baselineDecay * 1.25 + 0.001,
			`useful multiplier must be <= 1.25 (got ${(usefulDecay / baselineDecay).toFixed(3)})`,
		);
	} finally {
		cleanup();
	}
});

test("calculateDecay: utility_score=-1.0 → 0.5x penalty (memory ages faster)", () => {
	const { store, cleanup } = makeStore();
	try {
		// Backdate so decay is below MAX_DECAY (otherwise the penalty
		// multiplier has nothing to amplify downward).
		const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
		const now = Date.now();
		const baseline = store.createMemory({
			content: "neutral memory",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const wrong = store.createMemory({
			content: "often-wrong memory",
			scope: "global",
			target: "user",
			category: "preference",
		});
		(store as any).db
			.prepare("UPDATE memories SET last_accessed_at = ?, created_at = ? WHERE id = ?")
			.run(now - THIRTY_DAYS, now - THIRTY_DAYS, baseline.id);
		(store as any).db
			.prepare("UPDATE memories SET last_accessed_at = ?, created_at = ? WHERE id = ?")
			.run(now - THIRTY_DAYS, now - THIRTY_DAYS, wrong.id);
		const baselineFresh = store.getMemory(baseline.id)!;
		const wrongFresh = store.getMemory(wrong.id)!;
		store.adjustUtility(wrongFresh.id, -10); // saturates to -1.0

		// Re-fetch AFTER adjustUtility: the snapshot was taken before
		// the boost, so its utility_score is still 0.0.
		const wrongAfter = store.getMemory(wrongFresh.id)!;
		const baselineDecay = calculateDecay(baselineFresh);
		const wrongDecay = calculateDecay(wrongAfter);
		assert.ok(
			wrongDecay < baselineDecay,
			`wrong memory decay (${wrongDecay}) should be less than neutral (${baselineDecay})`,
		);
		// 0.5x lower bound — wrong decay is at least 0.5x baseline.
		assert.ok(
			wrongDecay >= baselineDecay * 0.5 - 0.001,
			`wrong multiplier must be >= 0.5 (got ${(wrongDecay / baselineDecay).toFixed(3)})`,
		);
	} finally {
		cleanup();
	}
});

// ── F3: adjustUtility clamping and arithmetic ───────────────────────

test("adjustUtility: clamps to [-1, 1] range", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "test memory",
			scope: "global",
			target: "user",
		});
		// Push past upper bound
		store.adjustUtility(m.id, 0.5);
		store.adjustUtility(m.id, 0.5);
		store.adjustUtility(m.id, 0.5);
		const saturated = store.getMemory(m.id)!;
		assert.equal(saturated.utility_score, 1.0, "must clamp at 1.0");

		// Push past lower bound
		store.adjustUtility(m.id, -10);
		const bottomed = store.getMemory(m.id)!;
		assert.equal(bottomed.utility_score, -1.0, "must clamp at -1.0");

		// Returns null for non-existent memory
		const result = store.adjustUtility("non-existent-id", 0.1);
		assert.equal(result, null);
	} finally {
		cleanup();
	}
});
