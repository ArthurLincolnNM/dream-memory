import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { scopedSearch, type StorePair } from "../search/hybrid.js";

function makeStores() {
    const dir = mkdtempSync(join(tmpdir(), "dm-spread-test-"));
    const global = new DreamStore(join(dir, "global.db"));
    const cleanup = () => { global.close(); rmSync(dir, { recursive: true, force: true }); };
    const stores: StorePair = { global, project: null, projectId: null };
    return { stores, global, dir, cleanup };
}

test("link expansion reaches 2-hop via spreading activation", () => {
    const { stores, global, cleanup } = makeStores();
    try {
        // Create chain: A → B → C
        const a = global.createMemory({ content: "memory A about vim", scope: "global", target: "user", tier: "factual" });
        const b = global.createMemory({ content: "memory B about neovim", scope: "global", target: "user", tier: "factual" });
        const c = global.createMemory({ content: "memory C about telescope plugin", scope: "global", target: "user", tier: "factual" });
        // Link A→B and B→C
        global.updateLinkedTo(a.id, [{ id: b.id, relation: "related_to" }]);
        global.updateLinkedTo(b.id, [{ id: c.id, relation: "related_to" }]);
        // Search for "vim" — should find A directly, B via 1-hop, C via 2-hop
        const results = scopedSearch(stores, "vim", { applyDecay: false, semanticQuery: null });
        const ids = results.map(r => r.memory.id);
        assert.ok(ids.includes(a.id), "A should be direct match");
        assert.ok(ids.includes(b.id), "B should be found via 1-hop");
        assert.ok(ids.includes(c.id), "C should be found via 2-hop");
        // Verify dampening: direct > 1-hop > 2-hop
        const scoreA = results.find(r => r.memory.id === a.id)!.score;
        const scoreB = results.find(r => r.memory.id === b.id)!.score;
        const scoreC = results.find(r => r.memory.id === c.id)!.score;
        assert.ok(scoreA > scoreB, `Direct (${scoreA}) > 1-hop (${scoreB})`);
        assert.ok(scoreB > scoreC, `1-hop (${scoreB}) > 2-hop (${scoreC})`);
    } finally { cleanup(); }
});

test("3-hop is NOT reached (maxHops=2)", () => {
    const { stores, global, cleanup } = makeStores();
    try {
        const a = global.createMemory({ content: "A", scope: "global", target: "user", tier: "factual" });
        const b = global.createMemory({ content: "B", scope: "global", target: "user", tier: "factual" });
        const c = global.createMemory({ content: "C", scope: "global", target: "user", tier: "factual" });
        const d = global.createMemory({ content: "D about unique_term_xyz", scope: "global", target: "user", tier: "factual" });
        // Links go FROM D outward: D→C→B→A
        global.updateLinkedTo(d.id, [{ id: c.id, relation: "related_to" }]);
        global.updateLinkedTo(c.id, [{ id: b.id, relation: "related_to" }]);
        global.updateLinkedTo(b.id, [{ id: a.id, relation: "related_to" }]);
        const results = scopedSearch(stores, "unique_term_xyz", { applyDecay: false, semanticQuery: null });
        const ids = results.map(r => r.memory.id);
        assert.ok(ids.includes(d.id), "D should be direct");
        assert.ok(ids.includes(c.id), "C should be 1-hop");
        assert.ok(ids.includes(b.id), "B should be 2-hop (maxHops=2 allows hop 2)");
        assert.ok(!ids.includes(a.id), "A should NOT be 3-hop (maxHops=2 limits expansion)");
    } finally { cleanup(); }
});
