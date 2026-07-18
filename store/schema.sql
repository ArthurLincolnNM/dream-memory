-- dream-memory: SQLite schema
-- Version: 1

-- Memórias principais
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    scope TEXT NOT NULL,              -- global|project|agent|session
    scope_id TEXT,                    -- project name, agent name, session id
    target TEXT NOT NULL,             -- user|memory|project|failure
    category TEXT,                    -- failure|correction|insight|preference|convention|tool-quirk
    status TEXT NOT NULL DEFAULT 'active',  -- active|resolved|superseded
    tier TEXT NOT NULL DEFAULT 'factual',  -- factual|operational
    ttl_days INTEGER,                 -- NULL = permanente
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_accessed_at INTEGER,
    access_count INTEGER DEFAULT 0,
    embedding BLOB,                   -- 384-dim vector (float32) -- see embeddings/embed.ts
    metadata TEXT,                    -- JSON
    confidence TEXT DEFAULT 'explicit', -- explicit|inferred|outdated|synthesized
    utility_score REAL NOT NULL DEFAULT 0.0, -- F3: recall feedback signal.
                                            -- 0.05 boost when memory was in recall and next
                                            -- tool call used it; -0.10 when a contradiction
                                            -- was discarded (memory was wrong). Used as
                                            -- a multiplier in calculateDecay.
    expires_at INTEGER,               -- updated_at + ttl_days*86400000, NULL = permanent.
                                      -- Materialized for sargable TTL queries (see
                                      -- v1.4 migration); partial index below.
    source_session_id TEXT,           -- v1.6 provenance: which session learned this memory
    source_turn_id INTEGER,           -- v1.6 provenance: which turn (1-indexed) within
                                      -- that session. Both nullable for backward compat
                                      -- with memories created before provenance existed.
    memory_kind TEXT DEFAULT 'semantic',  -- v1.7 episodic vs semantic
    mytags TEXT DEFAULT '[]',             -- v1.8 JSON array of free-form mytags
    trust_level INTEGER DEFAULT 2         -- v2.0 trust hierarchy (0-3)
);

-- Índices para busca rápida
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_memories_target ON memories(target);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_ttl ON memories(ttl_days, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_access ON memories(last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
-- Partial index on expires_at: only rows with a non-NULL value (i.e., non-
-- permanent memories) are indexed. Permanent memories are excluded from the
-- index entirely, which keeps it small and the SCAN fast. The query
-- `WHERE expires_at IS NOT NULL AND expires_at < ?` uses this index.
CREATE INDEX IF NOT EXISTS idx_memories_expires
    ON memories(expires_at)
    WHERE expires_at IS NOT NULL;

-- FTS5 para busca textual
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content=memories,
    content_rowid=rowid
);

-- Triggers para manter FTS sincronizado
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Histórico de mudanças: usando memory_versions (tabela memory_history removida)

-- Tool usage tracking (para Distill)
CREATE TABLE IF NOT EXISTS tool_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool TEXT NOT NULL,
    args_hash TEXT NOT NULL,          -- SHA-256 dos args
    args_preview TEXT,                -- Primeiros 200 chars dos args
    timestamp INTEGER NOT NULL,
    session_id TEXT,
    success INTEGER NOT NULL DEFAULT 1,
    error_preview TEXT,               -- Sample of error message (for failure pattern detection)
    captured_at INTEGER               -- When this usage was turned into an auto-capture memory (NULL = not yet captured)
);

CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool);
CREATE INDEX IF NOT EXISTS idx_tool_usage_hash ON tool_usage(args_hash);
CREATE INDEX IF NOT EXISTS idx_tool_usage_timestamp ON tool_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_usage_captured ON tool_usage(captured_at);

-- Stats
CREATE TABLE IF NOT EXISTS stats (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Immutable version history (audit trail)
CREATE TABLE IF NOT EXISTS memory_versions (
    id TEXT PRIMARY KEY,           -- UUID
    memory_id TEXT NOT NULL,       -- Original memory ID
    version_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_id TEXT,
    target TEXT NOT NULL,
    category TEXT,
    status TEXT,                   -- active|resolved|superseded
    tier TEXT NOT NULL,
    ttl_days INTEGER,
    metadata TEXT,
    action TEXT NOT NULL,          -- create|update|delete
    session_id TEXT,
    batch_id TEXT,                 -- NULL = pre-batch, or batch UUID
    created_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL     -- SHA-256 for optimistic concurrency
);

CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id);
CREATE INDEX IF NOT EXISTS idx_versions_number ON memory_versions(memory_id, version_number);
CREATE INDEX IF NOT EXISTS idx_versions_created ON memory_versions(created_at);
CREATE INDEX IF NOT EXISTS idx_versions_batch ON memory_versions(batch_id);

-- v1.5: Confidence / provenance tracking (Memanto D3 desiderata)
-- Column added via migration in sqlite.ts runMigrations().
-- Index is safe in schema (CREATE INDEX IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);

-- Note: dream_sessions table removed (was never written to)

-- v1.6: Provenance / citation tracking (Perplexity Brain style)
-- Lets the agent trace any recalled memory back to the session+turn where
-- it was learned. Indexed for fast lookup of "show me all memories learned
-- in session X" -- useful for audit and for `/dream-popup`-style traces.
CREATE INDEX IF NOT EXISTS idx_memories_provenance
    ON memories(source_session_id, source_turn_id)
    WHERE source_session_id IS NOT NULL;

-- v1.7: memory_kind index (episodic vs semantic). Btree on a low-cardinality
-- column is cheap; the index supports future filtering like "skip episodic in
-- recall" or "show only synthesized" without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(memory_kind);

-- v1.8: mytags index. JSON array stored as TEXT. SQLite has no native JSON
-- index, but a covering index on the column is cheap and supports filtering
-- via JSON1 functions (json_each, json_extract). Low-cardinality column
-- like this is fine for btree.
CREATE INDEX IF NOT EXISTS idx_memories_mytags ON memories(mytags);

-- v2.0: Trust hierarchy index. Low-cardinality column (0-3), btree is
-- fine. Supports queries like "show only user_stated memories" and the
-- trust-aware contradiction resolution in detector.ts.
CREATE INDEX IF NOT EXISTS idx_memories_trust ON memories(trust_level);

-- v1.9: Session history search — index past conversation messages for FTS5 search.
-- Session JSONL files are parsed and inserted here by sessions/indexer.ts.
CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_file TEXT NOT NULL,
    session_id TEXT,
    message_id TEXT,
    role TEXT NOT NULL,           -- user | assistant | toolResult
    content TEXT NOT NULL,        -- extracted text content
    timestamp INTEGER NOT NULL,  -- message timestamp ms
    parent_id TEXT,
    metadata TEXT,               -- JSON: tool names, model, usage, etc.
    indexed_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
    content,
    content=session_messages,
    content_rowid=id,
    tokenize='porter unicode61'
);

CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_file);
CREATE INDEX IF NOT EXISTS idx_session_messages_role ON session_messages(role);
CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);

-- v2.1: Structured recall logs for observability
CREATE TABLE IF NOT EXISTS recall_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    results_count INTEGER NOT NULL DEFAULT 0,
    top_score REAL,
    latency_ms INTEGER,
    injected_tokens INTEGER,
    degraded INTEGER NOT NULL DEFAULT 0,
    degradation_reason TEXT,
    metadata TEXT,  -- JSON: { scores: [], categories: {}, intent: "..." }
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recall_logs_created ON recall_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_recall_logs_degraded ON recall_logs(degraded) WHERE degraded = 1;
