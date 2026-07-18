import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { calculateDecay } from "../ttl/decay.js";

function makeStore() {
    const dir = mkdtempSync(join(tmpdir(), "dm-ebbinghaus-test-"));
    const store = new DreamStore(join(dir, "test.db"));
    return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("fresh memory has high decay (near MAX_DECAY)", () => {
    const { store, cleanup } = makeStore();
    try {
        const mem = store.createMemory({ content: "test", scope: "global", target: "user", tier: "factual" });
        const decay = calculateDecay(mem);
        assert.ok(decay > 0.8, `Expected > 0.8, got ${decay}`);
        assert.ok(decay <= 0.95, `Expected <= 0.95, got ${decay}`);
    } finally { cleanup(); }
});

test("old memory (30d) has significantly lower decay", () => {
    const { store, cleanup } = makeStore();
    try {
        const mem = store.createMemory({ content: "old", scope: "global", target: "user", tier: "operational" });
        store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(Date.now() - 30 * 86400000, mem.id);
        const refreshed = store.getMemory(mem.id)!;
        const decay = calculateDecay(refreshed);
        assert.ok(decay < 0.5, `Expected < 0.5 for 30d old, got ${decay}`);
    } finally { cleanup(); }
});

test("reinforced memory decays slower than unreinforced", () => {
    const { store, cleanup } = makeStore();
    try {
        const mem1 = store.createMemory({ content: "no reinforce", scope: "global", target: "user", tier: "factual" });
        const mem2 = store.createMemory({ content: "reinforced", scope: "global", target: "user", tier: "factual" });
        // Simulate age
        const thirtyDaysAgo = Date.now() - 30 * 86400000;
        store.db.prepare("UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?").run(thirtyDaysAgo, thirtyDaysAgo, mem1.id);
        store.db.prepare("UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?").run(thirtyDaysAgo, thirtyDaysAgo, mem2.id);
        // Reinforce mem2 twice
        store.trackReinforcement(mem2.id);
        store.trackReinforcement(mem2.id);
        const r1 = calculateDecay(store.getMemory(mem1.id)!);
        const r2 = calculateDecay(store.getMemory(mem2.id)!);
        assert.ok(r2 > r1, `Reinforced (${r2}) should decay slower than unreinforced (${r1})`);
    } finally { cleanup(); }
});

test("trackReinforcement bumps stability × 1.5", () => {
    const { store, cleanup } = makeStore();
    try {
        const mem = store.createMemory({ content: "test", scope: "global", target: "user", tier: "factual" });
        const before = (store.getMemory(mem.id) as any).stability;
        assert.equal(before, 14);
        store.trackReinforcement(mem.id);
        const after = (store.getMemory(mem.id) as any).stability;
        assert.ok(Math.abs(after - 21) < 0.01, `Expected ~21, got ${after}`);
        store.trackReinforcement(mem.id);
        const after2 = (store.getMemory(mem.id) as any).stability;
        assert.ok(Math.abs(after2 - 31.5) < 0.01, `Expected ~31.5, got ${after2}`);
    } finally { cleanup(); }
});

test("trackReinforcement increments reinforcement_count", () => {
    const { store, cleanup } = makeStore();
    try {
        const mem = store.createMemory({ content: "test", scope: "global", target: "user", tier: "factual" });
        assert.equal((store.getMemory(mem.id) as any).reinforcement_count, 0);
        store.trackReinforcement(mem.id);
        assert.equal((store.getMemory(mem.id) as any).reinforcement_count, 1);
        store.trackReinforcement(mem.id);
        assert.equal((store.getMemory(mem.id) as any).reinforcement_count, 2);
    } finally { cleanup(); }
});

test("stability field exists on new memories", () => {
    const { store, cleanup } = makeStore();
    try {
        const mem = store.createMemory({ content: "test", scope: "global", target: "user", tier: "factual" });
        const full = store.getMemory(mem.id)!;
        assert.ok((full as any).stability !== undefined);
        assert.equal((full as any).stability, 14);
    } finally { cleanup(); }
});
