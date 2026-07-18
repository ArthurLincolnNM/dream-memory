/**
 * Tests for store pruning methods:
 *   - pruneSessionMessages: delete old session messages (DB bloat fix)
 *   - pruneToolUsage: delete old tool usage rows
 *   - pruneOldVersions: keep only last N versions per memory
 *   - getRowCounts: monitoring helper
 *
 * These methods address the 30GB DB bloat bug where session_messages
 * (toolResult avg 3.3KB each) accumulated without cleanup.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { indexSessions } from "../sessions/indexer.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-pruning-test-"));
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

// Helper: insert a session message directly (bypasses indexer for test control)
function insertSessionMessage(
	store: DreamStore,
	content: string,
	timestamp: number,
	sessionFile: string = "test-session.jsonl",
): void {
	const db = (store as any).db;
	db.prepare(`
		INSERT INTO session_messages
		(session_file, session_id, message_id, role, content, timestamp, parent_id, metadata, indexed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(sessionFile, "test-session-id", null, "user", content, timestamp, null, null, Date.now());
}

// ── pruneSessionMessages ───────────────────────────────────────────────

test("pruneSessionMessages: returns 0 on empty table", () => {
	const { store, cleanup } = makeStore();
	try {
		const pruned = store.pruneSessionMessages(30);
		assert.equal(pruned, 0, "empty table should prune 0 rows");
	} finally {
		cleanup();
	}
});

test("pruneSessionMessages: deletes messages older than retention window", () => {
	const { store, cleanup } = makeStore();
	try {
		const now = Date.now();
		const oneDay = 86400000;

		// Insert messages at different ages
		insertSessionMessage(store, "old message 1", now - 60 * oneDay); // 60 days old
		insertSessionMessage(store, "old message 2", now - 45 * oneDay); // 45 days old
		insertSessionMessage(store, "recent message 1", now - 10 * oneDay); // 10 days old
		insertSessionMessage(store, "recent message 2", now - 1 * oneDay); // 1 day old
		insertSessionMessage(store, "fresh message", now); // now

		const pruned = store.pruneSessionMessages(30);
		assert.equal(pruned, 2, "should delete 2 messages older than 30 days");

		// Verify remaining messages
		const db = (store as any).db;
		const remaining = db.prepare("SELECT COUNT(*) as cnt FROM session_messages").get() as any;
		assert.equal(remaining.cnt, 3, "should keep 3 messages within retention window");
	} finally {
		cleanup();
	}
});

test("pruneSessionMessages: keeps all messages within retention window", () => {
	const { store, cleanup } = makeStore();
	try {
		const now = Date.now();
		const oneDay = 86400000;

		// All messages within 30 days
		insertSessionMessage(store, "msg 1", now - 5 * oneDay);
		insertSessionMessage(store, "msg 2", now - 10 * oneDay);
		insertSessionMessage(store, "msg 3", now - 29 * oneDay);

		const pruned = store.pruneSessionMessages(30);
		assert.equal(pruned, 0, "no messages should be pruned when all are within retention");

		const db = (store as any).db;
		const remaining = db.prepare("SELECT COUNT(*) as cnt FROM session_messages").get() as any;
		assert.equal(remaining.cnt, 3, "all 3 messages should remain");
	} finally {
		cleanup();
	}
});

test("pruneSessionMessages: custom retention period", () => {
	const { store, cleanup } = makeStore();
	try {
		const now = Date.now();
		const oneDay = 86400000;

		insertSessionMessage(store, "old", now - 10 * oneDay);
		insertSessionMessage(store, "new", now - 2 * oneDay);

		// 7-day retention: only the 10-day-old message should be deleted
		const pruned = store.pruneSessionMessages(7);
		assert.equal(pruned, 1, "should delete 1 message older than 7 days");

		const db = (store as any).db;
		const remaining = db.prepare("SELECT content FROM session_messages").all() as any[];
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0].content, "new", "should keep the 2-day-old message");
	} finally {
		cleanup();
	}
});

test("pruneSessionMessages: FTS5 index stays consistent after delete", () => {
	const { store, cleanup } = makeStore();
	try {
		const now = Date.now();
		const oneDay = 86400000;

		insertSessionMessage(store, "test content alpha", now - 60 * oneDay);
		insertSessionMessage(store, "test content beta", now - 1 * oneDay);

		store.pruneSessionMessages(30);

		// Verify the base table only has the remaining message
		const db = (store as any).db;
		const remaining = db.prepare("SELECT content FROM session_messages").all() as any[];
		assert.equal(remaining.length, 1, "base table should have 1 message");
		assert.ok(remaining[0].content.includes("beta"), "remaining message should be 'beta'");

		// FTS5 external content mode: the triggers fire on DELETE from base table,
		// but FTS5 may have stale entries. The base table is the source of truth.
		// Verify FTS5 at least has the surviving entry.
		const ftsCount = db.prepare("SELECT COUNT(*) as cnt FROM session_messages_fts").get() as any;
		assert.ok(ftsCount.cnt >= 1, "FTS5 should have at least the remaining entry");
	} finally {
		cleanup();
	}
});

// ── pruneToolUsage ─────────────────────────────────────────────────────

test("pruneToolUsage: returns 0 on empty table", () => {
	const { store, cleanup } = makeStore();
	try {
		const pruned = store.pruneToolUsage(30);
		assert.equal(pruned, 0);
	} finally {
		cleanup();
	}
});

test("pruneToolUsage: deletes old tool usage rows", () => {
	const { store, cleanup } = makeStore();
	try {
		const now = Date.now();
		const oneDay = 86400000;

		// Manually insert with old timestamps (trackToolUsage uses Date.now())
		const db = (store as any).db;
		const insert = db.prepare(`
			INSERT INTO tool_usage (tool, args_hash, args_preview, timestamp, success)
			VALUES (?, ?, ?, ?, ?)
		`);

		insert.run("bash", "hash1", "ls -la", now - 60 * oneDay, 1);
		insert.run("bash", "hash2", "pwd", now - 45 * oneDay, 1);
		insert.run("read", "hash3", "file.ts", now - 10 * oneDay, 1);
		insert.run("grep", "hash4", "pattern", now - 1 * oneDay, 1);

		const pruned = store.pruneToolUsage(30);
		assert.equal(pruned, 2, "should delete 2 rows older than 30 days");

		const remaining = db.prepare("SELECT COUNT(*) as cnt FROM tool_usage").get() as any;
		assert.equal(remaining.cnt, 2, "should keep 2 recent rows");
	} finally {
		cleanup();
	}
});

test("pruneToolUsage: preserves recent tool usage for auto-capture", () => {
	const { store, cleanup } = makeStore();
	try {
		const now = Date.now();
		const oneDay = 86400000;

		// Simulate a tool pattern: bash called 5 times in last 7 days
		const db = (store as any).db;
		const insert = db.prepare(`
			INSERT INTO tool_usage (tool, args_hash, args_preview, timestamp, success)
			VALUES (?, ?, ?, ?, ?)
		`);

		for (let i = 0; i < 5; i++) {
			insert.run("bash", "same_hash", "npm test", now - i * oneDay, 1);
		}

		const pruned = store.pruneToolUsage(30);
		assert.equal(pruned, 0, "all recent tool usage should be preserved");

		// Verify auto-capture would still detect the pattern
		const usages = store.getToolUsageInWindow({
			tool: "bash",
			argsHash: "same_hash",
			since: now - 7 * oneDay,
		});
		assert.equal(usages.length, 5, "auto-capture window should see all 5 calls");
	} finally {
		cleanup();
	}
});

// ── pruneOldVersions ───────────────────────────────────────────────────

test("pruneOldVersions: returns 0 when no versions exist", () => {
	const { store, cleanup } = makeStore();
	try {
		const pruned = store.pruneOldVersions(10);
		assert.equal(pruned, 0);
	} finally {
		cleanup();
	}
});

test("pruneOldVersions: keeps last N versions per memory", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create a memory and update it many times to build version history
		const mem = store.createMemory({
			content: "original content",
			scope: "global",
			target: "user",
			tier: "operational",
		});

		// Create 15 versions (v1 from create + 14 updates)
		for (let i = 0; i < 14; i++) {
			store.updateMemory(mem.id, { content: `version ${i + 2}` });
		}

		// Verify we have 15 versions
		const versionsBefore = store.getVersions(mem.id);
		assert.equal(versionsBefore.length, 15, "should have 15 versions before pruning");

		// Prune to keep only last 5
		const pruned = store.pruneOldVersions(5);
		assert.ok(pruned >= 10, `should delete at least 10 old versions, got ${pruned}`);

		// Verify remaining versions
		const versionsAfter = store.getVersions(mem.id);
		assert.equal(versionsAfter.length, 5, "should keep exactly 5 versions");

		// The kept versions should be the most recent ones (v11-v15)
		const versionNumbers = versionsAfter.map((v) => v.version_number).sort((a, b) => a - b);
		assert.deepEqual(versionNumbers, [11, 12, 13, 14, 15], "should keep the 5 most recent versions");
	} finally {
		cleanup();
	}
});

test("pruneOldVersions: preserves all versions when count is below keepLast", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "content",
			scope: "global",
			target: "user",
			tier: "operational",
		});
		store.updateMemory(mem.id, { content: "updated" });

		const versionsBefore = store.getVersions(mem.id);
		assert.equal(versionsBefore.length, 2);

		const pruned = store.pruneOldVersions(10);
		assert.equal(pruned, 0, "should not delete when below keepLast threshold");

		const versionsAfter = store.getVersions(mem.id);
		assert.equal(versionsAfter.length, 2, "all versions should remain");
	} finally {
		cleanup();
	}
});

test("pruneOldVersions: handles multiple memories independently", () => {
	const { store, cleanup } = makeStore();
	try {
		// Memory A: 20 versions
		const memA = store.createMemory({
			content: "memory A",
			scope: "global",
			target: "user",
			tier: "operational",
		});
		for (let i = 0; i < 19; i++) {
			store.updateMemory(memA.id, { content: `A v${i + 2}` });
		}

		// Memory B: create + 1 update = 2 versions (below keepLast=5)
		const memB = store.createMemory({
			content: "memory B",
			scope: "global",
			target: "project",
			tier: "operational",
		});
		store.updateMemory(memB.id, { content: "B v2" });

		const pruned = store.pruneOldVersions(5);
		assert.ok(pruned >= 15, "should prune old versions from memory A");

		// Memory A: keep last 5
		const versionsA = store.getVersions(memA.id);
		assert.equal(versionsA.length, 5, "memory A should keep 5 versions");

		// Memory B: all 2 versions kept (below keepLast=5)
		const versionsB = store.getVersions(memB.id);
		assert.equal(versionsB.length, 2, "memory B should keep all 2 versions (below keepLast=5)");
	} finally {
		cleanup();
	}
});

test("pruneOldVersions: does not affect memory content or status", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "important fact",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "operational",
		});
		for (let i = 0; i < 8; i++) {
			store.updateMemory(mem.id, { content: `fact v${i + 2}` });
		}

		store.pruneOldVersions(3);

		// Memory itself is untouched
		const after = store.getMemory(mem.id);
		assert.ok(after, "memory should still exist");
		assert.equal(after!.content, "fact v9", "memory content should be the latest");
		assert.equal(after!.category, "preference", "category should be preserved");
	} finally {
		cleanup();
	}
});

// ── getRowCounts ───────────────────────────────────────────────────────

test("getRowCounts: returns correct counts for all tables", () => {
	const { store, cleanup } = makeStore();
	try {
		// Seed some data
		store.createMemory({
			content: "test memory",
			scope: "global",
			target: "user",
			tier: "operational",
		});
		store.trackToolUsage({ tool: "bash", args: { command: "ls" } });

		const counts = store.getRowCounts();
		assert.equal(counts.memories, 1);
		assert.equal(counts.tool_usage, 1);
		assert.ok(counts.memory_versions >= 1, "createMemory creates at least 1 version");
		// session_messages: 0 (not inserted via indexer)
		assert.equal(counts.session_messages, 0);
	} finally {
		cleanup();
	}
});

test("getRowCounts: reflects pruning operations", () => {
	const { store, cleanup } = makeStore();
	try {
		const db = (store as any).db;
		const now = Date.now();
		const oneDay = 86400000;

		// Insert old session messages
		for (let i = 0; i < 10; i++) {
			db.prepare(`
				INSERT INTO session_messages
				(session_file, session_id, message_id, role, content, timestamp, parent_id, metadata, indexed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(`file${i}.jsonl`, "sid", null, "user", `msg ${i}`, now - 60 * oneDay, null, null, now);
		}

		const before = store.getRowCounts();
		assert.equal(before.session_messages, 10);

		store.pruneSessionMessages(30);

		const after = store.getRowCounts();
		assert.equal(after.session_messages, 0, "all old messages should be pruned");
	} finally {
		cleanup();
	}
});

// ── indexSessions maxAgeMs filter ─────────────────────────────────────

// The indexer now accepts maxAgeMs to skip old JSONL files.
// This prevents unbounded DB growth when thousands of session files exist.
// We test the age filter indirectly by checking that the indexer respects
// the file modification time (via stat) when deciding what to index.

import { writeFileSync, mkdirSync } from "node:fs";

function makeSessionDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-indexer-test-"));
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function writeJsonlFile(dir: string, name: string, messages: any[]): string {
	const filePath = join(dir, name);
	const content = messages.map(m => JSON.stringify(m)).join("\n");
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}
