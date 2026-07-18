import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";

function makeStore() {
    const dir = mkdtempSync(join(tmpdir(), "dm-auto-relations-test-"));
    const store = new DreamStore(join(dir, "test.db"));
    return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("findRelatedMemories returns memories with overlapping content", () => {
    const { store, cleanup } = makeStore();
    try {
        store.createMemory({ content: "User prefers dark mode in VSCode", scope: "global", target: "user", category: "preference", tags: ["vscode", "dark-mode"] });
        store.createMemory({ content: "User uses vim keybindings in VSCode", scope: "global", target: "user", category: "convention", tags: ["vscode", "vim"] });
        const related = store.findRelatedMemories("VSCode preferences", { topK: 5, minScore: 0.0 });
        assert.ok(related.length >= 1, "Should find related memories");
    } finally { cleanup(); }
});

test("updateLinkedTo creates edge between memories", () => {
    const { store, cleanup } = makeStore();
    try {
        const m1 = store.createMemory({ content: "npm fails on Node 22", scope: "global", target: "failure", category: "failure", tags: ["npm", "node22"] });
        const m2 = store.createMemory({ content: "Fixed npm by using --legacy-peer-deps", scope: "global", target: "failure", category: "correction", tags: ["npm", "node22"] });
        store.updateLinkedTo(m1.id, [{ id: m2.id, relation: "corrects" }]);
        const links = store.getMemory(m1.id)?.metadata?.linked_to;
        assert.ok(Array.isArray(links), "linked_to should be an array");
        assert.equal(links.length, 1);
        assert.equal(links[0].id, m2.id);
        assert.equal(links[0].relation, "corrects");
    } finally { cleanup(); }
});

test("EDGE_TYPE_RULES has expected mappings", async () => {
    const { EDGE_TYPE_RULES } = await import("../utils/constants.js");
    assert.ok(EDGE_TYPE_RULES["failure::correction"], "failure::correction should exist");
    assert.ok(EDGE_TYPE_RULES["insight::preference"], "insight::preference should exist");
    assert.ok(EDGE_TYPE_RULES["failure::failure"], "failure::failure should exist");
});
