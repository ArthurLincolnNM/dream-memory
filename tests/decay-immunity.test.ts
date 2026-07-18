/**
 * Tests for Feature 1: Immunity Rules + ValueCategory Multipliers
 *
 * Memories can be immune to decay based on:
 *   - category (immuneCategories)
 *   - memory_kind (immuneKinds)
 *   - access_count >= threshold (immuneAccessCount)
 *   - user_stated + permanent TTL (trust_level=3, ttl_days=null)
 *
 * Additionally, kind and source multipliers adjust decay rates:
 *   - episodic decays faster than semantic (default 0.8x)
 *   - source-type multipliers from metadata
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { calculateDecay } from "../ttl/decay.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-decay-immunity-test-"));
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

function ageMemory(store: DreamStore, id: string, days: number) {
	const ts = Date.now() - days * 86_400_000;
	store.db
		.prepare("UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?")
		.run(ts, ts, id);
}

test("immune category returns MAX_DECAY (0.95)", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "test preference",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "factual",
		});
		ageMemory(store, mem.id, 60);
		const aged = store.getMemory(mem.id)!;
		const decay = calculateDecay(aged, {
			factor: 0.95,
			boostFactor: 0.1,
			immuneCategories: ["preference"],
		});
		assert.equal(decay, 0.95, "Immune category should return MAX_DECAY");
	} finally {
		cleanup();
	}
});

test("non-immune category decays normally", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "test insight",
			scope: "global",
			target: "user",
			category: "insight",
			tier: "factual",
		});
		ageMemory(store, mem.id, 60);
		const aged = store.getMemory(mem.id)!;
		const decay = calculateDecay(aged, {
			factor: 0.95,
			boostFactor: 0.1,
			immuneCategories: ["preference"],
		});
		assert.ok(decay < 0.5, `Non-immune insight should decay: ${decay}`);
	} finally {
		cleanup();
	}
});

test("high access_count grants immunity", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "frequently accessed",
			scope: "global",
			target: "user",
			tier: "factual",
		});
		ageMemory(store, mem.id, 60);
		// Set access_count above threshold
		store.db
			.prepare("UPDATE memories SET access_count = ? WHERE id = ?")
			.run(10, mem.id);
		const aged = store.getMemory(mem.id)!;
		const decay = calculateDecay(aged, { factor: 0.95, boostFactor: 0.1 });
		assert.equal(decay, 0.95, "High access count should grant immunity");
	} finally {
		cleanup();
	}
});

test("episodic memory decays faster than semantic", () => {
	const { store, cleanup } = makeStore();
	try {
		const epi = store.createMemory({
			content: "episodic event",
			scope: "global",
			target: "user",
			tier: "factual",
			memory_kind: "episodic",
		});
		const sem = store.createMemory({
			content: "semantic fact",
			scope: "global",
			target: "user",
			tier: "factual",
			memory_kind: "semantic",
		});
		ageMemory(store, epi.id, 30);
		ageMemory(store, sem.id, 30);
		const d1 = calculateDecay(store.getMemory(epi.id)!);
		const d2 = calculateDecay(store.getMemory(sem.id)!);
		assert.ok(d1 < d2, `Episodic (${d1}) should decay faster than semantic (${d2})`);
	} finally {
		cleanup();
	}
});

test("source type multiplier applies", () => {
	const { store, cleanup } = makeStore();
	try {
		const hook = store.createMemory({
			content: "tool result",
			scope: "global",
			target: "user",
			tier: "factual",
			metadata: { sourceType: "tool-result" },
		});
		const user = store.createMemory({
			content: "user stated",
			scope: "global",
			target: "user",
			tier: "factual",
			metadata: { sourceType: "user" },
		});
		ageMemory(store, hook.id, 30);
		ageMemory(store, user.id, 30);
		const d1 = calculateDecay(store.getMemory(hook.id)!, {
			factor: 0.95,
			boostFactor: 0.1,
			sourceMultipliers: { "tool-result": 0.7, user: 1.2 },
		});
		const d2 = calculateDecay(store.getMemory(user.id)!, {
			factor: 0.95,
			boostFactor: 0.1,
			sourceMultipliers: { "tool-result": 0.7, user: 1.2 },
		});
		assert.ok(d1 < d2, `tool-result (${d1}) should decay faster than user (${d2})`);
	} finally {
		cleanup();
	}
});

test("user_stated + permanent TTL grants immunity", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "permanent user fact",
			scope: "global",
			target: "user",
			tier: "factual",
			trust_level: 3,
			// No ttl_days = NULL in DB = permanent
		});
		ageMemory(store, mem.id, 90);
		const aged = store.getMemory(mem.id)!;
		// Confirm the memory has null ttl_days (permanent)
		assert.equal(aged.ttl_days, null, "Memory should have null ttl_days (permanent)");
		assert.equal(aged.trust_level, 3, "Memory should have trust_level 3");
		const decay = calculateDecay(aged);
		assert.equal(decay, 0.95, "user_stated + permanent should be immune");
	} finally {
		cleanup();
	}
});

test("custom immuneAccessCount threshold works", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "threshold test",
			scope: "global",
			target: "user",
			tier: "factual",
		});
		ageMemory(store, mem.id, 60);
		// access_count=3, threshold=3 → immune
		store.db
			.prepare("UPDATE memories SET access_count = ? WHERE id = ?")
			.run(3, mem.id);
		const aged = store.getMemory(mem.id)!;
		const decay = calculateDecay(aged, {
			factor: 0.95,
			boostFactor: 0.1,
			immuneAccessCount: 3,
		});
		assert.equal(decay, 0.95, "access_count >= custom threshold should grant immunity");
	} finally {
		cleanup();
	}
});

test("immuneKind grants immunity", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "episodic event",
			scope: "global",
			target: "user",
			tier: "factual",
			memory_kind: "episodic",
		});
		ageMemory(store, mem.id, 60);
		const aged = store.getMemory(mem.id)!;
		const decay = calculateDecay(aged, {
			factor: 0.95,
			boostFactor: 0.1,
			immuneKinds: ["episodic"],
		});
		assert.equal(decay, 0.95, "Immune kind should return MAX_DECAY");
	} finally {
		cleanup();
	}
});

test("no immunity when access_count below threshold", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "low access",
			scope: "global",
			target: "user",
			tier: "factual",
		});
		ageMemory(store, mem.id, 60);
		// access_count defaults to 0, threshold is 5
		const aged = store.getMemory(mem.id)!;
		const decay = calculateDecay(aged, { factor: 0.95, boostFactor: 0.1 });
		assert.ok(decay < 0.95, `Low access should not be immune: ${decay}`);
	} finally {
		cleanup();
	}
});

test("source multiplier defaults to 1.0 when not configured", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "no source config",
			scope: "global",
			target: "user",
			tier: "factual",
			metadata: { sourceType: "tool-result" },
		});
		ageMemory(store, mem.id, 30);
		const withConfig = calculateDecay(store.getMemory(mem.id)!, {
			factor: 0.95,
			boostFactor: 0.1,
			sourceMultipliers: { "tool-result": 0.7 },
		});
		const withoutConfig = calculateDecay(store.getMemory(mem.id)!, {
			factor: 0.95,
			boostFactor: 0.1,
			// No sourceMultipliers → default 1.0
		});
		assert.ok(withConfig < withoutConfig, "Configured source multiplier should reduce decay");
		// Without config, sourceMultiplier=1.0, so result should match kind*trust*base only
	} finally {
		cleanup();
	}
});
