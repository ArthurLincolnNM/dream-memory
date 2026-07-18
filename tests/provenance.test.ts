/**
 * Tests for v1.6 provenance (source_session_id + source_turn_id).
 *
 * Covers:
 *   - schema migration adds columns to pre-existing DBs
 *   - createMemory accepts and persists both fields
 *   - createMemory without fields leaves them null
 *   - restoreMemory preserves provenance verbatim (rollback attribution)
 *   - formatRecallForInjection shows provenance="session:turn" attr when set
 *   - formatRecallForInjection OMITS the attr for legacy memories (null)
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DreamStore } from "../store/sqlite.js";
import { formatRecallForInjection } from "../recall/inject.js";
import type { SearchResult } from "../search/hybrid.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-prov-test-"));
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

/** Build a minimal SearchResult for inject tests (bypasses hybridSearch). */
function makeResult(memory: any, score = 1.0): SearchResult {
	return {
		memory,
		score,
		snippet: memory.content,
	};
}

// ── Schema migration ───────────────────────────────────────────────────

test("migration adds source_session_id and source_turn_id to a pre-existing DB", () => {
	const dir = mkdtempSync(join(tmpdir(), "dm-mig-test-"));
	const dbPath = join(dir, "legacy.db");
	try {
		// Build a v1.5-style DB by hand. This avoids parsing the current
		// schema (which has v1.6+ columns + indexes that would need to be
		// stripped — brittle as the schema evolves). The hardcoded schema
		// is intentionally a minimal subset of v1.5: enough columns for
		// the test's INSERT, plus the v1.5 essentials.
		const legacySchema = `
			CREATE TABLE memories (
				id TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				scope TEXT NOT NULL,
				scope_id TEXT,
				target TEXT NOT NULL,
				category TEXT,
				status TEXT NOT NULL DEFAULT 'active',
				tier TEXT NOT NULL DEFAULT 'factual',
				ttl_days INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_accessed_at INTEGER,
				access_count INTEGER DEFAULT 0,
				embedding BLOB,
				metadata TEXT,
				confidence TEXT DEFAULT 'explicit',
				utility_score REAL NOT NULL DEFAULT 0.0,
				expires_at INTEGER
			);
			CREATE INDEX idx_memories_status ON memories(status);
			CREATE INDEX idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;

			-- memory_versions: needed by runMigrations (checks column existence).
			CREATE TABLE memory_versions (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL,
				version_number INTEGER NOT NULL,
				content TEXT NOT NULL,
				scope TEXT NOT NULL,
				scope_id TEXT,
				target TEXT NOT NULL,
				category TEXT,
				status TEXT,
				tier TEXT NOT NULL,
				ttl_days INTEGER,
				metadata TEXT,
				action TEXT NOT NULL,
				session_id TEXT,
				batch_id TEXT,
				created_at INTEGER NOT NULL,
				content_hash TEXT NOT NULL
			);

			-- tool_usage: needed by runMigrations (checks error_preview/captured_at columns).
			CREATE TABLE tool_usage (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tool TEXT NOT NULL,
				args_hash TEXT NOT NULL,
				args_preview TEXT,
				timestamp INTEGER NOT NULL,
				session_id TEXT,
				success INTEGER NOT NULL DEFAULT 1
			);
		`;

		const legacyDb = new Database(dbPath);
		legacyDb.exec(legacySchema);
		legacyDb.prepare(
			`INSERT INTO memories (id, content, scope, target, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run("legacy-1", "Legacy memory without provenance", "global", "user", 1000, 1000);
		legacyDb.close();

		// Open with DreamStore — should trigger the v1.6 migration.
		const store = new DreamStore(dbPath);
		try {
			// Legacy row survives, with null provenance.
			const fetched = store.getMemory("legacy-1");
			assert.ok(fetched, "legacy row should survive migration");
			assert.equal(fetched!.source_session_id, undefined, "legacy row should have null session_id");
			assert.equal(fetched!.source_turn_id, undefined, "legacy row should have null turn_id");

			// New memory written AFTER migration accepts the fields.
			const newMem = store.createMemory({
				content: "New memory with provenance",
				scope: "global",
				target: "user",
				source_session_id: "sess-abc",
				source_turn_id: 3,
			});
			assert.equal(newMem.source_session_id, "sess-abc");
			assert.equal(newMem.source_turn_id, 3);
		} finally {
			store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── createMemory persistence ───────────────────────────────────────────

test("createMemory stores source_session_id and source_turn_id", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "Provenance test",
			scope: "global",
			target: "user",
			source_session_id: "sess-xyz",
			source_turn_id: 7,
		});
		assert.equal(mem.source_session_id, "sess-xyz");
		assert.equal(mem.source_turn_id, 7);

		// Round-trip through DB
		const fetched = store.getMemory(mem.id);
		assert.equal(fetched!.source_session_id, "sess-xyz");
		assert.equal(fetched!.source_turn_id, 7);
	} finally {
		cleanup();
	}
});

test("createMemory leaves provenance null when not provided", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "No provenance",
			scope: "global",
			target: "user",
		});
		assert.equal(mem.source_session_id, undefined);
		assert.equal(mem.source_turn_id, undefined);

		const fetched = store.getMemory(mem.id);
		assert.equal(fetched!.source_session_id, undefined);
		assert.equal(fetched!.source_turn_id, undefined);
	} finally {
		cleanup();
	}
});

test("createMemory: source_turn_id=0 is preserved (not coerced to null)", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "Turn 0 (e.g., pre-session memory)",
			scope: "global",
			target: "user",
			source_session_id: "sess-1",
			source_turn_id: 0,
		});
		// 0 is a valid value (pre-session memories); we should NOT coerce it
		// to null. The recall filter (memory.source_turn_id !== undefined)
		// distinguishes "explicitly set to 0" from "not set" via the
		// undefined check, not the truthy check.
		assert.equal(mem.source_turn_id, 0);
	} finally {
		cleanup();
	}
});

// ── restoreMemory preserves provenance ─────────────────────────────────

test("restoreMemory preserves provenance verbatim (rollback attribution)", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create, then delete, then restore
		const mem = store.createMemory({
			content: "Memory with provenance",
			scope: "global",
			target: "user",
			source_session_id: "original-sess",
			source_turn_id: 42,
		});
		store.deleteMemory(mem.id);
		store.restoreMemory(mem);
		const restored = store.getMemory(mem.id);
		assert.ok(restored);
		// Must NOT be re-stamped to the current session — a rollback is a
		// forensic operation, not a new event.
		assert.equal(restored!.source_session_id, "original-sess");
		assert.equal(restored!.source_turn_id, 42);
	} finally {
		cleanup();
	}
});

// ── formatRecallForInjection: provenance attr ──────────────────────────

test("formatRecallForInjection shows provenance attribute when set", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "Memory learned in session abc12345 at turn 5",
			scope: "global",
			target: "user",
			category: "preference",
			source_session_id: "abc12345-deadbeef",
			source_turn_id: 5,
		});

		const result = formatRecallForInjection([makeResult(mem)], {
			maxTokens: 1000,
			format: "xml",
		});

		// Session id is truncated to 8 chars in the output: "abc12345:5"
		assert.match(result, /provenance="abc12345:5"/, "should include provenance attr");
	} finally {
		cleanup();
	}
});

test("formatRecallForInjection omits provenance when null (legacy memories)", () => {
	const { store, cleanup } = makeStore();
	try {
		// Pre-v1.6 memory: no provenance
		const mem = store.createMemory({
			content: "Legacy memory without provenance",
			scope: "global",
			target: "user",
		});

		const result = formatRecallForInjection([makeResult(mem)], {
			maxTokens: 1000,
			format: "xml",
		});

		assert.doesNotMatch(result, /provenance=/, "should NOT include provenance attr for legacy memory");
	} finally {
		cleanup();
	}
});

test("formatRecallForInjection: session id is escaped (no XML injection)", () => {
	const { store, cleanup } = makeStore();
	try {
		// Defensive: an attacker who can write provenance values could try
		// to break out of the attribute and inject XML. The escapeXml
		// helper must neutralize quote/angle/ampersand characters.
		const mem = store.createMemory({
			content: "Memory with evil provenance",
			scope: "global",
			target: "user",
			source_session_id: `sess<"&'>`,
			source_turn_id: 1,
		});

		const result = formatRecallForInjection([makeResult(mem)], {
			maxTokens: 1000,
			format: "xml",
		});

		// The literal characters must NOT appear inside the attribute value
		assert.ok(!result.includes(`<"&'`), "raw evil chars should not appear in output");
		// But the escaped form should. Note: the `>` is sliced off by
		// slice(0, 8) on the session id (8 chars take only up to the
		// single-quote), so the output is missing &gt;.
		assert.match(result, /provenance="sess&lt;&quot;&amp;&apos;:1"/);
	} finally {
		cleanup();
	}
});

test("formatRecallForInjection: turn id with only session (no turn) omits provenance", () => {
	const { store, cleanup } = makeStore();
	try {
		// Defensive: if session is set but turn is undefined (corrupt state
		// from a future migration bug), we should NOT show a half-baked
		// provenance. Both-or-nothing.
		const mem = store.createMemory({
			content: "Session but no turn",
			scope: "global",
			target: "user",
			source_session_id: "sess-only",
			// source_turn_id deliberately omitted
		});

		const result = formatRecallForInjection([makeResult(mem)], {
			maxTokens: 1000,
			format: "xml",
		});

		assert.doesNotMatch(result, /provenance=/);
	} finally {
		cleanup();
	}
});
