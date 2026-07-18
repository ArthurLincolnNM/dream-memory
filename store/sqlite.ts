/**
 * dream-memory/store/sqlite.ts
 * SQLite storage layer for dream-memory
 */

import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_CATEGORIES } from "../utils/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── F1: Typed linked_to ──
/** A typed link between two memories. */
export interface LinkedMemory {
	id: string;
	/** Relationship type from EDGE_TYPE_RULES in constants.ts */
	relation: string;
	/** When this link was created (epoch ms) */
	since?: number;
}

/**
 * Normalize a linked_to value to the typed format.
 * Handles both legacy string[] and new LinkedMemory[].
 */
export function normalizeLinkedTo(value: unknown): LinkedMemory[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => {
		if (typeof item === "string") {
			// Legacy format: just an id string
			return { id: item, relation: "related_to" };
		}
		if (item && typeof item === "object" && typeof (item as any).id === "string") {
			return {
				id: item.id,
				relation: (item as any).relation || "related_to",
				...(item as any).since ? { since: (item as any).since } : {},
			};
		}
		return null;
	}).filter((x): x is LinkedMemory => x !== null);
}

export interface Memory {
	id: string;
	content: string;
	scope: "global" | "project" | "agent" | "session";
	scope_id?: string;
	target: "user" | "memory" | "project" | "failure";
	category?: (typeof MEMORY_CATEGORIES)[number];
	status: "active" | "resolved" | "superseded";
	tier: "factual" | "operational";
	ttl_days?: number;
	created_at: number;
	updated_at: number;
	last_accessed_at?: number;
	access_count: number;
	embedding?: Buffer;
	metadata?: Record<string, any>;
	/**
	 * v1.6 provenance: which session learned this memory. Null for memories
	 * created before provenance was added. The session id is the same id Pi
	 * exposes via `ctx.sessionManager.getSessionId()`.
	 */
	source_session_id?: string;
	/**
	 * v1.6 provenance: which turn (1-indexed) within the session. A "turn"
	 * is one user message + the assistant response. Null when session id is
	 * null (same backward-compat semantics as source_session_id).
	 */
	source_turn_id?: number;
	/**
	 * Provenance: distinguishes memory origin for reliability assessment.
	 * - explicit: user stated directly
		* inferred: pattern detected (auto-capture, trajectory analysis)
		* outdated: contradicted by more recent memory
		* synthesized: consolidated by /dream synthesis
	 */
	confidence?: "explicit" | "inferred" | "outdated" | "synthesized";
	/**
	 * v2.0 Trust Hierarchy (inspired by YesMem's 4-tier trust model).
	 * Numeric trust level that determines how much weight a memory carries
	 * when conflicts arise. Higher = more trustworthy.
	 *
	 *   3 = user_stated  — user said it directly (highest trust)
	 *   2 = agreed_upon  — user confirmed or agent suggested + user accepted
	 *   1 = llm_suggested — agent suggested, no explicit confirmation
	 *   0 = llm_extracted — auto-captured from tool usage (lowest trust)
	 *
	 * Used by:
	 *   - Contradiction resolution: higher trust wins by default
	 *   - Decay: higher trust decays slower
	 *   - Recall injection: surfaced in XML for agent reasoning
	 */
	trust_level?: number;
	/**
	 * Materialized expiration timestamp (epoch ms). NULL = permanent (no TTL).
	 * Populated by createMemory/updateMemory; populated from the DB by parseRow
	 * via `...row` spread. The TTL sweep queries `WHERE expires_at < ?` using
	 * the partial index `idx_memories_expires`, which is only built for non-NULL
	 * rows.
	 */
	expires_at?: number | null;
	/**
	 * Recall utility signal (F3). Bounded roughly in [-1, 1]:
	 *   0.05 boost when the memory was in the last recall and the agent's
	 *     next tool call used the memory's content (implicit positive).
	 *  -0.10 penalty when a contradiction was discarded (memory was wrong).
	 * Used by the decay module as an additional multiplier: high utility
	 * keeps the memory in recall longer; negative utility fast-tracks it
	 * for replacement by new content.
	 */
	utility_score?: number;
	/**
	 * v1.7: memory kind. Distinguishes concrete past events (episodic)
	 * from abstracted knowledge (semantic). Aligns with arXiv 2606.24775's
	 * memory taxonomy and the Cognee/MemOS separation of "episodic vs
	 * semantic" memory layers. Affects decay (episodic decays faster by
	 * design — one-time events lose relevance quickly) and recall budget
	 * (episodic can be deprioritized when recall is saturated).
	 *
	 * - episodic: a concrete event captured in time (auto-captured tool
	 *   failure, single-session observation). TTL defaults to 30d.
	 * - semantic: an abstracted fact or principle (user preference,
	 *   project convention, synthesized knowledge). TTL long/permanent.
	 *
	 * Default 'semantic' on legacy rows (NULL treated as semantic).
	 */
	memory_kind?: "episodic" | "semantic";
	/**
	 * v1.8: free-form tags. Optional JSON array of strings. Orthogonal to
	 * the 6 fixed categories. Used for project-specific domains that
	 * don't fit the category taxonomy (e.g., "rust", "postgres", "ui",
	 * "api", "frontend"). Empty array = no tags. Stored as JSON-encoded
	 * TEXT in the `tags` column. Search supports filtering by tag
	 * intersection (a memory must have ALL specified tags to match).
	 */
	tags?: string[];
	/**
	 * v2.1: Ebbinghaus decay — stability multiplier. Higher = decays slower.
	 * Grows ×1.5 on each reinforcement (use in recall). Default 14 (baseline).
	 */
	stability?: number;
	/**
	 * v2.1: Number of times this memory was reinforced (used in recall + utility boost).
	 */
	reinforcement_count?: number;
	/**
	 * v2.1: Timestamp of last reinforcement.
	 */
	last_reinforced?: number;
	/**
	 * v2.2: Temporal validity window (Graphiti-inspired).
	 * valid_from: when this fact became true (epoch ms). Defaults to created_at.
	 * valid_until: when this fact was superseded (epoch ms). NULL = still valid.
	 * 
	 * For factual memories: valid_until replaces "superseded" status.
	 * A fact is valid if: valid_from <= now AND (valid_until IS NULL OR valid_until > now).
	 * 
	 * For operational memories: TTL still controls expiry (valid_until stays NULL).
	 */
	valid_from?: number;
	valid_until?: number | null;
	/**
	 * v2.3: Stable topic key for upsert (same topic → update, not duplicate).
	 * Format: "category:entity1:entity2" (sorted, lowercase).
	 */
topic_key?: string;
}

export interface ToolUsage {
	id?: number;
	tool: string;
	args_hash: string;
	args_preview: string;
	timestamp: number;
	session_id?: string;
	success: boolean;
}

export interface MemoryVersion {
	id: string;
	memory_id: string;
	version_number: number;
	content: string;
	scope: string;
	scope_id?: string;
	target: string;
	category?: string;
	status?: string;
	tier: string;
	ttl_days?: number;
	metadata?: Record<string, any>;
	action: "create" | "update" | "delete";
	session_id?: string;
	batch_id?: string;
	created_at: number;
	content_hash: string;
}

export class DreamStore {
	private db: Database.Database;
	/**
	 * Per-instance cache of `df` (document frequency) for FTS5 tokens, used
	 * by `searchByQuery` to compute IDF without re-querying the FTS5 index on
	 * every search. Invalidated by `invalidateIdfCache` whenever the memories
	 * table mutates. The cache is instance-scoped (not shared across stores
	 * or processes), so it doesn't survive session restarts — which is fine,
	 * the first search after a restart warms it up.
	 */
	private idfCache: Map<string, number> = new Map();

