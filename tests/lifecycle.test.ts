/**
 * Tests for Phase 1: session_start snapshot.
 *
 * getSessionSnapshot returns top user-target memories (preferences,
 * conventions, system specs) ranked by score. Read-time, no LLM.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { getSessionSnapshot, SNAPSHOT_TOP_K } from "../index.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-snapshot-test-"));
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

test("Phase 1: getSessionSnapshot returns top-5 user memories ranked by score", () => {
	const { store, cleanup } = makeStore();
	try {
		// Add 7 user memories. The 2 with lowest score should be dropped.
		store.createMemory({ content: "User prefers dark mode in all editors for work and reading sessions", scope: "global", target: "user", category: "preference" });
		store.createMemory({ content: "User prefers Vim keybindings and modal editing for code work", scope: "global", target: "user", category: "preference" });
		store.createMemory({ content: "Project uses tabs for indentation and snake_case for all function names in production", scope: "global", target: "project", category: "convention" });
		store.createMemory({ content: "User prefers Postgres over MySQL for relational database work and production deployments", scope: "global", target: "user", category: "preference" });
		store.createMemory({ content: "System runs Fedora 44 Workstation with Ryzen 7 6800H and 16GB RAM for development", scope: "global", target: "user", category: "convention" });
		store.createMemory({ content: "User prefers TypeScript for frontend development and Node.js backend services", scope: "global", target: "user", category: "preference" });
		store.createMemory({ content: "User prefers pytest for Python testing and unittest for embedded systems development", scope: "global", target: "user", category: "preference" });
		// Non-user memory — must NOT surface in snapshot
		store.createMemory({ content: "Tool bash fails 3 times in CI when network is slow during testing", scope: "global", target: "failure", category: "tool-quirk" });

		const snapshot = getSessionSnapshot({ global: store, project: null });
		assert.ok(snapshot, "snapshot should not be null when memories exist");
		assert.equal(snapshot.results.length, SNAPSHOT_TOP_K, "snapshot capped at top-K (5)");
		// All snapshot results must be user-target
		for (const r of snapshot.results) {
			assert.equal(r.memory.target, "user", "snapshot only surfaces user-target memories");
		}
		// Failure memory must NOT be in the snapshot
		for (const r of snapshot.results) {
			assert.ok(!r.memory.content.includes("Tool bash fails"), "non-user memory excluded");
		}
		// Counts should sum to results.length
		const counted = snapshot.counts.preferences + snapshot.counts.conventions;
		assert.equal(counted, snapshot.results.length, "counts sum to results");
	} finally {
		cleanup();
	}
});

test("Phase 1: getSessionSnapshot returns null when store has no user memories", () => {
	const { store, cleanup } = makeStore();
	try {
		// Only non-user memories
		store.createMemory({ content: "Tool bash fails 3 times in CI when network is slow during testing", scope: "global", target: "failure", category: "tool-quirk" });
		store.createMemory({ content: "Project uses TypeScript strict mode with all the strict flags enabled", scope: "global", target: "project", category: "convention" });

		const snapshot = getSessionSnapshot({ global: store, project: null });
		assert.equal(snapshot, null, "snapshot is null when no user-target memories exist");
	} finally {
		cleanup();
	}
});

test("Phase 1: getSessionSnapshot dedupes by ID across global and project stores", () => {
	const { store: globalStore, cleanup: gCleanup } = makeStore();
	const dir = mkdtempSync(join(tmpdir(), "dm-snap-proj-"));
	const project = new DreamStore(join(dir, "test.db"));
	try {
		// 1 user memory in global
		globalStore.createMemory({ content: "User prefers dark mode in all editors for code and reading work", scope: "global", target: "user", category: "preference" });
		// 2 user memories in project (different IDs, different content)
		project.createMemory({ content: "User prefers TypeScript for frontend and backend development and tooling", scope: "project", target: "user", category: "preference" });
		project.createMemory({ content: "User prefers Postgres for relational data storage in production deployments", scope: "project", target: "user", category: "preference" });

		const snapshot = getSessionSnapshot({ global: globalStore, project });
		assert.ok(snapshot);
		// All 3 unique memories (different IDs) surface
		const ids = snapshot.results.map((r) => r.memory.id);
		assert.equal(new Set(ids).size, ids.length, "no duplicate IDs across stores");
		assert.equal(snapshot.results.length, 3, "3 unique memories surfaced (1 global + 2 project)");
	} finally {
		project.close();
		rmSync(dir, { recursive: true, force: true });
		gCleanup();
	}
});

// ── Phase 2: session_shutdown breadcrumb ──

import { saveSessionBreadcrumb } from "../index.js";

test("Phase 2: saveSessionBreadcrumb returns null when disabled", () => {
	const { store, cleanup } = makeStore();
	try {
		const result = saveSessionBreadcrumb(store, "test-session-id", ["mem-1", "mem-2"], false);
		assert.equal(result, null, "returns null when saveBreadcrumbs disabled");
		assert.equal(store.listMemories({ limit: 10 }).length, 0, "no memory created");
	} finally {
		cleanup();
	}
});

test("Phase 2: saveSessionBreadcrumb returns null when no memories surfaced", () => {
	const { store, cleanup } = makeStore();
	try {
		const result = saveSessionBreadcrumb(store, "test-session-id", [], true);
		assert.equal(result, null, "returns null when no IDs");
	} finally {
		cleanup();
	}
});

test("Phase 2: saveSessionBreadcrumb creates session-scoped audit memory", () => {
	const { store, cleanup } = makeStore();
	try {
		// Pre-populate some memories to reference
		const m1 = store.createMemory({ content: "User prefers Vim for all editing work across projects", scope: "global", target: "user", category: "preference" });
		const m2 = store.createMemory({ content: "Project uses tabs for indentation and snake_case for all function names", scope: "global", target: "project", category: "convention" });

		const id = saveSessionBreadcrumb(store, "abc12345-session-xyz", [m1.id, m2.id], true);
		assert.ok(id, "returns breadcrumb id");

		const breadcrumb = store.getMemory(id!);
		assert.ok(breadcrumb);
		assert.equal(breadcrumb!.scope, "session", "scoped to session");
		assert.equal(breadcrumb!.scope_id, "abc12345-session-xyz", "tied to session id");
		assert.equal(breadcrumb!.category, "convention", "categorized as convention");
		assert.equal(breadcrumb!.tier, "operational", "tier is operational");
		// Verify content includes surfaced count and short id (first 8 chars)
		assert.ok(breadcrumb!.content.includes("2"), "content shows count");
		assert.ok(breadcrumb!.content.includes("abc12345"), "content shows session short id (first 8 chars)");

		// Verify metadata
		const meta = breadcrumb!.metadata as any;
		assert.equal(meta.session_summary, true, "metadata marks as session_summary");
		assert.equal(meta.surfaced_count, 2, "metadata shows surfaced count");
		assert.deepEqual(meta.surfaced_ids, [m1.id, m2.id], "metadata lists surfaced IDs");
	} finally {
		cleanup();
	}
});
