import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "dm-recall-log-test-"));
    const store = new DreamStore(join(dir, "test.db"));
    return {
        store,
        dir,
        cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
    };
}

test("logRecall inserts a recall log entry", () => {
    const { store, cleanup } = makeStore();
    try {
        store.logRecall({ query: "test query", resultsCount: 5, topScore: 0.8 });
        const logs = store.getRecallLogs();
        assert.equal(logs.length, 1);
        assert.equal(logs[0].query, "test query");
        assert.equal(logs[0].results_count, 5);
        assert.equal(logs[0].top_score, 0.8);
        assert.equal(logs[0].degraded, false);
    } finally { cleanup(); }
});

test("logRecall with degradation", () => {
    const { store, cleanup } = makeStore();
    try {
        store.logRecall({ query: "degraded", resultsCount: 0, degraded: true, degradationReason: "qdrant down" });
        const logs = store.getRecallLogs();
        assert.equal(logs[0].degraded, true);
        assert.equal(logs[0].degradation_reason, "qdrant down");
    } finally { cleanup(); }
});

test("getRecallLogs returns most recent first", () => {
    const { store, cleanup } = makeStore();
    try {
        store.logRecall({ query: "first", resultsCount: 1 });
        store.logRecall({ query: "second", resultsCount: 2 });
        const logs = store.getRecallLogs();
        assert.equal(logs.length, 2);
        assert.equal(logs[0].query, "second");
        assert.equal(logs[1].query, "first");
    } finally { cleanup(); }
});

test("getRecallStats computes aggregates", () => {
    const { store, cleanup } = makeStore();
    try {
        store.logRecall({ query: "a", resultsCount: 3, topScore: 0.9, latencyMs: 10 });
        store.logRecall({ query: "b", resultsCount: 0, degraded: true, latencyMs: 50 });
        const stats = store.getRecallStats();
        assert.equal(stats.totalRecalls, 2);
        assert.equal(stats.degradedCount, 1);
        assert.ok(stats.avgTopScore !== null);
        assert.ok(stats.avgLatencyMs !== null);
    } finally { cleanup(); }
});

test("recall_logs table exists after schema init", () => {
    const { store, cleanup } = makeStore();
    try {
        // If table doesn't exist, getRecallLogs will throw
        const logs = store.getRecallLogs();
        assert.ok(Array.isArray(logs));
    } finally { cleanup(); }
});
