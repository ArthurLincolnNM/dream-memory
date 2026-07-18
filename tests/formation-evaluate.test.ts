import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { evaluateMemory } from "../capture/evaluate.js";

function makeStore() {
    const dir = mkdtempSync(join(tmpdir(), "dm-formation-test-"));
    const store = new DreamStore(join(dir, "test.db"));
    return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("empty store → high novelty (1.0)", () => {
    const result = evaluateMemory("User prefers dark mode", "preference", "user", []);
    assert.equal(result.novelty, 1.0, "Empty store should have novelty 1.0");
    assert.equal(result.classification, "core", "Preference in empty store should be core");
});

test("duplicate content → low novelty", () => {
    const { store, cleanup } = makeStore();
    try {
        store.createMemory({ content: "User prefers dark mode", scope: "global", target: "user", category: "preference" });
        const existing = store.listMemories({ limit: 10 });
        const result = evaluateMemory("User prefers dark mode", "preference", "user", existing);
        assert.ok(result.novelty < 0.3, `Duplicate should have low novelty: ${result.novelty}`);
    } finally { cleanup(); }
});

test("specific content with paths → high specificity", () => {
    const result = evaluateMemory("Fixed bug in /home/user/project/src/index.ts line 42", "correction", "project", []);
    assert.ok(result.specificity > 0.5, `Specific content should have high specificity: ${result.specificity}`);
});

test("generic content → low specificity", () => {
    const result = evaluateMemory("something is good", "insight", "project", []);
    assert.ok(result.specificity < 0.3, `Generic content should have low specificity: ${result.specificity}`);
});

test("correction category → high actionability", () => {
    const result = evaluateMemory("Always use --legacy-peer-deps when npm install fails", "correction", "project", []);
    assert.ok(result.actionability > 0.7, `Correction should have high actionability: ${result.actionability}`);
});

test("insight category → lower actionability", () => {
    const result = evaluateMemory("The codebase uses TypeScript", "insight", "project", []);
    assert.ok(result.actionability < 0.6, `Insight should have lower actionability: ${result.actionability}`);
});

test("very short content → reduced actionability", () => {
    const result = evaluateMemory("ok", "preference", "user", []);
    assert.ok(result.actionability < 0.5, `Very short content should have reduced actionability: ${result.actionability}`);
});

test("classification thresholds: core ≥ 0.6, contextual ≥ 0.35, ephemeral < 0.35", () => {
    // Core: high novelty + high specificity + high actionability
    const core = evaluateMemory("Fixed TypeError in /src/auth.ts line 42: always check null before access", "correction", "project", []);
    assert.equal(core.classification, "core", "High-quality memory should be core");
    
    // Ephemeral: low novelty (duplicate)
    const { store, cleanup } = makeStore();
    try {
        store.createMemory({ content: "test content here", scope: "global", target: "user" });
        store.createMemory({ content: "another test content", scope: "global", target: "user" });
        const existing = store.listMemories({ limit: 10 });
        const ephemeral = evaluateMemory("test content here", "insight", "user", existing);
        assert.equal(ephemeral.classification, "ephemeral", "Duplicate should be ephemeral");
    } finally { cleanup(); }
});
