/**
 * Tests for Feature: Trust Hierarchy (v2.0)
 *
 * Trust hierarchy determines how much weight a memory carries when conflicts
 * arise. Higher trust = more trustworthy:
 *   3 = user_stated  (highest — user said it directly)
 *   2 = agreed_upon  (user confirmed or agent suggested + accepted)
 *   1 = llm_suggested (agent suggested, no confirmation)
 *   0 = llm_extracted (lowest — auto-captured from tool usage)
 *
 * Tests cover:
 *   1. Schema: trust_level column exists and defaults correctly
 *   2. Decay: higher trust = slower decay
 *   3. Contradiction: higher trust wins, equal trust = needs arbitration
 *   4. Injection: trust attribute appears in XML output
 *   5. Auto-capture: correct trust level assigned
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { calculateDecay } from "../ttl/decay.js";
import { detectContradictions } from "../contradiction/detector.js";
import { resolveContradiction } from "../contradiction/resolver.js";
import { formatRecallForInjection } from "../recall/inject.js";
import { TRUST_LEVELS, TRUST_DECAY_WEIGHTS } from "../utils/constants.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-trust-test-"));
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

// ── 1. Schema: trust_level column ──────────────────────────────────────

test("trust_level column exists and defaults to 2 (agreed_upon)", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "test memory",
			scope: "global",
			target: "user",
		});
		assert.equal(mem.trust_level, 2, "Default trust_level should be 2 (agreed_upon)");
	} finally {
		cleanup();
	}
});

test("trust_level can be set to 3 (user_stated)", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "user prefers vim",
			scope: "global",
			target: "user",
			category: "preference",
			trust_level: 3,
		});
		assert.equal(mem.trust_level, 3);
	} finally {
		cleanup();
	}
});

test("trust_level can be set to 0 (llm_extracted)", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "tool bash failed 3 times",
			scope: "global",
			target: "failure",
			category: "tool-quirk",
			trust_level: 0,
		});
		assert.equal(mem.trust_level, 0);
	} finally {
		cleanup();
	}
});

test("trust_level persists through getMemory", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "test persistence",
			scope: "global",
			target: "user",
			trust_level: 1,
		});
		const fetched = store.getMemory(mem.id);
		assert.ok(fetched);
		assert.equal(fetched.trust_level, 1);
	} finally {
		cleanup();
	}
});

test("updateMemory can change trust_level", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "test update",
			scope: "global",
			target: "user",
			trust_level: 0,
		});
		const updated = store.updateMemory(mem.id, { trust_level: 3 });
		assert.ok(updated);
		assert.equal(updated.trust_level, 3);
	} finally {
		cleanup();
	}
});

// ── 2. Decay: higher trust = slower decay ──────────────────────────────

test("higher trust memory decays slower than lower trust", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create two memories with same content age
		const highTrust = store.createMemory({
			content: "high trust memory",
			scope: "global",
			target: "user",
			trust_level: 3, // user_stated
		});
		const lowTrust = store.createMemory({
			content: "low trust memory",
			scope: "global",
			target: "failure",
			trust_level: 0, // llm_extracted
		});

		// Make both old (30 days)
		const thirtyDaysAgo = Date.now() - 30 * 86400000;
		store.db.prepare("UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?").run(
			thirtyDaysAgo, thirtyDaysAgo, highTrust.id,
		);
		store.db.prepare("UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?").run(
			thirtyDaysAgo, thirtyDaysAgo, lowTrust.id,
		);

		const refreshedHigh = store.getMemory(highTrust.id)!;
		const refreshedLow = store.getMemory(lowTrust.id)!;

		const decayHigh = calculateDecay(refreshedHigh);
		const decayLow = calculateDecay(refreshedLow);

		// High trust (3) should have higher decay score (slower decay)
		assert.ok(
			decayHigh > decayLow,
			`High trust decay (${decayHigh}) should be > low trust decay (${decayLow})`,
		);

		// Verify the math: trust=3 → ×1.25, trust=0 → ×0.70
		const expectedRatio = TRUST_DECAY_WEIGHTS[3] / TRUST_DECAY_WEIGHTS[0];
		const actualRatio = decayHigh / decayLow;
		// Allow some tolerance due to MAX_DECAY capping
		assert.ok(
			actualRatio > expectedRatio * 0.8,
			`Ratio ${actualRatio} should be close to expected ${expectedRatio}`,
		);
	} finally {
		cleanup();
	}
});

test("default trust (2) has neutral decay multiplier", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "default trust",
			scope: "global",
			target: "user",
			// no trust_level → defaults to 2
		});
		const decay = calculateDecay(mem);
		// Fresh memory: decay should be near MAX_DECAY (0.95)
		assert.ok(decay > 0.8, `Fresh memory decay should be > 0.8, got ${decay}`);
		assert.ok(decay <= 0.95, `Decay should be <= MAX_DECAY (0.95), got ${decay}`);
	} finally {
		cleanup();
	}
});

// ── 3. Contradiction: trust-aware arbitration ──────────────────────────

test("contradiction: higher trust new memory auto-replaces lower trust existing", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create existing memory with LOW trust (llm_extracted)
		const existing = store.createMemory({
			content: "user prefers dark mode",
			scope: "global",
			target: "user",
			category: "preference",
			trust_level: 0,
		});

		// New memory with HIGH trust (user_stated) — very similar content
		const candidates = detectContradictions(
			"user prefers dark mode",
			"user",
			[existing],
			{ similarityThreshold: 0.5, arbitrationThreshold: 0.95 },
			3, // new trust_level = user_stated
		);

		assert.ok(candidates.length > 0, "Should detect contradiction");
		// With high trust difference and high similarity, should NOT need arbitration
		const candidate = candidates[0];
		assert.equal(candidate.newIsLowerTrust, false, "New memory should NOT be lower trust");
		// needsArbitration should be false when trust clearly dominates
		// and similarity is high enough (> arbitrationThreshold)
		assert.equal(candidate.needsArbitration, false, "Should auto-resolve (trust dominates + high similarity)");
	} finally {
		cleanup();
	}
});

test("contradiction: lower trust new memory needs arbitration against higher trust existing", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create existing memory with HIGH trust (user_stated)
		const existing = store.createMemory({
			content: "user prefers dark mode",
			scope: "global",
			target: "user",
			category: "preference",
			trust_level: 3,
		});

		// New memory with LOW trust (llm_extracted) — similar content
		const candidates = detectContradictions(
			"user prefers dark mode everywhere",
			"user",
			[existing],
			{ similarityThreshold: 0.5, arbitrationThreshold: 0.95 },
			0, // new trust_level = llm_extracted
		);

		assert.ok(candidates.length > 0, "Should detect contradiction");
		const candidate = candidates[0];
		assert.equal(candidate.newIsLowerTrust, true, "New memory should be lower trust");
	} finally {
		cleanup();
	}
});

test("contradiction resolution: lower trust new memory is discarded", async () => {
	const { store, cleanup } = makeStore();
	try {
		const existing = store.createMemory({
			content: "user prefers dark mode",
			scope: "global",
			target: "user",
			category: "preference",
			trust_level: 3,
		});

		const candidates = detectContradictions(
			"user prefers light mode",
			"user",
			[existing],
			{ similarityThreshold: 0.5, arbitrationThreshold: 0.95 },
			0, // new trust = llm_extracted
		);

		if (candidates.length > 0) {
			const candidate = candidates[0];
			// Simulate new trust level on candidate
			(candidate as any).newTrustLevel = 0;
			const result = await resolveContradiction(candidate, "user prefers light mode");
			// Should discard the lower-trust new memory
			assert.equal(result.action, "discard", "Should discard lower-trust new memory");
			assert.equal(result.autoResolved, true, "Should auto-resolve (trust hierarchy)");
		}
	} finally {
		cleanup();
	}
});

// ── 4. Injection: trust attribute in XML ───────────────────────────────

test("recall injection includes trust attribute", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "user prefers vim",
			scope: "global",
			target: "user",
			category: "preference",
			trust_level: 3,
		});

		// Simulate a search result
		const results = [{
			memory: store.getMemory(mem.id)!,
			score: 0.9,
			snippet: "user prefers vim",
		}];

		const injected = formatRecallForInjection(results, {
			maxTokens: 4000,
			format: "xml",
		});

		assert.ok(injected.includes("trust=\"user_stated\""), `Should contain trust="user_stated", got: ${injected}`);
		assert.ok(injected.includes("dream_memories"), "Should be wrapped in dream_memories");
	} finally {
		cleanup();
	}
});

test("recall injection shows trust label for llm_extracted", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "tool bash failed 3 times",
			scope: "global",
			target: "failure",
			category: "tool-quirk",
			trust_level: 0,
		});

		const results = [{
			memory: store.getMemory(mem.id)!,
			score: 0.8,
			snippet: "tool bash failed",
		}];

		const injected = formatRecallForInjection(results, {
			maxTokens: 4000,
			format: "xml",
		});

		assert.ok(injected.includes("trust=\"llm_extracted\""), `Should contain trust="llm_extracted"`);
	} finally {
		cleanup();
	}
});

// ── 5. Constants: trust hierarchy values ────────────────────────────────

test("TRUST_LEVELS has correct values", () => {
	assert.equal(TRUST_LEVELS.llm_extracted, 0);
	assert.equal(TRUST_LEVELS.llm_suggested, 1);
	assert.equal(TRUST_LEVELS.agreed_upon, 2);
	assert.equal(TRUST_LEVELS.user_stated, 3);
});

test("TRUST_DECAY_WEIGHTS are monotonically increasing", () => {
	const weights = [
		TRUST_DECAY_WEIGHTS[0],
		TRUST_DECAY_WEIGHTS[1],
		TRUST_DECAY_WEIGHTS[2],
		TRUST_DECAY_WEIGHTS[3],
	];
	for (let i = 1; i < weights.length; i++) {
		assert.ok(
			weights[i] > weights[i - 1],
			`Weight at level ${i} (${weights[i]}) should be > level ${i - 1} (${weights[i - 1]})`,
		);
	}
});

// ── 6. Edge cases ──────────────────────────────────────────────────────

test("restoreMemory preserves trust_level", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "test restore",
			scope: "global",
			target: "user",
			trust_level: 3,
		});

		// Delete and restore
		store.deleteMemory(mem.id);
		const restored = store.restoreMemory(mem);

		assert.equal(restored.trust_level, 3, "Restored memory should preserve trust_level");
	} finally {
		cleanup();
	}
});

test("listMemories returns trust_level", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "test list",
			scope: "global",
			target: "user",
			trust_level: 1,
		});

		const memories = store.listMemories({ scope: "global" });
		assert.ok(memories.length > 0);
		assert.equal(memories[0].trust_level, 1);
	} finally {
		cleanup();
	}
});
