/**
 * Tests for Gap #3 active forgetting.
 *
 * Background: F3 has only positive utility feedback (+0.05 boost on tool
 * success, -0.02 per failure). Without a chronic-noise signal, a memory
 * that's in recall during 5+ consecutive tool failures stays in recall
 * forever (the per-failure -0.02 is too small to overcome decay alone
 * in a healthy decay regime). Active forgetting catches this: after
 * ACTIVE_FORGETTING_THRESHOLD consecutive failures, an extra
 * ACTIVE_FORGETTING_PENALTY is applied (default -0.05), and the counter
 * resets. F3 success resets the counter to 0.
 *
 * The logic is extracted into a top-level `applyActiveForgetting` function
 * for testability (the inline version was hard to mock from the tool
 * handler).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { applyActiveForgetting } from "../index.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-activeforget-"));
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

function makeMissCount(): Map<string, number> {
	return new Map<string, number>();
}

test("active forgetting: empty memIds is a no-op", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "User prefers vim for all editing",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const initial = m.utility_score;
		const missCount = makeMissCount();

		applyActiveForgetting([], false, missCount, { global: store, project: null }, { threshold: 5, penalty: -0.05 });

		const after = store.getMemory(m.id);
		assert.equal(after!.utility_score, initial, "empty input must not modify any memory");
	} finally {
		cleanup();
	}
});

test("active forgetting: success resets miss count for all memories", () => {
	const missCount = makeMissCount();
	missCount.set("mem-1", 3);
	missCount.set("mem-2", 4);
	missCount.set("mem-3", 10); // over threshold — should also be reset

	applyActiveForgetting(
		["mem-1", "mem-2", "mem-3"],
		true, // success
		missCount,
		{ global: null as any, project: null },
		{ threshold: 5, penalty: -0.05 },
	);

	assert.equal(missCount.get("mem-1"), undefined, "mem-1 reset on success");
	assert.equal(missCount.get("mem-2"), undefined, "mem-2 reset on success");
	assert.equal(missCount.get("mem-3"), undefined, "mem-3 reset on success (even if over threshold)");
});

test("active forgetting: failure increments miss count up to threshold, then applies penalty", () => {
	const { store, cleanup } = makeStore();
	try {
		const m1 = store.createMemory({
			content: "User prefers vim for all editing tasks in the project",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const m2 = store.createMemory({
			content: "Project uses TypeScript for all source code in the repo",
			scope: "global",
			target: "project",
			category: "convention",
		});

		const initialM1 = m1.utility_score; // 0.0
		const initialM2 = m2.utility_score;

		const missCount = makeMissCount();
		const stores = { global: store, project: null };
		const opts = { threshold: 5, penalty: -0.05 };

		// 4 failures: should NOT trigger penalty yet (threshold is 5)
		for (let i = 0; i < 4; i++) {
			applyActiveForgetting([m1.id, m2.id], false, missCount, stores, opts);
		}
		assert.equal(missCount.get(m1.id), 4, "miss count at 4 after 4 failures");
		assert.equal(missCount.get(m2.id), 4, "miss count at 4 after 4 failures");
		let m1After = store.getMemory(m1.id);
		assert.equal(m1After!.utility_score, initialM1, "no penalty yet (4 < 5)");

		// 5th failure: should trigger penalty and reset counter
		applyActiveForgetting([m1.id, m2.id], false, missCount, stores, opts);
		assert.equal(missCount.get(m1.id), 0, "miss count reset after penalty");
		assert.equal(missCount.get(m2.id), 0, "miss count reset after penalty");
		m1After = store.getMemory(m1.id);
		assert.ok(
			m1After!.utility_score < initialM1,
			`utility must drop after chronic penalty (was ${initialM1}, now ${m1After!.utility_score})`,
		);
		// Penalty is -0.05, cap floor is 0.5x. Starting at 0.0, the multiplier
		// is 1 + 0 * 0.25 = 1, so decay multiplier is 1.0 → utility stays 0.
		// But adjustUtility uses raw delta, so utility should be -0.05.
		assert.equal(m1After!.utility_score, initialM1 - 0.05, "utility dropped by exactly -0.05");
	} finally {
		cleanup();
	}
});

test("active forgetting: per-memory isolation (one memory's misses don't affect another)", () => {
	const { store, cleanup } = makeStore();
	try {
		const m1 = store.createMemory({
			content: "User prefers dark mode in all editors and IDEs across all projects",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const m2 = store.createMemory({
			content: "Project uses TypeScript for all source code in the repository",
			scope: "global",
			target: "project",
			category: "convention",
		});

		const missCount = makeMissCount();
		const stores = { global: store, project: null };
		const opts = { threshold: 5, penalty: -0.05 };

		// Only m1 fails 5 times; m2 is not in recall
		for (let i = 0; i < 5; i++) {
			applyActiveForgetting([m1.id], false, missCount, stores, opts);
		}

		const m1After = store.getMemory(m1.id);
		const m2After = store.getMemory(m2.id);
		assert.ok(m1After!.utility_score < 0, "m1 penalized for chronic failures");
		assert.equal(m2After!.utility_score, 0, "m2 unaffected (not in recall)");
	} finally {
		cleanup();
	}
});

test("active forgetting: success after partial misses resets the counter", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "User prefers dark mode in all editors across all projects for all work",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const missCount = makeMissCount();
		const stores = { global: store, project: null };
		const opts = { threshold: 5, penalty: -0.05 };

		// 3 failures
		applyActiveForgetting([m.id], false, missCount, stores, opts);
		applyActiveForgetting([m.id], false, missCount, stores, opts);
		applyActiveForgetting([m.id], false, missCount, stores, opts);
		assert.equal(missCount.get(m.id), 3);

		// 1 success resets
		applyActiveForgetting([m.id], true, missCount, stores, opts);
		assert.equal(missCount.get(m.id), undefined, "success resets counter");

		// 4 more failures: still below threshold
		for (let i = 0; i < 4; i++) {
			applyActiveForgetting([m.id], false, missCount, stores, opts);
		}
		assert.equal(missCount.get(m.id), 4, "counter restarted from 0 after success");
	} finally {
		cleanup();
	}
});

test("active forgetting: threshold is configurable (smaller threshold = faster decay)", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "User prefers dark mode in all editors across all projects for all work",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const missCount = makeMissCount();
		const stores = { global: store, project: null };

		// 2 failures with threshold=2: triggers penalty
		applyActiveForgetting([m.id], false, missCount, stores, { threshold: 2, penalty: -0.1 });
		applyActiveForgetting([m.id], false, missCount, stores, { threshold: 2, penalty: -0.1 });

		const after = store.getMemory(m.id);
		assert.equal(after!.utility_score, -0.1, "small threshold + custom penalty applied");
	} finally {
		cleanup();
	}
});

test("active forgetting: deleted memory is gracefully ignored (no throw)", () => {
	const missCount = makeMissCount();
	const stores = { global: null as any, project: null };

	// Should not throw even though the store has no memory
	applyActiveForgetting(["nonexistent-id"], false, missCount, stores, { threshold: 5, penalty: -0.05 });
	// If we get here without throwing, the test passes.
	assert.equal(missCount.get("nonexistent-id"), 1, "miss count still increments for safety");
});