	/** Absolute path of the underlying SQLite file. Exposed via getDbPath() for diagnostics and cleanup helpers. */
	private readonly dbPath: string;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("foreign_keys = ON");
		this.initialize();
	}

	/**
	 * Public getter for the SQLite file path. Used by `store/cleanup.ts` to
	 * measure pre/post clean bytes without needing fs imports in hot paths.
	 */
	getDbPath(): string {
		return this.dbPath;
	}

	private initialize(): void {
		// Detect fresh DB: no memories table means schema hasn't run yet.
		const tables = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
			.all() as any[];
		const isFresh = tables.length === 0;

		if (!isFresh) {
			// Existing DB: run migrations FIRST so new columns exist before
			// schema creates indexes that reference them.
			this.runMigrations();
		}

		const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
		this.db.exec(schema);

		if (isFresh) {
			// Fresh DB: schema created tables, now run migrations to add
			// columns added after the base schema (stability, etc.).
			this.runMigrations();
		}
	}

	/**
	 * Run migrations for existing DBs that predate schema changes.
	 * Each migration is idempotent — safe to run multiple times.
	 * Safe for empty DBs (no-op if table doesn't exist).
	 */
	private runMigrations(): void {
		// Check if memories table exists at all (it may not on a fresh DB)
		const tables = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
			.all() as any[];
		if (tables.length === 0) {
			// Fresh DB - schema will create everything correctly
			return;
		}

		// Migration: add 'status' column to memories (v1.0)
		// Source/status fields were added; existing DBs need ALTER TABLE.
		const cols = this.db.prepare("PRAGMA table_info(memories)").all() as any[];
		const hasStatus = cols.some((c: any) => c.name === "status");
		if (!hasStatus) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
		}

		// Migration: add 'status' column to memory_versions (v1.0)
		const vcols = this.db.prepare("PRAGMA table_info(memory_versions)").all() as any[];
		const vHasStatus = vcols.some((c: any) => c.name === "status");
		if (!vHasStatus) {
			this.db.exec(`ALTER TABLE memory_versions ADD COLUMN status TEXT`);
		}

		// Migration: create status index if missing (v1.0)
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)`);

		// Migration: add 'batch_id' column to memory_versions (v1.1)
		// Used for batch-revert feature - groups consecutive adds as atomic unit
		const vHasBatch = vcols.some((c: any) => c.name === "batch_id");
		if (!vHasBatch) {
			this.db.exec(`ALTER TABLE memory_versions ADD COLUMN batch_id TEXT`);
		}
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_versions_batch ON memory_versions(batch_id)`);

		// Migration: add 'error_preview' column to tool_usage (v1.2)
		// Used by auto-capture to record error context for failure patterns
		const toolCols = this.db.prepare("PRAGMA table_info(tool_usage)").all() as any[];
		const hasErrorPreview = toolCols.some((c: any) => c.name === "error_preview");
		if (toolCols.length > 0 && !hasErrorPreview) {
			this.db.exec(`ALTER TABLE tool_usage ADD COLUMN error_preview TEXT`);
		}

		// Migration: add 'captured_at' column to tool_usage (v1.3)
		// Used by auto-capture to mark rows that have already been turned into a memory.
		// Without this, /dream-purge creates a loop: delete temp memory → next tool call
		// re-detects the same 5+ tool_usage hits → re-creates the memory. Marking rows
		// as captured breaks the loop: detectToolSignals only counts UNcaptured rows.
		const hasCapturedAt = toolCols.some((c: any) => c.name === "captured_at");
		if (toolCols.length > 0 && !hasCapturedAt) {
			this.db.exec(`ALTER TABLE tool_usage ADD COLUMN captured_at INTEGER`);
		}
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_usage_captured ON tool_usage(captured_at)`);

		// Migration: add 'expires_at' column to memories (v1.4)
		// Previous TTL query was non-sargable:
		//   WHERE (updated_at + ttl_days * 86400000) < ?
		// The expression in the WHERE forced a full SCAN even with the existing
		// `idx_memories_ttl(ttl_days, updated_at)` index. Materializing the
		// expiry as a column lets us query `WHERE expires_at < ?` which uses
		// a partial index (NULL = permanent, excluded from the index entirely).
		// Backfill computes the column from existing data so the query returns
		// identical results to the old SQL.
		const memCols = this.db.prepare("PRAGMA table_info(memories)").all() as any[];
		const hasExpiresAt = memCols.some((c: any) => c.name === "expires_at");
		if (memCols.length > 0 && !hasExpiresAt) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN expires_at INTEGER`);
		}
		// Backfill: idempotent — only fills rows where expires_at is NULL but
		// ttl_days is set. Safe to run on every migration: it's a no-op once
		// the data is populated, AND it recovers from a partial previous run
		// where the column was added but the UPDATE was interrupted.
		this.db.exec(`
			UPDATE memories
			SET expires_at = updated_at + ttl_days * 86400000
			WHERE ttl_days IS NOT NULL AND expires_at IS NULL
		`);
		// Partial index on the materialized column. Idempotent: CREATE INDEX
		// IF NOT EXISTS. The WHERE clause in the index definition matches the
		// query's WHERE, so the planner can use this index for
		// `WHERE expires_at IS NOT NULL AND expires_at < ?` automatically.
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_memories_expires
			ON memories(expires_at)
			WHERE expires_at IS NOT NULL
		`);

		// Migration: add 'confidence' column to memories (v1.5)
		// Provenance tracking: distinguishes explicitly stated facts from inferred patterns
		// and synthesized knowledge. Maps to Memanto's D3 desiderata.
		const hasConfidence = memCols.some((c: any) => c.name === "confidence");
		if (memCols.length > 0 && !hasConfidence) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN confidence TEXT DEFAULT 'explicit'`);
		}
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence)`);

		// Migration: add 'utility_score' column to memories (F3 — recall feedback)
		// Defaults to 0.0. Adjusted by the recall path: +0.05 when a memory
		// was in the recall and the next tool call used the agent's advice
		// (implicit positive signal). -0.10 when a contradiction was
		// discarded (the memory was wrong / outdated). The decay module
		// uses this as an additional multiplier so a useful memory
		// survives recall longer; a wrong one decays faster.
		const hasUtility = memCols.some((c: any) => c.name === "utility_score");
		if (memCols.length > 0 && !hasUtility) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN utility_score REAL NOT NULL DEFAULT 0.0`);
		}

		// Migration: provenance columns (v1.6) — Perplexity Brain / Nabu style
		// citation. Both columns are nullable: existing memories stay NULL
		// (no provenance backfill possible — the original session is gone),
		// and new memories get populated by the add path. The partial index
		// keeps the index small by excluding the (large) NULL set.
		const hasSourceSession = memCols.some((c: any) => c.name === "source_session_id");
		if (memCols.length > 0 && !hasSourceSession) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN source_session_id TEXT`);
		}
		const hasSourceTurn = memCols.some((c: any) => c.name === "source_turn_id");
		if (memCols.length > 0 && !hasSourceTurn) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN source_turn_id INTEGER`);
		}
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_memories_provenance
			ON memories(source_session_id, source_turn_id)
			WHERE source_session_id IS NOT NULL
		`);

		// Migration: add 'memory_kind' column (v1.7) — episodic vs semantic
		// distinction. Maps to arXiv 2606.24775 taxonomy and Cognee's
		// "episodic vs semantic" memory layers. Default 'semantic' is the
		// safe choice for legacy rows (they're knowledge, not events). The
		// index supports future filtering like "skip episodic in recall"
		// without scanning the whole table.
		const hasMemoryKind = memCols.some((c: any) => c.name === "memory_kind");
		if (memCols.length > 0 && !hasMemoryKind) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN memory_kind TEXT DEFAULT 'semantic'`);
		}
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(memory_kind)`);

		// Migration: add 'mytags' column (v1.8) — optional JSON array of
		// free-form mytags. Orthogonal to category. Default '[]' for legacy
		// rows (no mytags). Search supports filtering by label intersection
		// (memory must have ALL specified mytags). Index is a btree on the
		// raw column; JSON1 functions operate on it directly. (Column
		// renamed from "tags" to "mytags" because "tags" is a future-
		// reserved word in SQLite that triggered parse errors. The
		// TypeScript field is still `tags` for API compatibility.)
		const hasLabels = memCols.some((c: any) => c.name === "mytags");
		if (memCols.length > 0 && !hasLabels) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN mytags TEXT DEFAULT '[]'`);
		}
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_mytags ON memories(mytags)`);

		// v2.0: Trust Hierarchy (inspired by YesMem 4-tier model)
		// trust_level determines how much weight a memory carries in conflicts.
		// Default 2 (= agreed_upon) — safe for legacy rows.
		const hasTrustLevel = memCols.some((c: any) => c.name === "trust_level");
		if (memCols.length > 0 && !hasTrustLevel) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN trust_level INTEGER DEFAULT 2`);
		}
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_trust ON memories(trust_level)`);

		// v2.1: Ebbinghaus decay — stability + reinforcement tracking
		// stability: resistance to decay (higher = decays slower)
		// reinforcement_count: how many times the memory was used in recall
		// last_reinforced: timestamp of last reinforcement
		const hasStability = memCols.some((c: any) => c.name === "stability");
		if (memCols.length > 0 && !hasStability) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN stability REAL DEFAULT 14`);
		}
		const hasReinforcementCount = memCols.some((c: any) => c.name === "reinforcement_count");
		if (memCols.length > 0 && !hasReinforcementCount) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN reinforcement_count INTEGER DEFAULT 0`);
		}
		const hasLastReinforced = memCols.some((c: any) => c.name === "last_reinforced");
		if (memCols.length > 0 && !hasLastReinforced) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN last_reinforced INTEGER`);
		}

		// v2.2: Temporal validity (Graphiti-inspired)
		// valid_from: when this fact became true (epoch ms)
		// valid_until: when this fact was superseded (epoch ms, NULL = still valid)
		// For factual memories: valid_until replaces the old "superseded" status
		// For operational memories: TTL still controls expiry
		const hasValidFrom = memCols.some((c: any) => c.name === "valid_from");
		if (memCols.length > 0 && !hasValidFrom) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN valid_from INTEGER`);
		}
		const hasValidUntil = memCols.some((c: any) => c.name === "valid_until");
		if (memCols.length > 0 && !hasValidUntil) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN valid_until INTEGER`);
		}
		// Backfill: set valid_from = created_at for existing memories
		this.db.exec(`
			UPDATE memories
			SET valid_from = created_at
			WHERE valid_from IS NULL
		`);
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_valid_from ON memories(valid_from)`);
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_valid_until ON memories(valid_until) WHERE valid_until IS NOT NULL`);

		// v2.3: Topic Key — stable key for upsert (same topic → update, not duplicate)
		const hasTopicKey = memCols.some((c: any) => c.name === "topic_key");
		if (memCols.length > 0 && !hasTopicKey) {
			this.db.exec(`ALTER TABLE memories ADD COLUMN topic_key TEXT`);
		}
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_topic_key ON memories(topic_key) WHERE topic_key IS NOT NULL`);
	}

	// ── Memory CRUD ──────────────────────────────────────────────────────

	createMemory(params: {
		content: string;
		scope: Memory["scope"];
		scope_id?: string;
		target: Memory["target"];
		category?: Memory["category"];
		status?: Memory["status"];
		tier?: Memory["tier"];
		ttl_days?: number;
		metadata?: Record<string, any>;
		confidence?: Memory["confidence"];
		utility_score?: number;
		/** v1.6 provenance: which session learned this memory. */
		source_session_id?: string;
		/** v1.6 provenance: which turn within the session (1-indexed). */
		source_turn_id?: number;
		/**
		 * v1.7: episodic vs semantic. Defaults to 'semantic' when omitted
		 * (safe for callers that haven't been updated yet). Auto-capture
		 * passes 'episodic'; synthesis passes 'semantic'; user-stated facts
		 * default to 'semantic' (the value is already an abstraction).
		 */
		memory_kind?: Memory["memory_kind"];
		/**
		 * v1.8: free-form tags. JSON-encoded in the tags column. Defaults
		 * to '[]' (no tags) when omitted.
		 */
		tags?: string[];
		/**
		 * v2.0: trust_level. Numeric trust level (0-3). Defaults to 2
		 * (agreed_upon) when omitted — safe for legacy callers.
		 */
		trust_level?: number;
	/** v2.2: when this fact became true (epoch ms). Defaults to now. */
	valid_from?: number;
	/** v2.2: when this fact was superseded (epoch ms). NULL = still valid. */
	valid_until?: number | null;
	/** v2.3: stable topic key for upsert. */
	topic_key?: string;
	}): Memory {
		// Validate content: reject empty / whitespace-only
		if (typeof params.content !== "string" || params.content.trim() === "") {
			throw new Error("Memory content cannot be empty or whitespace-only");
		}

		// Validate ttl_days: reject NaN, Infinity, or non-finite values
		if (params.ttl_days !== undefined && params.ttl_days !== null) {
			if (!Number.isFinite(params.ttl_days)) {
				throw new Error(`Memory ttl_days must be a finite number, got: ${params.ttl_days}`);
			}
		}

		const now = Date.now();
		const id = randomUUID();

		// Compute expires_at: NULL for permanent memories (ttl_days is null),
		// otherwise now + ttl_days*86400000. ttl_days=0 means "already expired
		// at creation time" — expires_at equals `now`, which is in the past
		// the moment the row is committed, so the next TTL sweep deletes it.
		const ttlDays = params.ttl_days === undefined ? null : params.ttl_days;
		const expiresAt = ttlDays !== null ? now + ttlDays * 86400000 : null;

		const stmt = this.db.prepare(`
			INSERT INTO memories (id, content, scope, scope_id, target, category, status, tier, ttl_days, created_at, updated_at, metadata, expires_at, confidence, utility_score, source_session_id, source_turn_id, memory_kind, mytags, trust_level, stability, reinforcement_count, last_reinforced, valid_from, valid_until, topic_key)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 14, 0, NULL, ?, ?, ?)
		`);

		stmt.run(
			id,
			params.content,
			params.scope,
			params.scope_id === undefined ? null : params.scope_id,
			params.target,
			params.category === undefined ? null : params.category,
			params.status || "active",
			params.tier || "factual",
			// ttl_days=0 is a valid value (immediately expired). Use ?? not || to avoid 0→null bug.
			ttlDays,
			now,
			now,
			params.metadata ? JSON.stringify(params.metadata) : null,
			expiresAt,
			params.confidence || "explicit",
			// utility_score defaults to 0.0; callers can pass it explicitly
			// for restore operations that should preserve the original signal.
			typeof params.utility_score === "number" ? params.utility_score : 0.0,
			// Provenance: both nullable. Accept undefined as null so callers
			// that don't track provenance (synthesis, restore, auto-capture
			// from older code paths) don't have to set these explicitly.
			params.source_session_id === undefined ? null : params.source_session_id,
			params.source_turn_id === undefined ? null : params.source_turn_id,
			// v1.7: default 'semantic' (safe for legacy callers). Auto-capture
			// explicitly passes 'episodic'; synthesis passes 'semantic'.
			params.memory_kind || "semantic",
			// v1.8: tags as JSON array. Empty array when not provided.
			params.tags && params.tags.length > 0 ? JSON.stringify(params.tags) : "[]",
			// v2.0: trust_level. Default 2 (agreed_upon) — safe for legacy callers.
			typeof params.trust_level === "number" ? params.trust_level : 2,
			// v2.2: valid_from defaults to creation time, valid_until defaults to NULL
		params.valid_from ?? now,
		params.valid_until ?? null,
		params.topic_key ?? null,
		);


		const memory = this.getMemory(id)!;
		this.createVersion(memory, "create");
		// Invalidate IDF cache: the new memory's content introduces tokens
		// whose `df` may have changed.
		this.invalidateIdfCache();

		return memory;
	}

	/**
	 * Find a memory by its topic_key and scope.
	 * Used for upsert: if a memory with the same topic_key exists in the same
	 * scope, update it instead of creating a new one.
	 */
	findByTopicKey(topicKey: string, scope: string, scopeId?: string): Memory | null {
		const row = this.db.prepare(
			`SELECT * FROM memories WHERE topic_key = ? AND scope = ? AND scope_id ${scopeId ? "= ?" : "IS NULL"} AND status != 'superseded' LIMIT 1`
		).get(...(scopeId ? [topicKey, scope, scopeId] : [topicKey, scope])) as any;
		return row ? this.parseRow(row) : null;
	}

	/**
	 * Re-insert a previously-deleted memory with its original id.
	 *
	 * Used by batch rollback to undo a delete operation: the version history
	 * has the pre-delete content but the row is gone from `memories`. We
	 * re-insert with the original id (so any `linked_to`, `synthesizedFrom`,
	 * `consolidatedInto` references remain valid), preserving the original
	 * `created_at` (so the memory doesn't appear as a fresh insert in time-
	 * based queries).
	 *
	 * IMPORTANT: this is the inverse of `deleteMemory`. The newly-inserted
	 * row gets a fresh `updated_at` and a fresh `create` version entry. The
	 * audit trail in `memory_versions` shows both the original create, the
	 * delete, and now a re-create — which is the correct forensic record
	 * for "this was rolled back".
	 */
	restoreMemory(memory: Memory): Memory {
		const now = Date.now();
		const ttlDays = memory.ttl_days === undefined ? null : memory.ttl_days;
		const expiresAt = ttlDays !== null ? now + ttlDays * 86400000 : null;

		// INSERT with the explicit id. If a row already exists at this id
		// (shouldn't happen if the caller verified the memory is gone), the
		// INSERT fails and we throw — the caller can decide whether to skip
		// the restore or surface the error.
		this.db
			.prepare(
				`INSERT INTO memories (id, content, scope, scope_id, target, category, status, tier, ttl_days, created_at, updated_at, metadata, expires_at, confidence, utility_score, source_session_id, source_turn_id, memory_kind, mytags, trust_level, stability, reinforcement_count, last_reinforced)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 14, 0, NULL)`,
			)
			.run(
				memory.id,
				memory.content,
				memory.scope,
				memory.scope_id ?? null,
				memory.target,
				memory.category ?? null,
				memory.status,
				memory.tier,
				ttlDays,
				memory.created_at, // preserve original
				now, // updated_at is fresh (the restore is a real edit)
				memory.metadata ? JSON.stringify(memory.metadata) : null,
				expiresAt,
				memory.confidence || "explicit",
				memory.utility_score ?? 0.0,
				// Provenance is preserved verbatim from the pre-delete row.
				// A rollback should restore the SAME attribution, not
				// re-stamp the current session/turn.
				memory.source_session_id ?? null,
				memory.source_turn_id ?? null,
				// v1.7: memory_kind
				memory.memory_kind || "semantic",
				// v1.8: tags
				memory.tags && memory.tags.length > 0 ? JSON.stringify(memory.tags) : "[]",
				// v2.0: trust_level
				memory.trust_level ?? 2,
			);

		const restored = this.getMemory(memory.id)!;
		this.createVersion(restored, "create");
		this.invalidateIdfCache();

		return restored;
	}

	getMemory(id: string): Memory | null {
		const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
		if (!row) return null;
		return this.parseRow(row);
	}

	listMemories(
		options: {
			scope?: Memory["scope"];
			scope_id?: string;
			target?: Memory["target"];
			category?: Memory["category"];
			status?: Memory["status"];
			tier?: Memory["tier"];
			limit?: number;
			sortBy?: "created_at" | "updated_at" | "last_accessed_at";
			sortOrder?: "asc" | "desc";
			/**
			 * F4 (dream delta): filter to memories updated at or after this
			 * epoch ms. Used by /dream in delta mode to process only the
			 * memories created/changed since the last dream run, instead
			 * of re-clustering the entire corpus on every manual dream.
			 */
			since?: number;
		} = {},
	): Memory[] {
		let sql = "SELECT * FROM memories WHERE 1=1";
		const params: any[] = [];

		if (options.scope) {
			sql += " AND scope = ?";
			params.push(options.scope);
		}
		if (options.scope_id) {
			sql += " AND scope_id = ?";
			params.push(options.scope_id);
		}
		if (options.target) {
			sql += " AND target = ?";
			params.push(options.target);
		}
		if (options.category) {
			sql += " AND category = ?";
			params.push(options.category);
		}
		if (options.status) {
			sql += " AND status = ?";
			params.push(options.status);
		}
		if (options.tier) {
			sql += " AND tier = ?";
			params.push(options.tier);
		}
		if (options.since !== undefined) {
			// Updated_at is bumped on every edit, so this catches both
			// creates AND updates since the last dream run.
			sql += " AND updated_at >= ?";
			params.push(options.since);
		}

		const sortBy = options.sortBy || "updated_at";
		const sortOrder = options.sortOrder || "desc";
		sql += ` ORDER BY ${sortBy} ${sortOrder}`;

		if (options.limit !== undefined) {
			// Coerce to non-negative integer. SQLite's LIMIT binding rejects
			// non-integer numerics with "datatype mismatch". Strings (e.g. "5")
			// are also rejected. Negative becomes 0 (no rows).
			const coerced = this.coerceLimit(options.limit);
			if (coerced === 0) {
				return []; // Honor limit=0 explicitly
			}
			sql += " LIMIT ?";
			params.push(coerced);
		}

		const rows = this.db.prepare(sql).all(...params) as any[];
		return rows.map((r) => this.parseRow(r));
	}

	updateMemory(
		id: string,
		params: {
			content?: string;
			scope?: Memory["scope"];
			scope_id?: string;
			target?: Memory["target"];
			category?: Memory["category"];
			status?: Memory["status"];
			tier?: Memory["tier"];
			ttl_days?: number;
			metadata?: Record<string, any>;
			confidence?: Memory["confidence"];
			/**
			 * Manually set last_accessed_at. Useful for tests, GC
			 * simulations, or explicit "this memory was just consulted"
			 * signals from the agent. Null clears the field.
			 */
			last_accessed_at?: number | null;
			/**
			 * Manually set updated_at. Normally auto-set to now() on every
			 * update. Set explicitly only for tests or to backdate a
			 * memory (e.g., to simulate it being old for GC testing).
			 */
			updated_at?: number;
			/**
			 * v2.0: trust_level. Numeric trust level (0-3).
			 */
			trust_level?: number;
		},
	): Memory | null {
		const existing = this.getMemory(id);
		if (!existing) return null;

		const now = Date.now();
		const updates: string[] = [];
		const values: any[] = [];

		if (params.content !== undefined) {
			updates.push("content = ?");
			values.push(params.content);
		}
		if (params.scope !== undefined) {
			updates.push("scope = ?");
			values.push(params.scope);
		}
		if (params.scope_id !== undefined) {
			updates.push("scope_id = ?");
			values.push(params.scope_id);
		}
		if (params.target !== undefined) {
			updates.push("target = ?");
			values.push(params.target);
		}
		if (params.category !== undefined) {
			updates.push("category = ?");
			values.push(params.category);
		}
		if (params.status !== undefined) {
			updates.push("status = ?");
			values.push(params.status);
		}
		if (params.tier !== undefined) {
			updates.push("tier = ?");
			values.push(params.tier);
		}
		if (params.ttl_days !== undefined) {
			updates.push("ttl_days = ?");
			values.push(params.ttl_days);
		}
		if (params.metadata !== undefined) {
			updates.push("metadata = ?");
			values.push(JSON.stringify(params.metadata));
		}
		if (params.confidence !== undefined) {
			updates.push("confidence = ?");
			values.push(params.confidence);
		}
		if (params.trust_level !== undefined) {
			updates.push("trust_level = ?");
			values.push(params.trust_level);
		}
		if (params.last_accessed_at !== undefined) {
			updates.push("last_accessed_at = ?");
			values.push(params.last_accessed_at);
		}
		if (params.updated_at !== undefined) {
			updates.push("updated_at = ?");
			values.push(params.updated_at);
		}

		if (updates.length === 0) return existing;

		// Extract batchId from new metadata (if any) to tag the version
		const batchId = (params.metadata as any)?.batchId;

		// Create version before update - use new batchId if provided
		this.createVersion(existing, "update", undefined, batchId);

		// Recompute expires_at to match the new ttl_days (if any) and the new
		// updated_at (= now). This matches the old behavior where the TTL
		// clock resets on every update. We always recompute (not just when
		// ttl_days changes) because updated_at is always bumped below.
		// Using `params.ttl_days ?? existing.ttl_days` keeps the existing
		// ttl when the caller didn't pass one.
		const effectiveTtl = params.ttl_days !== undefined ? params.ttl_days : existing.ttl_days;
		const newExpiresAt = effectiveTtl !== null && effectiveTtl !== undefined
			? now + effectiveTtl * 86400000
			: null;

		// Push updates/values IN THE SAME ORDER. The `id` for the WHERE clause
		// must be the LAST value in the array — earlier code pushed `id` before
		// `newExpiresAt`, which made SQLite bind the id to expires_at and the
		// expires_at to WHERE id, silently corrupting the update.
		// updated_at defaults to now(); explicit param overrides (used by tests
		// and GC backdating).
		updates.push("updated_at = ?");
		values.push(params.updated_at !== undefined ? params.updated_at : now);
		updates.push("expires_at = ?");
		values.push(newExpiresAt);
		values.push(id);

		this.db.prepare(`UPDATE memories SET ${updates.join(", ")} WHERE id = ?`).run(...values);

		// Invalidate IDF cache: content/scope/category may have changed,
		// affecting the `df` of any tokens in the new content.
		this.invalidateIdfCache();

		return this.getMemory(id);
	}

	/**
	 * Set the embedding for a memory. Intentionally separate from
	 * `updateMemory`: the embedding is a DERIVED field (computed from
	 * content), not a logical edit. It should not:
	 *   - bump `updated_at` (which would falsely extend the TTL clock and
	 *     reset the decay curve)
	 *   - create a memory version entry (the audit log should reflect
	 *     content changes, not ML pipeline side-effects)
	 *   - invalidate the IDF cache (tokens haven't changed)
	 *
	 * Pass `null` to clear the embedding (e.g., on content rewrite where
	 * the old vector no longer matches). Returns true on success, false
	 * if the memory id doesn't exist.
	 */
	updateEmbedding(id: string, embedding: Buffer | null): boolean {
		const existing = this.getMemory(id);
		if (!existing) return false;
		this.db.prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(embedding, id);
		return true;
	}

	deleteMemory(id: string): boolean {
		const existing = this.getMemory(id);
		if (!existing) return false;

		// Create version before delete
		this.createVersion(existing, "delete");

		this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
		// Invalidate IDF cache: removing the memory changes `df` for its tokens.
		this.invalidateIdfCache();

		return true;
	}

	/**
	 * Move a memory to a different .db file (cross-store).
	 *
	 * Why: contradiction resolution can pick a replacement scope different from
	 * the existing memory's scope. With per-repo banks (global.db + project.db),
	 * that means a row may need to live in a different physical file. A naive
	 * `updateMemory` would rewrite the scope/scope_id fields in place, leaving
	 * the row in the wrong file and breaking the invariant "scope=X lives in
	 * store X". This method atomically moves the row across files, preserving
	 * its ID and version history link.
	 *
	 * Implementation: ATTACH the destination DB into this connection and use a
	 * single transaction. The destination's existing triggers (memories_ai/ad/au)
	 * fire as we INSERT/DELETE in attached.memories, keeping FTS5 consistent.
	 *
	 * Atomicity: ATTACHed DBs share the connection's transaction. If anything
	 * fails mid-move (network, disk, constraint violation), the rollback
	 * restores BOTH sides to their pre-move state. No half-moved rows.
	 *
	 * Rowid handling: FTS5 uses external content (`content=memories,
	 * content_rowid=rowid`), so we MUST preserve the source rowid in the
	 * destination. If the destination already has a memory at that rowid
	 * (different id, same auto-incremented rowid), we DELETE it first — the
	 * explicit DELETE fires the FTS5 delete trigger properly. (Tested:
	 * `INSERT OR REPLACE` on the same rowid leaks stale content into FTS5
	 * because SQLite's REPLACE doesn't fire the per-table delete trigger
	 * reliably for FTS5 external content.)
	 *
	 * Version history: stays in this store (the source). We add a `delete`
	 * version entry here so the audit trail shows the move, and a `create`
	 * version entry in the destination so the destination's history is
	 * complete. The `metadata.movedFrom` field on the destination's create
	 * version links back to the source store for forensic queries.
	 *
	 * @param id  The memory ID to move (must exist in this store)
	 * @param targetPath  Absolute path to the destination .db file. The DB
	 *                    must already exist with the schema initialized
	 *                    (BankManager guarantees this via projectStores cache).
	 * @param newScope  The scope to assign in the destination
	 * @param newScopeId  The scope_id to assign (null for global/agent/session)
	 * @param preservedFields  Classification fields from the new memory params
	 *                         (target, category, tier, ttl_days). Content and
	 *                         created_at carry over from the source.
	 * @returns The new memory object (as it lives in the destination), or null
	 *          if the source memory was not found.
	 */
	moveMemoryOut(
		id: string,
		targetPath: string,
		newScope: Memory["scope"],
		newScopeId: string | null,
		preservedFields: {
			target: Memory["target"];
			category?: Memory["category"] | null;
			tier: Memory["tier"];
			ttl_days?: number | null;
		},
	): Memory | null {
		// 1. Read source row (must include rowid for FTS5 rowid preservation).
		//    We parse metadata here directly because we need a raw handle on the
		//    rowid AND a parsed metadata object — `getMemory` doesn't expose rowid.
		const rawRow = this.db
			.prepare("SELECT rowid, * FROM memories WHERE id = ?")
			.get(id) as (Memory & { rowid: number }) | undefined;
		if (!rawRow) return null;
		// Parse metadata if it was stored as a JSON string (matches parseRow).
		const row = {
			...rawRow,
			metadata: rawRow.metadata
				? (typeof rawRow.metadata === "string"
						? JSON.parse(rawRow.metadata)
						: rawRow.metadata)
				: undefined,
		};

		// 2. ATTACH the destination DB. better-sqlite3 ATTACH requires the
		//    path as a string literal in the SQL — escaping single quotes
		//    is mandatory for paths containing them (rare but possible).
		const escapedPath = targetPath.replace(/'/g, "''");
		const attachName = "dst_store";
		this.db.exec(`ATTACH DATABASE '${escapedPath}' AS ${attachName}`);

		try {
			// 3. Run the move in a single transaction spanning both files.
			//    If anything below throws, BOTH sides roll back to pre-move
			//    state — no half-moved rows.
			const tx = this.db.transaction(() => {
				// 3a. If destination has a memory at the source rowid, DELETE
				//     it first. The explicit DELETE fires the FTS5 delete
				//     trigger properly (REPLACE does not — see method comment).
				const collision = this.db
					.prepare(`SELECT id FROM ${attachName}.memories WHERE rowid = ?`)
					.get(row.rowid) as { id: string } | undefined;
				if (collision) {
					this.db
						.prepare(`DELETE FROM ${attachName}.memories WHERE rowid = ?`)
						.run(row.rowid);
				}

				// 3b. INSERT into destination, preserving rowid (FTS5 needs it)
				//     and applying new scope/scope_id. Content/created_at carry
				//     over from source; classification comes from preservedFields.
				const now = Date.now();
				const effectiveTtl =
					preservedFields.ttl_days !== undefined && preservedFields.ttl_days !== null
						? preservedFields.ttl_days
						: row.ttl_days;
				const newExpiresAt =
					effectiveTtl !== null && effectiveTtl !== undefined
						? now + effectiveTtl * 86400000
						: null;

				this.db
					.prepare(
						`INSERT INTO ${attachName}.memories (
							rowid, id, content, scope, scope_id, target, category,
							status, tier, ttl_days, created_at, updated_at,
							last_accessed_at, access_count, metadata, expires_at, confidence,
							utility_score, source_session_id, source_turn_id, memory_kind, mytags, trust_level
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						row.rowid,
						row.id,
						row.content,
						newScope,
						newScopeId,
						preservedFields.target,
						preservedFields.category ?? row.category ?? null,
						"active", // reset to active in destination
						preservedFields.tier,
						effectiveTtl ?? null,
						row.created_at,
						now,
						row.last_accessed_at ?? null,
						row.access_count,
						row.metadata ? JSON.stringify(row.metadata) : null,
						newExpiresAt,
						row.confidence || "explicit",
						row.utility_score ?? 0.0,
						row.source_session_id ?? null,
						row.source_turn_id ?? null,
						row.memory_kind || "semantic",
						row.tags && row.tags.length > 0 ? JSON.stringify(row.tags) : "[]",
						row.trust_level ?? 2,
					);

				// 3c. Add a `create` version entry in destination, tagged with
				//     metadata.movedFrom so forensic queries can find the source.
				const movedFromMeta = {
					...((row.metadata as any) || {}),
					movedFrom: { store: "source", id, at: now },
				};
				this.db
					.prepare(
						`INSERT INTO ${attachName}.memory_versions (
							id, memory_id, version_number, content, scope, scope_id,
							target, category, status, tier, ttl_days, metadata,
							action, session_id, batch_id, created_at, content_hash
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						randomUUID(),
						row.id,
						1, // first version in destination
						row.content,
						newScope,
						newScopeId,
						preservedFields.target,
						preservedFields.category ?? row.category ?? null,
						"active",
						preservedFields.tier,
						effectiveTtl ?? null,
						JSON.stringify(movedFromMeta),
						"create",
						null,
						(row.metadata as any)?.batchId ?? null,
						now,
						createHash("sha256").update(row.content).digest("hex"),
					);

				// 3d. DELETE from source. This fires the FTS5 delete trigger
				//     in the SOURCE store, removing the row from source FTS5.
				this.db.prepare("DELETE FROM memories WHERE id = ?").run(row.id);

				// 3e. Add a `delete` version entry in source so the audit trail
				//     shows the move happened (status preserved from existing).
				//     Version number = MAX+1 from existing versions for this id.
				const nextVersion = (this.db
					.prepare(
						"SELECT MAX(version_number) as m FROM memory_versions WHERE memory_id = ?",
					)
					.get(row.id) as any).m + 1;
				this.db
					.prepare(
						`INSERT INTO memory_versions (
							id, memory_id, version_number, content, scope, scope_id,
							target, category, status, tier, ttl_days, metadata,
							action, session_id, batch_id, created_at, content_hash
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						randomUUID(),
						row.id,
						nextVersion,
						row.content,
						row.scope,
						row.scope_id ?? null,
						row.target,
						row.category ?? null,
						row.status,
						row.tier,
						row.ttl_days ?? null,
						row.metadata ? JSON.stringify(row.metadata) : null,
						"delete",
						null,
						(row.metadata as any)?.batchId ?? null,
						now,
						createHash("sha256").update(row.content).digest("hex"),
					);
			});

			tx();

			// 4. Invalidate this store's IDF cache (row was removed from this
			//    store's FTS5). The destination's cache is invalid in its own
			//    DreamStore instance — caller must invalidate separately.
			this.invalidateIdfCache();

			// 5. Reconstruct the Memory object as it lives in the destination.
			//    We don't have a direct handle to the destination's DreamStore
			//    here, so we return the data we just inserted. The caller (or
			//    a follow-up read) can hydrate the full Memory from the
			//    destination if needed.
			const now = Date.now();
			const effectiveTtl =
				preservedFields.ttl_days !== undefined && preservedFields.ttl_days !== null
					? preservedFields.ttl_days
					: row.ttl_days;
			const newExpiresAt =
				effectiveTtl !== null && effectiveTtl !== undefined
					? now + effectiveTtl * 86400000
					: null;

			return {
				id: row.id,
				content: row.content,
				scope: newScope,
				scope_id: newScopeId ?? undefined,
				target: preservedFields.target,
				category: preservedFields.category ?? row.category ?? undefined,
				status: "active",
				tier: preservedFields.tier,
				ttl_days: effectiveTtl ?? undefined,
				created_at: row.created_at,
				updated_at: now,
				last_accessed_at: row.last_accessed_at ?? undefined,
				access_count: row.access_count,
				confidence: row.confidence || "explicit",
				metadata: row.metadata ?? undefined,
				expires_at: newExpiresAt ?? undefined,
			};
		} finally {
			// 6. Always DETACH, even on rollback. better-sqlite3 will throw
			//    on next ATTACH of the same name if we leak the attachment.
			this.db.exec(`DETACH DATABASE ${attachName}`);
		}
	}

	// ── Search ────────────────────────────────────────────────────────────

	/**
	 * Search by query with smart FTS5 tokenization (MiMo-Code approach)
	 */
	searchByQuery(
		query: string,
		options: {
			scope?: Memory["scope"];
			scope_id?: string;
			target?: Memory["target"];
			category?: Memory["category"];
			status?: Memory["status"];
			tier?: Memory["tier"];
			limit?: number;
			scoreFloorRatio?: number;
		} = {},
	): Array<{ memory: Memory; score: number; snippet: string; anchorToken?: string }> {
		// Coerce to non-negative integer; non-integers crash SQLite LIMIT binding.
		const topK = this.coerceLimit(options.limit ?? 10);
		const floorRatio = options.scoreFloorRatio ?? 0.15;

		// 1. Tokenize query (Unicode regex keeps CJK)
		const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.map(t => t.trim()).filter(Boolean) ?? [];
		if (tokens.length === 0) return [];

		// 2. Build FTS5 query: OR-join with phrase quoting
		// Each token wrapped in double quotes for literal phrase match
		// OR (not AND) so partial matches return results
		const ftsQuery = tokens
			.map(t => `"${t.replace(/"/g, '""')}"`)
			.join(" OR ");

		// 3. Execute FTS5 with BM25 ranking
		let sql = `
			SELECT m.*, bm25(memories_fts) as rank,
			       snippet(memories_fts, 0, '<<', '>>', '...', 32) as snippet
			FROM memories_fts
			JOIN memories m ON m.rowid = memories_fts.rowid
			WHERE memories_fts MATCH ?
		`;
		const params: any[] = [ftsQuery];

		if (options.scope) {
			sql += " AND m.scope = ?";
			params.push(options.scope);
		}
		if (options.scope_id) {
			sql += " AND m.scope_id = ?";
			params.push(options.scope_id);
		}
		if (options.target) {
			sql += " AND m.target = ?";
			params.push(options.target);
		}
		if (options.category) {
			sql += " AND m.category = ?";
			params.push(options.category);
		}
		if (options.status) {
			sql += " AND m.status = ?";
			params.push(options.status);
		}
		if (options.tier) {
			sql += " AND m.tier = ?";
			params.push(options.tier);
		}

		// Over-fetch 3x to let score-floor trim without starving results
		sql += " ORDER BY rank LIMIT ?";
		params.push(Math.min(topK * 3, 50));

		const rows = this.db.prepare(sql).all(...params) as any[];

		if (rows.length === 0) return [];

		// 4. Apply RELATIVE score floor (MiMo approach)
		// Top hit always kept, cutoff = topScore * ratio
		//
		// Edge cases handled:
		//   - `topRank >= 0`: BM25 in SQLite normally returns negative ranks
		//     (more negative = better match). A non-negative rank means the
		//     match is poor OR the corpus is too small for BM25 to compute a
		//     meaningful signal. The previous code returned empty in this
		//     case, which silently broke recall for users with < ~10 memories
		//     — a fresh `dream-memory` install could never retrieve anything.
		//     The fix: when BM25 gives us no signal, fall through with no
		//     score floor (keep all rows up to topK) and let downstream IDF
		//     scoring do the work.
		//   - `floorRatio <= 0`: caller explicitly disabled the floor. Previous
		//     code used `-Infinity` as the cutoff, which kept everything; we
		//     preserve that semantics.
		const topRank = rows[0].rank;
		const bm25HasSignal = topRank < 0;
		const cutoff = bm25HasSignal && floorRatio > 0 ? topRank * floorRatio : -Infinity;

		// 5. Compute IDF for each query token (Trellis anchor-rarity)
		// IDF = log(N / df) where N = total memories, df = docs containing term
		// Higher IDF = rarer term = more distinctive
		//
		// Perf fix: previous code ran one `SELECT COUNT(*) ... WHERE MATCH ?`
		// per token, every search. With 10 tokens per query, that's 10 extra
		// queries against FTS5. We now cache `df` per token in an in-memory
		// Map, invalidated whenever a memory is added/updated/deleted (see
		// `invalidateIdfCache` in the CRUD methods). For a stable corpus the
		// cache turns this into O(1) lookups after the first search.
		const corpusSize = (this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as any).count || 1;
		const idf = new Map<string, number>();
		const dfStmt = this.db.prepare(`SELECT COUNT(*) as count FROM memories_fts WHERE memories_fts MATCH ?`);
		for (const token of tokens) {
			let df = this.idfCache.get(token);
			if (df === undefined) {
				// Cast to number: better-sqlite3 returns INTEGER for COUNT(*),
				// but `as any` widens the type. Coerce so the cache stays a
				// `Map<string, number>` and we don't accumulate `undefined`
				// entries (which would silently break every future search).
				df = Number((dfStmt.get(`"${token.replace(/"/g, '""')}"`) as any).count);
				this.idfCache.set(token, df);
			}
			// Smoothed IDF: log(1 + N/df) to avoid log(0). The `?? 0` covers
			// the case where the cache has `undefined` (no entry yet for this
			// token, but TS doesn't narrow `let df` after the assignment).
			const dfSafe = df ?? 0;
			idf.set(token, Math.log(1 + corpusSize / (dfSafe + 1)));
		}

		// BM25: LOWER rank = BETTER. We want higher = better for callers.
		// When BM25 has no signal (small corpus), skip the rank filter so we
		// don't return an empty result list.
		const results = rows
			.filter((_, i) => i === 0 || !bm25HasSignal || rows[i].rank <= cutoff)
			.slice(0, topK)
			.map(r => {
				const memory = this.parseRow(r);

				// 6. Find anchor token: rarest query token that appears in content
				const contentLower = memory.content.toLowerCase();
				let anchorToken: string | undefined;
				let maxIdf = -1;
				for (const token of tokens) {
					if (contentLower.includes(token.toLowerCase()) && (idf.get(token) || 0) > maxIdf) {
						maxIdf = idf.get(token) || 0;
						anchorToken = token;
					}
				}

				// 7. For LONG memories, refine snippet around anchor token
				let snippet = r.snippet;
				if (anchorToken && memory.content.length > 200) {
					snippet = this.refineSnippetAroundAnchor(memory.content, anchorToken);
				}

				return {
					memory,
					score: -r.rank,  // Negate so higher = better
					snippet,
					anchorToken,
				};
			});

		return results;
	}

	/**
	 * Refine snippet: extract a window of ~32 words around the anchor token
	 * Used for long memories where FTS5 default snippet may miss the most relevant part.
	 */
	private refineSnippetAroundAnchor(content: string, anchorToken: string, windowWords: number = 32): string {
		const contentLower = content.toLowerCase();
		const anchorLower = anchorToken.toLowerCase();
		const idx = contentLower.indexOf(anchorLower);
		if (idx === -1) return content; // Fallback

		// Find word boundaries around the anchor
		const words = content.split(/\s+/);
		const anchorWordIdx = this.findWordIndex(words, anchorToken);
		if (anchorWordIdx === -1) return content;

		// Extract window
		const half = Math.floor(windowWords / 2);
		const start = Math.max(0, anchorWordIdx - half);
		const end = Math.min(words.length, anchorWordIdx + half + 1);
		const window = words.slice(start, end);

		// Add ellipses if truncated
		const prefix = start > 0 ? "..." : "";
		const suffix = end < words.length ? "..." : "";
		return prefix + window.join(" ") + suffix;
	}

	private findWordIndex(words: string[], target: string): number {
		const targetLower = target.toLowerCase();
		for (let i = 0; i < words.length; i++) {
			if (words[i].toLowerCase().includes(targetLower)) return i;
		}
		return -1;
	}

	// ── TTL Enforcement ───────────────────────────────────────────────────

	/**
	 * Find all memories whose TTL has elapsed. Uses the materialized
	 * `expires_at` column (set by createMemory/updateMemory, backfilled by
	 * the v1.4 migration) so the query is sargable:
	 *
	 *   WHERE expires_at IS NOT NULL AND expires_at < ?
	 *
	 * The partial index `idx_memories_expires` (defined in schema.sql and
	 * created by the v1.4 migration) accelerates this lookup. The previous
	 * `WHERE (updated_at + ttl_days * ...) < ?` forced a full SCAN, which
	 * scaled linearly with corpus size.
	 *
	 * Semantic equivalence: the old WHERE was `ttl_days IS NOT NULL AND
	 * (updated_at + ttl_days * 86400000) < now`. The new column is
	 * `updated_at + ttl_days * 86400000` for non-permanent memories, so
	 * `expires_at < now` returns the same set. Permanent memories have
	 * `expires_at = NULL` and are correctly excluded.
	 */
	getExpiredMemories(): Memory[] {
		const now = Date.now();
		// TTL-based expiry
		const ttlRows = this.db
			.prepare(
				`
			SELECT * FROM memories
			WHERE expires_at IS NOT NULL
			AND expires_at < ?
			`,
			)
			.all(now) as any[];

		// v2.2: valid_until expiry (factual memories with validity window)
		const validUntilRows = this.db
			.prepare(
				`
			SELECT * FROM memories
			WHERE valid_until IS NOT NULL
			AND valid_until < ?
			AND (expires_at IS NULL OR expires_at >= ?)
			`,
			)
			.all(now, now) as any[];

		// Merge and deduplicate
		const seen = new Set<string>();
		const all = [...ttlRows, ...validUntilRows].filter(r => {
			if (seen.has(r.id)) return false;
			seen.add(r.id);
			return true;
		});

		return all.map((r) => this.parseRow(r));
	}

	deleteExpiredMemories(): number {
		const expired = this.getExpiredMemories();
		for (const mem of expired) {
			this.deleteMemory(mem.id);
		}
		return expired.length;
	}

	// ── Access Tracking ───────────────────────────────────────────────────

	trackAccess(id: string): void {
		const now = Date.now();
		this.db
			.prepare(
				`
			UPDATE memories
			SET last_accessed_at = ?, access_count = access_count + 1
			WHERE id = ?
		`,
			)
			.run(now, id);
	}

	/**
	 * Reinforce a memory: bump stability × 1.5 and update counters.
	 * Called when a recalled memory is subsequently used by the agent.
	 */
	trackReinforcement(id: string): void {
		const now = Date.now();
		this.db.prepare(`
			UPDATE memories
			SET reinforcement_count = reinforcement_count + 1,
				stability = stability * 1.5,
				last_reinforced = ?
			WHERE id = ?
		`).run(now, id);
	}

	/**
	 * Adjust the utility_score of a memory by `delta`, clamped to [-1, 1].
	 * Used by the recall feedback loop (F3): positive when the memory
	 * was in the recall and the next tool call used it; negative when a
	 * contradiction was discarded (the memory was wrong).
	 *
	 * @returns the new utility_score, or null if the memory does not exist.
	 */
	adjustUtility(id: string, delta: number): number | null {
		if (!Number.isFinite(delta)) return null;
		// Read current, apply delta, clamp, write back. SQLite has no native
		// MIN/MAX in UPDATE, so we do the clamp in JS. Two queries instead
		// of one is acceptable: this is called from user-facing tool paths
		// (1-10x per turn), not in a hot loop.
		const row = this.db
			.prepare("SELECT utility_score FROM memories WHERE id = ?")
			.get(id) as { utility_score: number } | undefined;
		if (!row) return null;
		const next = Math.max(-1, Math.min(1, row.utility_score + delta));
		this.db
			.prepare("UPDATE memories SET utility_score = ? WHERE id = ?")
			.run(next, id);
		return next;
	}

	/**
	 * Get only active memories (status = 'active')
	 * Convenience method used by synthesis to exclude resolved/superseded
	 */
	getActiveMemories(options: { limit?: number; since?: number } = {}): Memory[] {
		return this.listMemories({
			status: "active",
			limit: options.limit || 10000,
			since: options.since,
		});
	}

	/**
	 * Find memories by source substring match (LIKE on metadata.source)
	 */
	findBySource(sourcePattern: string, options: { limit?: number } = {}): Memory[] {
		const limit = options.limit || 100;
		const rows = this.db
			.prepare(
				`
			SELECT * FROM memories
			WHERE json_extract(metadata, '$.source') LIKE ?
			LIMIT ?
		`,
			)
			.all(`%${sourcePattern}%`, limit) as any[];
		return rows.map((r) => this.parseRow(r));
	}

	/**
	 * Find memories flagged with `metadata.always_inject = true`.
	 *
	 * These are always prepended to the recall output regardless of BM25
	 * score — use for system specs, hard preferences, and other context
	 * the agent must always have in scope. Cap at 10 to keep the recall
	 * budget manageable; users with more than 10 pinned memories are
	 * using the flag wrong (it should be a curated short list, not a
	 * "always include my full project history" toggle).
	 */
	findAlwaysInject(options: { limit?: number } = {}): Memory[] {
		const limit = options.limit || 10;
		const rows = this.db
			.prepare(
				`
			SELECT * FROM memories
			WHERE status = 'active'
			  AND json_extract(metadata, '$.always_inject') = 1
			ORDER BY updated_at DESC
			LIMIT ?
		`,
			)
			.all(limit) as any[];
		return rows.map((r) => this.parseRow(r));
	}

	/**
	 * Find versions by batch_id
	 * Used for batch revert
	 */
	findVersionsByBatchId(batchId: string): MemoryVersion[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_versions WHERE batch_id = ? ORDER BY memory_id, version_number ASC`,
			)
			.all(batchId) as any[];
		return rows.map((r) => ({
			...r,
			metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
		}));
	}

	/**
	 * Find the latest pre-batch version of a memory (if any)
	 * Used to restore memory state before batch
	 */
	findPreBatchVersion(memoryId: string, batchId: string): MemoryVersion | null {
		const batchVersions = this.db
			.prepare(
				`SELECT MIN(version_number) as min_v FROM memory_versions WHERE memory_id = ? AND batch_id = ?`,
			)
			.get(memoryId, batchId) as any;

		if (!batchVersions?.min_v) return null;

		// Find the latest version BEFORE the first batch version
		const preBatch = this.db
			.prepare(
				`SELECT * FROM memory_versions
				 WHERE memory_id = ? AND version_number < ?
				 ORDER BY version_number DESC LIMIT 1`,
			)
			.get(memoryId, batchVersions.min_v) as any;

		if (!preBatch) return null;
		return {
			...preBatch,
			metadata: preBatch.metadata ? JSON.parse(preBatch.metadata) : undefined,
		};
	}

	/**
	 * Mark a memory as consolidated into a synthesis memory
	 * Adds metadata flag so it can be filtered out
	 */
	/**
	 * Mark a memory as consolidated into a synthesized memory.
	 *
	 * Performs two updates atomically:
	 *  1. Sets status='superseded' so the memory is excluded from default recall
	 *     and search results (no more duplicate info surfacing after synthesis)
	 *  2. Adds metadata pointers (consolidated, consolidatedInto, consolidatedAt)
	 *     so the link to the synthesized memory is preserved for audit/history
	 *
	 * The memory's content is NOT deleted — it remains in the DB and is
	 * recoverable via `dream_memory_history` or by changing status back to 'active'.
	 */
	markConsolidated(id: string, synthesisId: string): void {
		const mem = this.getMemory(id);
		if (!mem) return;

		const existing = mem.metadata || {};
		const now = Date.now();
		this.db
			.prepare(
				`
			UPDATE memories
			SET metadata = ?, status = 'superseded'
			WHERE id = ?
		`,
			)
			.run(
				JSON.stringify({
					...existing,
					consolidated: true,
					consolidatedInto: synthesisId,
					consolidatedAt: now,
				}),
				id,
			);
		// Invalidate IDF cache for consistency with other CRUD methods.
		// The FTS5 row content is unchanged, so document frequency for the
		// memory's tokens is technically the same; but the row was touched
		// (status + metadata), and we want a single invariant: any mutation
		// invalidates. Future refactors that move status into a separate
		// FTS5 filter won't have to remember to also clear this cache.
		this.invalidateIdfCache();
	}

	/**
	 * Get memories that are NOT yet consolidated
	 */
	getUnconsolidatedMemories(options: { limit?: number } = {}): Memory[] {
		const all = this.listMemories({ limit: options.limit || 10000 });
		return all.filter((m) => {
			const meta = m.metadata as any;
			return !meta?.consolidated;
		});
	}

	// ── Memory Linking ───────────────────────────────────────────────────
	//
	// Auto-link memories during add: when a new memory arrives, find existing
	// memories with similar content and record the relationship in
	// metadata.linked_to. Future searches can expand via these links.
	//
	// Design choices:
	//   - Unidirectional: A links to B, but B doesn't auto-link back.
	//     Bidirectional sync would double the writes per add and isn't worth
	//     the complexity for v1.
	//   - Top-K with score filter: we cap at top 3 candidates to avoid link
	//     clutter, but only link if FTS5 score is above a minimum (avoids
	//     linking noise / unrelated content).
	//   - Same target: only link within the same target (user, project, etc).
	//     Cross-target links are confusing — a preference and a convention
	//     aren't usually related.
	//   - Stale links: if a linked memory is deleted, the link is just
	//     ignored on read (getMemory returns null). No cleanup needed.
	//   - Stored in metadata.linked_to as a string array. No schema change.

	/**
	 * Find memories related to the given content via FTS5.
	 *
	 * Used by `dream_memory_add` to auto-link new memories with related ones.
	 * Returns the top-K candidates by FTS5 score, excluding the caller (so a
	 * memory doesn't link to itself). Filters by target if provided (defaults
	 * to no filter).
	 *
	 * @param content  The new memory's content to search against
	 * @param options.excludeId  Memory ID to exclude (the new memory being created)
	 * @param options.target  Only consider memories with this target
	 * @param options.topK  Max results to return (default 3, hard cap 10)
	 * @param options.minScore  Minimum FTS5 score to consider (default 0.0).
	 *                          Note: BM25 scores in SQLite FTS5 are NEGATIVE;
	 *                          `searchByQuery` negates them so higher = better.
	 *                          In a small personal corpus (1 user, ~hundreds
	 *                          of memories), even strong matches can score
	 *                          ~0.000003 because shared common terms (e.g.
	 *                          "user", "prefers") have very low IDF. Keep
	 *                          minScore at 0 to avoid filtering out real
	 *                          matches; rely on top-K to limit the link count.
	 * @param options.relativeRatio  Corpus-adaptive link quality gate. Drop
	 *                          candidates whose BM25 score is below this
	 *                          fraction of the top-ranked candidate's score.
	 *                          0.5 = "keep only candidates at least half as
	 *                          relevant as the best match"; 1.0 = "only the
	 *                          top match (ties allowed)"; 0 (default)
	 *                          disables the filter and preserves legacy
	 *                          behavior. See the type-level doc on the
	 *                          parameter for the full rationale (Akshay
	 *                          Pachaar: don't link everything to everything).
	 */
	findRelatedMemories(
		content: string,
		options: {
			excludeId?: string;
			target?: Memory["target"];
			topK?: number;
			/**
			 * Minimum BM25 score to consider a candidate. BM25 ranks in
			 * SQLite FTS5 are NEGATIVE (more negative = stronger match);
			 * this method exposes them as absolute scores, so the threshold
			 * is expressed as a positive number. A minScore of 0.0 means
			 * "any match at all" (rank < 0). Default 0.0 — rely on top-K
			 * to limit results, since in small personal corpora even strong
			 * matches can have tiny absolute scores.
			 */
			minScore?: number;
			/**
			 * How aggressively to over-fetch from FTS5 before applying the
			 * minScore filter and the in-PostgreSQL link loop. The previous
			 * code hard-coded `topK * 3` here, which silently capped the
			 * search at 30 rows regardless of topK. With a deeper topK
			 * (e.g., topK=10 used in batch backfill), the cap meant real
			 * candidates were never inspected. The over-fetch ratio is
			 * now an explicit parameter; default 3 keeps the prior behavior
			 * for the common topK=3 call sites in dream_memory_add.
			 */
			overfetchRatio?: number;
			/**
			 * Drop candidates whose BM25 score is below this fraction of the
			 * top-ranked candidate's score. 0.5 = "keep only candidates at
			 * least half as relevant as the best match"; 1.0 = "only the top
			 * match (ties allowed)"; 0 (default) preserves legacy behavior.
			 * Corpus-adaptive: works on both small (50) and large (5000)
			 * corpora, unlike an absolute `minScore` which over-filters on
			 * small corpora and under-filters on large ones.
			 */
			relativeRatio?: number;
		} = {},
	): Memory[] {
		const topK = Math.min(options.topK ?? 3, 10);
		const minScore = options.minScore ?? 0.0;
		const overfetchRatio = Math.max(1, options.overfetchRatio ?? 3);
		const relativeRatio = options.relativeRatio ?? 0.0;

		if (!content || content.trim().length === 0) return [];

		// Direct FTS5 query (bypasses searchByQuery's score floor and other
		// filtering). The score floor in searchByQuery is tuned for user
		// recall — it filters aggressively to cut noise. For auto-linking,
		// we want to capture even weak matches; the top-K cap is the
		// primary limit. Going through searchByQuery with scoreFloorRatio=0
		// would keep only the top result (not what we want).
		const tokens = content.match(/[\p{L}\p{N}_]+/gu)?.map(t => t.trim()).filter(Boolean) ?? [];
		if (tokens.length === 0) return [];
		const ftsQuery = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");

		// Build the FTS5 query with optional target filter
		let sql = `
			SELECT m.id, m.content, m.scope, m.scope_id, m.target, m.category,
			       m.status, m.tier, m.ttl_days, m.created_at, m.updated_at,
			       m.last_accessed_at, m.access_count, m.embedding, m.metadata,
			       m.expires_at, m.source_session_id, m.source_turn_id,
			       m.rowid as rowid, bm25(memories_fts) as rank
			FROM memories_fts
			JOIN memories m ON m.rowid = memories_fts.rowid
			WHERE memories_fts MATCH ?
		`;
		const params: any[] = [ftsQuery];
		if (options.target) {
			sql += " AND m.target = ?";
			params.push(options.target);
		}
		sql += " ORDER BY rank LIMIT ?";
		// Use the explicit overfetch ratio. The cap is a soft cap to keep the
		// FTS5 query bounded on huge corpora; the multiplier ensures we have
		// enough candidates even after the minScore filter below discards
		// near-zero matches.
		params.push(topK * overfetchRatio);

		const rows = this.db.prepare(sql).all(...params) as any[];
		// Parse rows to Memory objects (reuse parseRow logic for metadata).
		// We keep the raw `rank` alongside the parsed memory so the
		// minScore filter below can use BM25's native (negative) ranking.
		const candidates: Array<{ mem: Memory; rank: number }> = rows.map(r => ({
			mem: this.parseRow(r),
			rank: typeof r.rank === "number" ? r.rank : 0,
		}));

		// Capture the top-ranked candidate's score for the relative-ratio
		// filter. BM25 ranks are negative; the score we expose is `-rank`,
		// so the top score is `-candidates[0].rank` (most negative rank =
		// strongest match). Guard: if the top score is 0 (degenerate case
		// on a very small corpus or FTS5 quirk), skip the ratio filter
		// entirely — a multiplicative zero would drop every candidate.
		const topScore = candidates.length > 0 ? -candidates[0].rank : 0;
		const ratioActive = relativeRatio > 0 && topScore > 0;
		// Convert the ratio threshold into a score cutoff: a candidate
		// passes if its score >= topScore * relativeRatio. The epsilon is
		// RELATIVE (0.1% of top score) instead of a hardcoded 0.0001 — on
		// tiny-corpus BM25 scores (e.g., 1e-6 range) a hardcoded epsilon
		// would dominate the score range and drag the cutoff below zero,
		// making the filter a no-op.
		const ratioScoreCutoff = ratioActive ? topScore * relativeRatio - topScore * 0.001 : 0;

		const seen = new Set<string>();
		const related: Memory[] = [];
		for (const { mem, rank } of candidates) {
			// Skip self-link
			if (options.excludeId && mem.id === options.excludeId) continue;
			// Skip already-counted (in case of duplicates)
			if (seen.has(mem.id)) continue;
			// Skip low-score matches. BM25 rank is negative; the absolute
			// score we expose is -rank. Apply the threshold against -rank so
			// callers pass a positive number (consistent with searchByQuery).
			// A tiny epsilon (-0.0001) prevents borderline noise from passing
			// when minScore=0.
			if (-rank < minScore - 0.0001) continue;
			// Link quality gate (Akshay Pachaar: don't link everything to
			// everything). Drop candidates whose score falls below the
			// relative-ratio cutoff against the top match. Only active
			// when `ratioActive` is true (see topScore guard above).
			if (ratioActive && -rank < ratioScoreCutoff) continue;
			if (mem.metadata && (mem.metadata as any).consolidated) continue; // skip consolidated
			if (mem.status !== "active") continue;

			seen.add(mem.id);
			related.push(mem);
			if (related.length >= topK) break;
		}

		return related;
	}

	/**
	 * Update a memory's linked_to list. Accepts both legacy string[] and
	 * new LinkedMemory[] format. Merges with existing links (no duplicates).
	 * Existing links not in the new set are preserved (unions).
	 *
	 * @param id  Memory to update
	 * @param links  New links to add (string IDs or LinkedMemory objects)
	 * @returns true if updated, false if memory not found
	 */
	updateLinkedTo(id: string, links: Array<string | LinkedMemory>): boolean {
		const mem = this.getMemory(id);
		if (!mem) return false;

		const existing = normalizeLinkedTo((mem.metadata as any)?.linked_to);

		// Normalize incoming links to LinkedMemory format
		const incoming: LinkedMemory[] = links.map((item) => {
			if (typeof item === "string") {
				return { id: item, relation: "related_to", since: Date.now() };
			}
			return { ...item, since: item.since || Date.now() };
		});

		// Union by id — preserve existing, add new, dedupe
		const byId = new Map<string, LinkedMemory>();
		for (const link of existing) byId.set(link.id, link);
		for (const link of incoming) {
			if (!byId.has(link.id)) {
				byId.set(link.id, link);
			} else {
				// Update relation if incoming is more specific
				const existing = byId.get(link.id)!;
				if (existing.relation === "related_to" && link.relation !== "related_to") {
					byId.set(link.id, link);
				}
			}
		}
		const merged = Array.from(byId.values());

		// Skip write if no change (compare by id list)
		const existingIds = existing.map((l) => l.id).sort().join(",");
		const mergedIds = merged.map((l) => l.id).sort().join(",");
		if (existingIds === mergedIds) return true;

		const newMetadata = { ...(mem.metadata || {}), linked_to: merged };
		const now = Date.now();

		// Recompute expires_at if ttl_days is set (same logic as updateMemory)
		const effectiveTtl = mem.ttl_days;
		const newExpiresAt = effectiveTtl !== null && effectiveTtl !== undefined
			? now + effectiveTtl * 86400000
			: null;

		this.db
			.prepare(
				`UPDATE memories SET metadata = ?, updated_at = ?, expires_at = ? WHERE id = ?`,
			)
			.run(JSON.stringify(newMetadata), now, newExpiresAt, id);

		// No version bump — linking is metadata bookkeeping, not a content change.
		// Invalidate IDF cache because the row was touched.
		this.invalidateIdfCache();
		return true;
	}

	/**
	 * Get memories linked from the given memory. Stale links (memories that
	 * were deleted) are silently filtered out.
	 *
	 * @param id  Memory whose links to resolve
	 * @returns Array of linked memories (may be empty)
	 */
	getLinkedMemories(id: string): Memory[] {
		const mem = this.getMemory(id);
		if (!mem) return [];

		const links = normalizeLinkedTo((mem.metadata as any)?.linked_to);
		if (links.length === 0) return [];

		const out: Memory[] = [];
		for (const link of links) {
			const linked = this.getMemory(link.id);
			if (linked) out.push(linked);
		}
		return out;
	}

	// ── Stats ─────────────────────────────────────────────────────────────

	getStats(): {
		total: number;
		byScope: Record<string, number>;
		byTarget: Record<string, number>;
		byTier: Record<string, number>;
		byStatus: Record<string, number>;
		expired: number;
	} {
		const total = (this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as any).count;

		const byScope: Record<string, number> = {};
		for (const row of this.db.prepare("SELECT scope, COUNT(*) as count FROM memories GROUP BY scope").all() as any[]) {
			byScope[row.scope] = row.count;
		}

		const byTarget: Record<string, number> = {};
		for (const row of this.db.prepare("SELECT target, COUNT(*) as count FROM memories GROUP BY target").all() as any[]) {
			byTarget[row.target] = row.count;
		}

		const byTier: Record<string, number> = {};
		for (const row of this.db.prepare("SELECT tier, COUNT(*) as count FROM memories GROUP BY tier").all() as any[]) {
			byTier[row.tier] = row.count;
		}

		const byStatus: Record<string, number> = {};
		for (const row of this.db.prepare("SELECT status, COUNT(*) as count FROM memories GROUP BY status").all() as any[]) {
			byStatus[row.status] = row.count;
		}

		const expired = this.getExpiredMemories().length;

		return { total, byScope, byTarget, byTier, byStatus, expired };
	}

	// ── Quality Audit ──────────────────────────────────────────────────

	/**
	 * Quality audit: detect potential issues in the memory store.
	 * Returns structured audit results with actionable suggestions.
	 */
	audit(): {
		entityConcentration: { entity: string; count: number }[];
		orphanMemories: { id: string; content: string; category: string }[];
		retentionCandidates: { id: string; content: string; created_at: number; age_days: number }[];
		categoryDistribution: Record<string, number>;
		statusDistribution: Record<string, number>;
		totalMemories: number;
	} {
		const total = this.db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as any;
		const totalMemories = total?.cnt ?? 0;

		// Entity concentration: count memories per tag, find entities with many memories
		const allMemories = this.db.prepare("SELECT id, content, category, mytags, created_at, status FROM memories WHERE status != 'superseded'").all() as any[];

		const tagCounts = new Map<string, number>();
		const orphanCandidates: { id: string; content: string; category: string }[] = [];
		const retentionCandidates: { id: string; content: string; created_at: number; age_days: number }[] = [];
		const categoryDist: Record<string, number> = {};
		const statusDist: Record<string, number> = {};

		const now = Date.now();
		const RETENTION_THRESHOLD_DAYS = 90;

		for (const row of allMemories) {
			// Category distribution
			const cat = row.category ?? "uncategorized";
			categoryDist[cat] = (categoryDist[cat] ?? 0) + 1;

			// Status distribution
			const status = row.status ?? "active";
			statusDist[status] = (statusDist[status] ?? 0) + 1;

			// Tag concentration
			let tags: string[] = [];
			try { tags = row.mytags ? JSON.parse(row.mytags) : []; } catch { tags = []; }
			for (const tag of tags) {
				tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
			}

			// Orphan detection: no tags, short content, no linked edges
			const metadata = row.metadata ? (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) : {};
			const hasLinks = Array.isArray(metadata.linked_to) && metadata.linked_to.length > 0;
			if (tags.length === 0 && !hasLinks && row.content.length < 50) {
				orphanCandidates.push({ id: row.id, content: row.content.slice(0, 80), category: cat });
			}

			// Retention candidates: old memories
			const ageDays = (now - row.created_at) / (1000 * 60 * 60 * 24);
			if (ageDays > RETENTION_THRESHOLD_DAYS) {
				retentionCandidates.push({ id: row.id, content: row.content.slice(0, 80), created_at: row.created_at, age_days: Math.floor(ageDays) });
			}
		}

		// Top entity concentrations (count > 5)
		const entityConcentration = Array.from(tagCounts.entries())
			.filter(([_, count]) => count > 5)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([entity, count]) => ({ entity, count }));

		// Cap orphan candidates at 20
		const orphanMemories = orphanCandidates.slice(0, 20);

		// Cap retention candidates at 20, sorted by age descending
		retentionCandidates.sort((a, b) => b.age_days - a.age_days);
		const retention = retentionCandidates.slice(0, 20);

		return {
			entityConcentration,
			orphanMemories,
			retentionCandidates: retention,
			categoryDistribution: categoryDist,
			statusDistribution: statusDist,
			totalMemories,
		};
	}

	// ── Dream Meta (key/value in `stats` table) ──────────────────────────
	// Used by auto-dream scheduler. Keys:
	//   "dream_last_run_at"      → ISO timestamp of last dream (manual or auto)
	//   "dream_sessions_since"   → integer counter, reset after each dream
	//   "dream_last_type"        → "manual" | "auto"
	//   "dream_last_stats"       → JSON { input: N, output: N, expired: N, synth: N }

	getDreamMeta(): {
		lastRunAt: number | null;
		sessionsSince: number;
		lastType: "manual" | "auto" | null;
		lastStats: { input?: number; output?: number; expired?: number; synth?: number } | null;
		createdAt: number;
	} {
		const get = (key: string): string | null => {
			const row = this.db.prepare("SELECT value FROM stats WHERE key = ?").get(key) as any;
			return row?.value ?? null;
		};

		// createdAt = first memory ever created (fallback: now)
		const firstMem = this.db
			.prepare("SELECT MIN(created_at) as ts FROM memories")
			.get() as any;
		const createdAt = firstMem?.ts || Date.now();

		const lastStatsRaw = get("dream_last_stats");
		let lastStats: any = null;
		if (lastStatsRaw) {
			try {
				lastStats = JSON.parse(lastStatsRaw);
			} catch {
				lastStats = null;
			}
		}

		return {
			lastRunAt: get("dream_last_run_at") ? Number(get("dream_last_run_at")) : null,
			sessionsSince: Number(get("dream_sessions_since") || 0),
			lastType: (get("dream_last_type") as any) || null,
			lastStats,
			createdAt,
		};
	}

	/**
	 * Set a single dream meta key. Upsert into `stats` table.
	 */
	private setDreamMetaKey(key: string, value: string): void {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO stats (key, value, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.run(key, value, now);
	}

	/**
	 * Increment the sessions-since-dream counter atomically.
	 * Called on every session_start.
	 */
	/**
	 * Atomic increment for dream_sessions_since. Uses a single UPDATE statement
	 * so concurrent processes don't lose updates under read-modify-write races.
	 * (Previous implementation lost ~50% of increments under 5-way concurrency.)
	 * Returns the new value after increment.
	 */
	incrementSessionsSinceDream(): number {
		// Idempotent: insert 0 row if missing, then atomically increment + return.
		// Wrapped in a transaction so the INSERT-or-IGNORE + UPDATE are atomic.
		// Note: `updated_at` is NOT NULL; we MUST provide it on insert or the row
		// is silently dropped (INSERT OR IGNORE + constraint violation).
		const result = this.db.transaction(() => {
			this.db
				.prepare("INSERT OR IGNORE INTO stats (key, value, updated_at) VALUES (?, '0', ?)")
				.run("dream_sessions_since", Date.now());
			const row = this.db
				.prepare(
					"UPDATE stats SET value = CAST(value AS INTEGER) + 1, updated_at = ? " +
					"WHERE key = 'dream_sessions_since' " +
					"RETURNING value",
				)
				.get(Date.now()) as { value: string | number } | undefined;
			return row ? Number(row.value) : 0;
		})();
		return result;
	}

	/**
	 * Record that a dream just ran. Resets sessions counter and timestamps.
	 */
	recordDreamRun(type: "manual" | "auto", stats: { input?: number; output?: number; expired?: number; synth?: number }): void {
		this.setDreamMetaKey("dream_last_run_at", String(Date.now()));
		this.setDreamMetaKey("dream_sessions_since", "0");
		this.setDreamMetaKey("dream_last_type", type);
		this.setDreamMetaKey("dream_last_stats", JSON.stringify(stats));
	}

	/**
	 * Count tool calls since last dream run. Uses the tool_usage table
	 * directly — no separate counter needed. Falls back to counting all
	 * rows if no dream has ever run (since createdAt).
	 */
	getToolCallsSinceLastDream(): number {
		const meta = this.getDreamMeta();
		const since = meta.lastRunAt || meta.createdAt;
		const row = this.db.prepare(
			"SELECT COUNT(*) as cnt FROM tool_usage WHERE timestamp >= ?"
		).get(since) as { cnt: number } | undefined;
		return row?.cnt ?? 0;
	}

	// ── Generic Stats (key/value in `stats` table) ──────────────────────
	// Used by /dream-eval to persist the last score, /dream-doctor to read
	// it. Generic enough for any future dashboard data.

	/**
	 * Get a value from the `stats` table by key. Returns null if not set.
	 */
	getStat(key: string): string | null {
		const row = this.db
			.prepare("SELECT value FROM stats WHERE key = ?")
			.get(key) as { value: string } | undefined;
		return row?.value ?? null;
	}

	/**
	 * Upsert a value into the `stats` table. Used by /dream-eval to persist
	 * the last score; kept generic so other features can use it without
	 * adding new methods.
	 */
	setStat(key: string, value: string): void {
		this.db
			.prepare(
				`INSERT INTO stats (key, value, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.run(key, value, Date.now());
	}

	// ── Tool Usage Tracking ───────────────────────────────────────────────

	trackToolUsage(params: {
		tool: string;
		args: Record<string, any>;
		session_id?: string;
		success?: boolean;
		error_preview?: string;
	}): void {
		// Canonicalize JSON key order so semantically identical args produce
		// the same hash. Without this, {a:1,b:2} and {b:2,a:1} (common when
		// re-serialized by different code paths) produce different hashes,
		// splitting a tool call pattern across multiple rows and starving
		// auto-capture/distill signal detection.
		const argsStr = canonicalJsonStringify(params.args);
		const argsHash = this.hashString(argsStr);
		const argsPreview = argsStr.slice(0, 200);

		this.db
			.prepare(
				`
			INSERT INTO tool_usage (tool, args_hash, args_preview, timestamp, session_id, success, error_preview)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`,
			)
			.run(
				params.tool,
				argsHash,
				argsPreview,
				Date.now(),
				params.session_id || null,
				params.success === false ? 0 : 1,
				params.error_preview?.slice(0, 200) || null,
			);
	}

	/**
	 * Get all tool_usage rows for a specific (tool, args_hash) in a time window.
	 * Used by auto-capture to detect repeated tool patterns.
	 */
	getToolUsageInWindow(params: {
		tool: string;
		argsHash: string;
		since: number;
		/** If true, include only rows not yet captured into an auto-capture memory. Default true. */
		excludeCaptured?: boolean;
	}): Array<{
		id: number;
		tool: string;
		args_hash: string;
		args_preview: string;
		timestamp: number;
		session_id: string | null;
		success: boolean;
		error_preview: string | null;
		captured_at: number | null;
	}> {
		// Auto-capture only counts uncaptured rows. Once a tool_usage row has been
		// turned into a memory, it stops contributing to the success/failure counts,
		// preventing the post-purge loop where deleted memories get re-created on
		// the next tool call.
		const excludeCaptured = params.excludeCaptured !== false;
		const capturedFilter = excludeCaptured ? " AND captured_at IS NULL" : "";
		return this.db
			.prepare(
				`SELECT id, tool, args_hash, args_preview, timestamp, session_id, success, error_preview, captured_at
				 FROM tool_usage
				 WHERE tool = ? AND args_hash = ? AND timestamp >= ?${capturedFilter}
				 ORDER BY timestamp ASC`,
			)
			.all(params.tool, params.argsHash, params.since) as any[];
	}

	/**
	 * Mark tool_usage rows as captured (turned into an auto-capture memory).
	 * Called by saveSignal after a successful memory creation to break the
	 * purge-recapture loop. Also useful for marking rows in advance when
	 * the user has already captured a pattern explicitly via /dream-purge.
	 */
	markToolUsageCaptured(params: {
		tool: string;
		argsHash: string;
		since: number;
	}): number {
		const result = this.db
			.prepare(
				`UPDATE tool_usage
				 SET captured_at = ?
				 WHERE tool = ? AND args_hash = ? AND timestamp >= ? AND captured_at IS NULL`,
			)
			.run(Date.now(), params.tool, params.argsHash, params.since);
		return result.changes;
	}

	/**
	 * Undo a previous markToolUsageCaptured by setting captured_at back to NULL.
	 * Used by /dream-purge after deleting a temporary memory: the auto-capture
	 * pipeline should be allowed to detect the same tool pattern again and
	 * potentially create a new memory if the user runs the workflow many more
	 * times. The previous implementation called markToolUsageCaptured (the
	 * opposite operation), which silently disabled auto-capture for that
	 * (tool, argsHash) tuple forever.
	 */
	markToolUsageUncaptured(params: {
		tool: string;
		argsHash: string;
		since: number;
	}): number {
		const result = this.db
			.prepare(
				`UPDATE tool_usage
				 SET captured_at = NULL
				 WHERE tool = ? AND args_hash = ? AND timestamp >= ? AND captured_at IS NOT NULL`,
			)
			.run(params.tool, params.argsHash, params.since);
		return result.changes;
	}

	getToolUsagePatterns(minFrequency: number = 5): Array<{
		tool: string;
		args_hash: string;
		args_preview: string;
		count: number;
	}> {
		return this.db
			.prepare(
				`
			SELECT tool, args_hash, args_preview, COUNT(*) as count
			FROM tool_usage
			WHERE success = 1
			GROUP BY tool, args_hash
			HAVING count >= ?
			ORDER BY count DESC
		`,
			)
			.all(minFrequency) as any[];
	}

	// ── History ───────────────────────────────────────────────────────────
	// Note: memory_history table was removed. Use memory_versions instead.

	// ── Versioning (Immutable Audit Trail) ────────────────────────────────

	/**
	 * Create an immutable version of a memory
	 * @param batchId Optional batch ID to tag the version with. Overrides metadata.batchId.
	 */
	private createVersion(memory: Memory, action: "create" | "update" | "delete", sessionId?: string, batchId?: string): void {
		const now = Date.now();
		const contentHash = createHash("sha256").update(memory.content).digest("hex");

		// Get next version number
		const lastVersion = this.db
			.prepare("SELECT MAX(version_number) as max FROM memory_versions WHERE memory_id = ?")
			.get(memory.id) as any;
		const versionNumber = (lastVersion?.max || 0) + 1;

		// batchId priority: explicit param > memory.metadata.batchId
		const effectiveBatchId = batchId || (memory.metadata as any)?.batchId;

		this.db
			.prepare(
				`
				INSERT INTO memory_versions (id, memory_id, version_number, content, scope, scope_id, target, category, status, tier, ttl_days, metadata, action, session_id, batch_id, created_at, content_hash)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`
			)
			.run(
				randomUUID(),
				memory.id,
				versionNumber,
				memory.content,
				memory.scope,
				memory.scope_id || null,
				memory.target,
				memory.category || null,
				memory.status,
				memory.tier,
				memory.ttl_days || null,
				memory.metadata ? JSON.stringify(memory.metadata) : null,
				action,
				sessionId || null,
				effectiveBatchId || null,
				now,
				contentHash,
			);
	}

	/**
	 * Get all versions for a memory
	 */
	getVersions(memoryId: string): MemoryVersion[] {
		const rows = this.db
			.prepare(
				`
				SELECT * FROM memory_versions
				WHERE memory_id = ?
				ORDER BY version_number DESC
			`
			)
			.all(memoryId) as any[];

		return rows.map((r) => ({
			...r,
			metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
		}));
	}

	/**
	 * Get a specific version
	 */
	getVersion(versionId: string): MemoryVersion | null {
		const row = this.db
			.prepare("SELECT * FROM memory_versions WHERE id = ?")
			.get(versionId) as any;

		if (!row) return null;

		return {
			...row,
			metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
		};
	}

	/**
	 * Get the latest version of a memory
	 */
	getLatestVersion(memoryId: string): MemoryVersion | null {
		const row = this.db
			.prepare(
				`
				SELECT * FROM memory_versions
				WHERE memory_id = ?
				ORDER BY version_number DESC
				LIMIT 1
			`
			)
			.get(memoryId) as any;

		if (!row) return null;

		return {
			...row,
			metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
			};
	}

	/**
	 * Rollback memory to a specific version
	 *
	 * Two cases:
	 *   1. The memory still exists: in-place update preserves the id (and
	 *      all references like `linked_to`, `synthesizedFrom`, etc.).
	 *   2. The memory was deleted: we re-insert it with the ORIGINAL id via
	 *      `restoreMemory` (not `createMemory`, which generates a new UUID).
	 *      The previous implementation called `createMemory` here, which
	 *      silently broke all external references to the old id. If the
	 *      user had linked memories or used the id elsewhere, those links
	 *      would dangle. The fix: preserve the id, preserve the original
	 *      `created_at`, but use the new `updated_at` (the rollback IS a
	 *      real edit).
	 */
	rollbackToVersion(versionId: string): Memory | null {
		const version = this.getVersion(versionId);
		if (!version) return null;

		// Check if memory still exists
		const existing = this.getMemory(version.memory_id);

		if (existing) {
			// Memory still exists: in-place update preserves the id (and all
			// external references) and extends the version history.
			return this.updateMemory(version.memory_id, {
				content: version.content,
				scope: version.scope as Memory["scope"],
				scope_id: version.scope_id,
				target: version.target as Memory["target"],
				category: version.category as Memory["category"],
				tier: version.tier as Memory["tier"],
				ttl_days: version.ttl_days,
				metadata: version.metadata,
			});
		} else {
			// Memory was deleted: re-insert with the ORIGINAL id (not a fresh
			// UUID). `restoreMemory` is the inverse of `deleteMemory` and
			// preserves `created_at` for time-based queries.
			return this.restoreMemory({
				id: version.memory_id,
				content: version.content,
				scope: version.scope as Memory["scope"],
				scope_id: version.scope_id ?? undefined,
				target: version.target as Memory["target"],
				category: version.category as Memory["category"] | undefined,
				status: "active",
				tier: version.tier as Memory["tier"],
				ttl_days: version.ttl_days ?? undefined,
				created_at: version.created_at,
				updated_at: version.created_at,
				access_count: 0,
				metadata: version.metadata,
			});
		}
	}

	/**
	 * Redact content from a version (compliance)
	 */
	redactVersion(versionId: string, reason?: string): boolean {
		const version = this.getVersion(versionId);
		if (!version) return false;

		// Can't redact current head
		const latestVersion = this.getLatestVersion(version.memory_id);
		if (latestVersion?.id === versionId) {
			throw new Error("Cannot redact current head version. Create a new version first.");
		}

		this.db
			.prepare(
				`
				UPDATE memory_versions
				SET content = ?, metadata = ?
				WHERE id = ?
			`
			)
			.run(
				"[REDACTED]",
				JSON.stringify({ redacted: true, reason: reason || "Compliance redaction", original_hash: version.content_hash }),
				versionId,
			);

		return true;
	}

	// ── Cleanup ───────────────────────────────────────────────────────────

	/**
	 * Force WAL checkpoint to ensure all data is written to main database file
	 * This is important before cloning the database to ensure consistency
	 */
	checkpoint(): void {
		this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}

	vacuum(): void {
		this.db.exec("VACUUM");
	}

	/**
	 * Prune old session_messages rows. These accumulate from session indexing
	 * and are the #1 cause of DB bloat (toolResult messages average 3.3KB each).
	 * 
	 * @param retentionDays  Delete messages older than this many days. Default 30.
	 * @returns Number of rows deleted.
	 */
	pruneSessionMessages(retentionDays: number = 30): number {
		const cutoff = Date.now() - (retentionDays * 86400000);
		const result = this.db.prepare(
			"DELETE FROM session_messages WHERE timestamp < ?"
		).run(cutoff);
		return result.changes;
	}

	/**
	 * Prune old tool_usage rows. These accumulate from every tool call and
	 * are never cleaned up. Auto-capture only needs recent history (7d lookback).
	 * 
	 * @param retentionDays  Delete rows older than this many days. Default 30.
	 * @returns Number of rows deleted.
	 */
	pruneToolUsage(retentionDays: number = 30): number {
		const cutoff = Date.now() - (retentionDays * 86400000);
		const result = this.db.prepare(
			"DELETE FROM tool_usage WHERE timestamp < ?"
		).run(cutoff);
		return result.changes;
	}

	/**
	 * Prune old memory_versions rows. These accumulate from every create/update/delete
	 * and are never cleaned up. Keep the last N versions per memory for audit trail.
	 * 
	 * @param keepLast  Number of most recent versions to keep per memory. Default 10.
	 * @returns Number of rows deleted.
	 */
	pruneOldVersions(keepLast: number = 10): number {
		const result = this.db.prepare(`
			WITH ranked AS (
				SELECT id,
					ROW_NUMBER() OVER (PARTITION BY memory_id ORDER BY version_number DESC) as rn
				FROM memory_versions
			)
			DELETE FROM memory_versions WHERE id IN (
				SELECT id FROM ranked WHERE rn > ?
			)
		`).run(keepLast);
		return result.changes;
	}

	/**
	 * Get total row counts for monitoring. Used by /dream-doctor and pruning logic.
	 */
	getRowCounts(): {
		session_messages: number;
		tool_usage: number;
		memory_versions: number;
		memories: number;
	} {
		const q = (table: string) =>
			(this.db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as any).cnt;
		return {
			session_messages: q("session_messages"),
			tool_usage: q("tool_usage"),
			memory_versions: q("memory_versions"),
			memories: q("memories"),
		};
	}

	// ── Recall Logs ────────────────────────────────────────────────────

	/**
	 * Log a recall event for observability.
	 */
	logRecall(params: {
		query: string;
		resultsCount: number;
		topScore?: number;
		latencyMs?: number;
		injectedTokens?: number;
		degraded?: boolean;
		degradationReason?: string;
		metadata?: Record<string, any>;
	}): void {
		this.db.prepare(`
			INSERT INTO recall_logs (query, results_count, top_score, latency_ms, injected_tokens, degraded, degradation_reason, metadata, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			params.query,
			params.resultsCount,
			params.topScore ?? null,
			params.latencyMs ?? null,
			params.injectedTokens ?? null,
			params.degraded ? 1 : 0,
			params.degradationReason ?? null,
			params.metadata ? JSON.stringify(params.metadata) : null,
			Date.now(),
		);
	}

	/**
	 * Get recent recall logs for diagnostics.
	 */
	getRecallLogs(limit: number = 20): Array<{
		id: number;
		query: string;
		results_count: number;
		top_score: number | null;
		latency_ms: number | null;
		injected_tokens: number | null;
		degraded: boolean;
		degradation_reason: string | null;
		metadata: Record<string, any> | null;
		created_at: number;
	}> {
		const rows = this.db.prepare(
			"SELECT * FROM recall_logs ORDER BY created_at DESC LIMIT ?"
		).all(limit) as any[];
		return rows.map(r => ({
			...r,
			degraded: r.degraded === 1,
			metadata: r.metadata ? JSON.parse(r.metadata) : null,
		}));
	}

	/**
	 * Get recall stats for /dream-metrics.
	 */
	getRecallStats(): {
		totalRecalls: number;
		avgTopScore: number | null;
		degradedCount: number;
		avgLatencyMs: number | null;
	} {
		const row = this.db.prepare(`
			SELECT 
				COUNT(*) as total,
				AVG(top_score) as avg_top_score,
				SUM(degraded) as degraded_count,
				AVG(latency_ms) as avg_latency
			FROM recall_logs
		`).get() as any;
		return {
			totalRecalls: row.total || 0,
			avgTopScore: row.avg_top_score,
			degradedCount: row.degraded_count || 0,
			avgLatencyMs: row.avg_latency,
		};
	}

	/**
	 * Get session messages not yet processed by retrospective.
	 */
	getUnprocessedMessages(afterId: number, limit: number): Array<{
		id: number;
		role: string;
		content: string;
		timestamp: number;
	}> {
		return this.db.prepare(`
			SELECT id, role, content, timestamp
			FROM session_messages
			WHERE id > ? AND role IN ('user', 'assistant')
			ORDER BY id ASC
			LIMIT ?
		`).all(afterId, limit) as any[];
	}

	close(): void {
		this.db.close();
	}

	// ── Helpers ───────────────────────────────────────────────────────────

	/**
	 * Drop the IDF cache. Called whenever the memories table mutates
	 * (create/update/delete) so stale document frequencies don't survive.
	 */
	private invalidateIdfCache(): void {
		this.idfCache.clear();
	}

	/**
	 * Public hook for cross-store operations (e.g., BankManager.moveMemory).
	 * When a memory moves into this store from another file, this store's
	 * IDF cache is stale (it gained tokens that the cache doesn't reflect).
	 * Exposed publicly so the caller can clear it without subclassing.
	 */
	invalidateIdfCachePublic(): void {
		this.invalidateIdfCache();
	}

	private parseRow(row: any): Memory {
		return {
			...row,
			metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
			embedding: row.embedding ?? undefined,
			// Normalize SQL NULL to undefined for these too. Without this,
			// a memory with no provenance would surface as `source_session_id: null`
			// while the type says `string | undefined` — and the recall output
			// would render "null" instead of omitting the attribute. Matches
			// the existing pattern for `embedding` above.
			source_session_id: row.source_session_id ?? undefined,
			source_turn_id: row.source_turn_id ?? undefined,
			valid_from: row.valid_from ?? undefined,
			valid_until: row.valid_until ?? undefined,
			topic_key: row.topic_key ?? undefined,
		};
	}

	private hashString(str: string): string {
		return createHash("sha256").update(str).digest("hex").slice(0, 16);
	}

	/**
	 * Coerce a value into a non-negative integer suitable for SQLite LIMIT binding.
	 * SQLite's LIMIT parameter requires INTEGER; floats and strings cause
	 * SQLITE_MISMATCH and crash the tool. Returns 0 for any value that can't be
	 * converted to a non-negative integer (caller decides what to do with 0).
	 *
	 * Warning policy: pathological inputs (non-numeric strings, NaN, negative
	 * numbers) always log a warning — they indicate a bug in the caller.
	 * Float truncation (0.5 → 0) is silent because it's a common and
	 * harmless case (e.g., `Math.ceil(n / 2)`). The previous implementation
	 * gated ALL warnings behind DREAM_DEBUG=1, hiding caller bugs from prod.
	 */
	private coerceLimit(value: unknown): number {
		if (typeof value === "number" && Number.isFinite(value)) {
			const truncated = Math.trunc(value);
			if (truncated !== value) {
				// Float passed where int expected. Common case: user computes
				// `Math.ceil(searchResults.length / 2)` and forgets to floor.
				// Silent — see warning policy in the docblock.
			}
			if (truncated < 0) {
				console.warn(
					`[dream] coerceLimit: negative limit ${value} clamped to 0 (caller bug)`,
				);
			}
			return Math.max(0, truncated);
		}
		if (typeof value === "string") {
			const n = parseInt(value, 10);
			if (Number.isFinite(n)) {
				console.warn(
					`[dream] coerceLimit: string "${value}" coerced to ${n} (caller should pass a number)`,
				);
				return Math.max(0, n);
			}
		}
		console.warn(
			`[dream] coerceLimit: ${String(value)} → 0 (could not coerce to integer; caller bug)`,
		);
		return 0;
	}

	/**
	 * Public alias for hashString — exposed for auto-capture to compute matching
	 * args hashes (so we can correlate tool calls across trackToolCall and detectToolSignals).
	 *
	 * Note: callers SHOULD pre-canonicalize the JSON before passing here, so that
	 * the same logical args produce the same hash regardless of key insertion order.
	 * Use `canonicalJsonStringify(value)` from this module.
	 */
	computeArgsHash(argsStr: string): string {
		return this.hashString(argsStr);
	}
}

/**
 * Canonical JSON stringification with sorted keys (recursive).
 * Ensures `{a:1,b:2}` and `{b:2,a:1}` produce identical strings, so their
 * SHA-256 hashes match. Without this, semantically identical tool calls
 * (e.g. `bash` with `{command, cwd}` and `bash` with `{cwd, command}`) split
 * into different rows in `tool_usage`, starving auto-capture's pattern detection.
 */
export function canonicalJsonStringify(value: any): string {
	// Per-call cycle detection (WeakSet) + per-call memoization (WeakMap) on
	// the result of sortedStringify. Without memoization, if the same object
	// appears multiple times in the args tree (e.g., a shared config object
	// referenced by both `args` and `metadata`), we'd recompute its canonical
	// string on each visit. With memoization, the second visit is O(1).
	//
	// The WeakMap holds objects → their canonical strings. We use the
	// recursive helper's `seen` set for cycle detection (this is
	// single-pass semantics, so we can't reuse the memo for cycle check).
	const seen = new WeakSet();
	const memo = new WeakMap<object, string>();
	const sortedStringify = (v: any): string => {
		if (v === null) return "null";
		if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
		if (typeof v === "string") return JSON.stringify(v);
		if (typeof v === "boolean") return String(v);
		if (Array.isArray(v)) {
			return "[" + v.map(sortedStringify).join(",") + "]";
		}
		if (typeof v === "object") {
			// Memoization: same object reference → same canonical string
			const cached = memo.get(v);
			if (cached !== undefined) return cached;
			if (seen.has(v)) return "null"; // circular ref protection
			seen.add(v);
			const keys = Object.keys(v).sort();
			const pairs = keys.map((k) => JSON.stringify(k) + ":" + sortedStringify(v[k]));
			const result = "{" + pairs.join(",") + "}";
			memo.set(v, result);
			return result;
		}
		return "null";
	};
	return sortedStringify(value);
}
