import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DreamStore } from "../store/sqlite.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

function createTestStore(): DreamStore {
  const dir = mkdtempSync(join(tmpdir(), "dream-test-"));
  return new DreamStore(join(dir, "test.db"));
}

describe("Temporal validity (v2.2)", () => {
  it("sets valid_from to created_at by default", () => {
    const store = createTestStore();
    const mem = store.createMemory({
      content: "User prefers vim",
      scope: "global",
      target: "user",
      tier: "factual",
    });
    assert.ok(mem.valid_from, "valid_from should be set");
    assert.equal(mem.valid_from, mem.created_at, "valid_from should equal created_at");
    assert.equal(mem.valid_until, undefined, "valid_until should be null/undefined");
  });

  it("marks superseded fact with valid_until", () => {
    const store = createTestStore();
    const mem = store.createMemory({
      content: "User prefers vim",
      scope: "global",
      target: "user",
      tier: "factual",
    });
    
    const now = Date.now();
    // Simulate contradiction: set valid_until
    store.db.prepare("UPDATE memories SET valid_until = ? WHERE id = ?").run(now, mem.id);
    
    const updated = store.getMemory(mem.id)!;
    assert.ok(updated.valid_until, "valid_until should be set");
    assert.ok(updated.valid_until! <= now, "valid_until should be <= now");
  });

  it("getExpiredMemories includes facts with valid_until in the past", () => {
    const store = createTestStore();
    const mem = store.createMemory({
      content: "User prefers vim",
      scope: "global",
      target: "user",
      tier: "factual",
      // No TTL — this is a permanent fact
    });
    
    // Set valid_until to 1 hour ago
    const oneHourAgo = Date.now() - 3600000;
    store.db.prepare("UPDATE memories SET valid_until = ? WHERE id = ?").run(oneHourAgo, mem.id);
    
    const expired = store.getExpiredMemories();
    assert.ok(expired.some(m => m.id === mem.id), "fact with past valid_until should be expired");
  });

  it("does not expire facts with valid_until in the future", () => {
    const store = createTestStore();
    const mem = store.createMemory({
      content: "User prefers vim",
      scope: "global",
      target: "user",
      tier: "factual",
    });
    
    const future = Date.now() + 86400000; // tomorrow
    store.db.prepare("UPDATE memories SET valid_until = ? WHERE id = ?").run(future, mem.id);
    
    const expired = store.getExpiredMemories();
    assert.ok(!expired.some(m => m.id === mem.id), "fact with future valid_until should NOT be expired");
  });

  it("keeps operational memories using TTL path", () => {
    const store = createTestStore();
    const mem = store.createMemory({
      content: "Debug note about bug X",
      scope: "global",
      target: "failure",
      tier: "operational",
      ttl_days: 7,
    });
    
    // valid_until should be null for operational
    assert.equal(mem.valid_until, undefined, "operational memory should not have valid_until");
  });
});
