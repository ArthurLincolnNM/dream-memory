import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";

function makeStore() {
    const dir = mkdtempSync(join(tmpdir(), "dm-audit-test-"));
    const store = new DreamStore(join(dir, "test.db"));
    return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("audit on empty store returns zero counts", () => {
    const { store, cleanup } = makeStore();
    try {
        const result = store.audit();
        assert.equal(result.totalMemories, 0);
        assert.deepEqual(result.entityConcentration, []);
        assert.deepEqual(result.orphanMemories, []);
    } finally { cleanup(); }
});

test("audit detects entity concentration", () => {
    const { store, cleanup } = makeStore();
    try {
        // Create 6 memories all tagged with "typescript"
        for (let i = 0; i < 6; i++) {
            store.createMemory({ content: `TypeScript tip ${i}`, scope: "global", target: "project", tags: ["typescript"] });
        }
        const result = store.audit();
        assert.ok(result.entityConcentration.length >= 1, "Should detect concentrated entity");
        assert.equal(result.entityConcentration[0].entity, "typescript");
        assert.equal(result.entityConcentration[0].count, 6);
    } finally { cleanup(); }
});

test("audit detects orphan memories", () => {
    const { store, cleanup } = makeStore();
    try {
        // Orphan: no tags, no links, short content
        store.createMemory({ content: "ok", scope: "global", target: "user" });
        // Non-orphan: has tags
        store.createMemory({ content: "has tags", scope: "global", target: "user", tags: ["vim"] });
        const result = store.audit();
        assert.ok(result.orphanMemories.length >= 1, "Should detect orphan");
        assert.equal(result.orphanMemories[0].content, "ok");
    } finally { cleanup(); }
});

test("audit counts category distribution", () => {
    const { store, cleanup } = makeStore();
    try {
        store.createMemory({ content: "pref 1", scope: "global", target: "user", category: "preference" });
        store.createMemory({ content: "pref 2", scope: "global", target: "user", category: "preference" });
        store.createMemory({ content: "conv 1", scope: "global", target: "project", category: "convention" });
        const result = store.audit();
        assert.equal(result.categoryDistribution["preference"], 2);
        assert.equal(result.categoryDistribution["convention"], 1);
    } finally { cleanup(); }
});

test("audit excludes superseded from entity count", () => {
    const { store, cleanup } = makeStore();
    try {
        // Create 10 memories, supersede 4 → 6 remain active (still >5 threshold)
        for (let i = 0; i < 10; i++) {
          const m = store.createMemory({ content: `mem ${i}`, scope: "global", target: "user", tags: ["test-tag"] });
          if (i < 4) store.updateMemory(m.id, { status: "superseded" });
        }
        const result = store.audit();
        const testTag = result.entityConcentration.find(e => e.entity === "test-tag");
        assert.equal(testTag?.count, 6, "Should only count active memories");
    } finally { cleanup(); }
});
