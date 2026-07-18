/**
 * Tests for Gap #5 GC of stale memories.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { garbageCollectStaleMemories } from "../dream/synthesis.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-gc-test-"));
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

test("Gap #5: GC returns 0 for empty store", () => {
	const { store, cleanup } = makeStore();
	try {
		const result = garbageCollectStaleMemories(store);
		assert.equal(result.checked, 0);
		assert.equal(result.gcCount, 0);
		assert.equal(result.ids.length, 0);
	} finally {
		cleanup();
	}
});

test("Gap #5: GC keeps memories with healthy utility", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "User prefers dark mode in all editors across all platforms and contexts for work",
			scope: "global",
			target: "user",
			category: "preference",
		});
		const result = garbageCollectStaleMemories(store);
		assert.equal(result.checked, 1);
		assert.equal(result.gcCount, 0, "healthy memory must not be GC'd");
	} finally {
		cleanup();
	}
});

test("Gap #5: GC marks low-utility + stale-access memories as superseded", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "User prefers dark mode in all editors across all platforms and contexts for work",
			scope: "global",
			target: "user",
			category: "preference",
		});
		// Force utility to -0.6 and last_accessed_at to 100 days ago
		store.adjustUtility(m.id, -0.6);
		store.updateMemory(m.id, {
			last_accessed_at: Date.now() - Date.now() - 100 * 24 * 60 * 60 * 1000 * 24 * 60 * 60 * 1000,
			updated_at: Date.now() - Date.now() - 100 * 24 * 60 * 60 * 1000 * 24 * 60 * 60 * 1000,
		});

		const result = garbageCollectStaleMemories(store);
		assert.equal(result.gcCount, 1, "low-utility + stale must be GC'd");
		assert.equal(result.ids[0], m.id);

		const after = store.getMemory(m.id);
		assert.equal(after!.status, "superseded", "memory must be marked superseded");
	} finally {
		cleanup();
	}
});

test("Gap #5: GC skips memories with always_inject flag", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "User prefers dark mode in all editors across all platforms and contexts for work",
			scope: "global",
			target: "user",
			category: "preference",
			metadata: { always_inject: true },
		});
		store.adjustUtility(m.id, -0.9);
		store.updateMemory(m.id, {
			last_accessed_at: Date.now() - Date.now() - 200 * 24 * 60 * 60 * 1000 * 24 * 60 * 60 * 1000,
			updated_at: Date.now() - Date.now() - 200 * 24 * 60 * 60 * 1000 * 24 * 60 * 60 * 1000,
		});

		const result = garbageCollectStaleMemories(store);
		assert.equal(result.gcCount, 0, "always-inject memory must be preserved");
	} finally {
		cleanup();
	}
});

test("Gap #5: GC skips memories with explicit confidence + accesses (user-cared)", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "User prefers dark mode in all editors across all platforms and contexts for work",
			scope: "global",
			target: "user",
			category: "preference",
			confidence: "explicit",
		});
		// access_count = 1 by default from createMemory? No, default 0. Set it via update.
		// Actually createMemory sets access_count=0 by default. The test requires
		// access_count > 0 to skip. So we manually set via update.
		store.adjustUtility(m.id, -0.9);
		store.updateMemory(m.id, {
			access_count: 5,
			last_accessed_at: Date.now() - 200 * 24 * 60 * 60 * 1000,
		});

		const result = garbageCollectStaleMemories(store);
		assert.equal(result.gcCount, 0, "explicit memory with accesses must be preserved");
	} finally {
		cleanup();
	}
});

test("Gap #5: GC skips recently-updated memories (fresh work)", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create with bad utility, then update metadata to make it look stale
		const m = store.createMemory({
			content: "User prefers dark mode in all editors across all platforms and contexts for work",
			scope: "global",
			target: "user",
			category: "preference",
		});
		store.adjustUtility(m.id, -0.9);
		// Fresh work: updated_at is recent. Without backdating, the
		// default minDaysSinceUpdate=7 makes this safe from GC even
		// though utility is bad.
		store.updateMemory(m.id, {
			last_accessed_at: Date.now() - 200 * 24 * 60 * 60 * 1000,
			updated_at: Date.now(),
		});

		const result = garbageCollectStaleMemories(store);
		assert.equal(result.gcCount, 0, "memory updated today is fresh, skip GC");
	} finally {
		cleanup();
	}
});

test("Gap #5: GC dryRun does not write", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "User prefers dark mode in all editors across all platforms and contexts for work",
			scope: "global",
			target: "user",
			category: "preference",
		});
		store.adjustUtility(m.id, -0.6);
		store.updateMemory(m.id, {
			last_accessed_at: Date.now() - Date.now() - 100 * 24 * 60 * 60 * 1000 * 24 * 60 * 60 * 1000,
			updated_at: Date.now() - Date.now() - 100 * 24 * 60 * 60 * 1000 * 24 * 60 * 60 * 1000,
		});

		const result = garbageCollectStaleMemories(store, { dryRun: true });
		assert.equal(result.gcCount, 1, "dry-run reports would-GC count");
		assert.equal(result.ids[0], m.id, "dry-run reports the ID");

		// But the actual memory is NOT superseded
		const after = store.getMemory(m.id);
		assert.equal(after!.status, "active", "dry-run must not modify the memory");
	} finally {
		cleanup();
	}
});

test("Gap #5: GC handles memories with never-accessed (last_accessed_at=null)", () => {
	const { store, cleanup } = makeStore();
	try {
		const m = store.createMemory({
			content: "User prefers dark mode in all editors across all platforms and contexts for work",
			scope: "global",
			target: "user",
			category: "preference",
		});
		// last_accessed_at defaults to null on create. Backdate
		// updated_at so the recently-updated gate doesn't skip the
		// memory (default minDaysSinceUpdate=7).
		store.adjustUtility(m.id, -0.6);
		store.updateMemory(m.id, {
			last_accessed_at: null,
			updated_at: Date.now() - 100 * 24 * 60 * 60 * 1000,
		});

		const result = garbageCollectStaleMemories(store);
		assert.equal(result.gcCount, 1, "never-accessed + low-utility must be GC'd");
	} finally {
		cleanup();
	}
});
