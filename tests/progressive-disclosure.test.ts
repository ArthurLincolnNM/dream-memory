import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { hybridSearch } from "../search/hybrid.js";

function makeStore() {
    const dir = mkdtempSync(join(tmpdir(), "dm-progressive-test-"));
    const store = new DreamStore(join(dir, "test.db"));
    return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("summaryMode truncates content to 80 chars", () => {
    const { store, cleanup } = makeStore();
    try {
        store.createMemory({ 
            content: "This is a very long memory content that should be truncated when summaryMode is enabled because it exceeds eighty characters easily", 
            scope: "global", target: "user", category: "preference" 
        });
        const results = hybridSearch(store, "memory content", { summaryMode: true, topK: 5 });
        assert.ok(results.length > 0, "Should return results");
        assert.ok(results[0].memory.content.length <= 82, `Content should be truncated: ${results[0].memory.content.length}`);
        assert.ok(results[0].memory.content.endsWith("…"), "Should end with ellipsis");
    } finally { cleanup(); }
});

test("summaryMode preserves short content", () => {
    const { store, cleanup } = makeStore();
    try {
        store.createMemory({ content: "short", scope: "global", target: "user" });
        const results = hybridSearch(store, "short", { summaryMode: true, topK: 5 });
        assert.ok(results.length > 0);
        assert.equal(results[0].memory.content, "short");
    } finally { cleanup(); }
});

test("without summaryMode, full content is returned", () => {
    const { store, cleanup } = makeStore();
    try {
        const longContent = "This is a very long memory content that should NOT be truncated when summaryMode is disabled because the default behavior returns full content";
        store.createMemory({ content: longContent, scope: "global", target: "user" });
        const results = hybridSearch(store, "memory content", { topK: 5 });
        assert.ok(results.length > 0);
        assert.equal(results[0].memory.content, longContent);
    } finally { cleanup(); }
});

test("summaryMode preserves metadata fields", () => {
    const { store, cleanup } = makeStore();
    try {
        store.createMemory({ 
            content: "User prefers TypeScript with strict mode enabled for all projects and uses ESM modules", 
            scope: "global", target: "user", category: "preference", tags: ["typescript", "strict"] 
        });
        const results = hybridSearch(store, "TypeScript strict", { summaryMode: true, topK: 5 });
        assert.ok(results.length > 0);
        assert.equal(results[0].memory.target, "user");
        assert.equal(results[0].memory.category, "preference");
        // tags stored as mytags column (JSON string in SQLite)
        const mytags = (results[0].memory as any).mytags;
        assert.ok(mytags, "mytags column should be present");
        assert.deepEqual(JSON.parse(mytags), ["typescript", "strict"]);
    } finally { cleanup(); }
});
