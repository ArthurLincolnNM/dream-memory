import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { runRetrospective } from "../retrospective.js";

function makeStore() {
    const dir = mkdtempSync(join(tmpdir(), "dm-retro-test-"));
    const store = new DreamStore(join(dir, "test.db"));
    return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function insertMessage(store: DreamStore, content: string, role = "user", ts = Date.now()) {
    store.db.prepare(`
        INSERT INTO session_messages (session_file, role, content, timestamp, indexed_at)
        VALUES (?, ?, ?, ?, ?)
    `).run("test.jsonl", role, content, ts, ts);
}

test("runRetrospective processes unprocessed messages", async () => {
    const { store, cleanup } = makeStore();
    try {
        insertMessage(store, "user says hello", "user");
        insertMessage(store, "assistant responds with info", "assistant");
        insertMessage(store, "user asks about vim", "user");
        insertMessage(store, "assistant explains vim config", "assistant");

        const result = await runRetrospective(store, async (msgs) => {
            // Extract one memory per user message
            return msgs
                .filter(m => m.role === "user")
                .map(m => ({ content: `User said: ${m.content}`, target: "user" }));
        }, { minMessagesThreshold: 2, cooldownMs: 0 });

        assert.equal(result.messagesProcessed, 4);
        assert.equal(result.memoriesExtracted, 2);
        assert.equal(result.memoryIds.length, 2);
    } finally { cleanup(); }
});

test("runRetrospective respects cooldown", async () => {
    const { store, cleanup } = makeStore();
    try {
        insertMessage(store, "msg1");
        insertMessage(store, "msg2");
        insertMessage(store, "msg3");
        insertMessage(store, "msg4");
        insertMessage(store, "msg5");
        insertMessage(store, "msg6");
        insertMessage(store, "msg7");
        insertMessage(store, "msg8");
        insertMessage(store, "msg9");
        insertMessage(store, "msg10");

        const processFn = async () => [{ content: "extracted", target: "user" as const }];
        
        const r1 = await runRetrospective(store, processFn, { minMessagesThreshold: 5, cooldownMs: 60000 });
        assert.equal(r1.memoriesExtracted, 1);

        // Second call within cooldown should be no-op
        const r2 = await runRetrospective(store, processFn, { minMessagesThreshold: 5, cooldownMs: 60000 });
        assert.equal(r2.memoriesExtracted, 0);
    } finally { cleanup(); }
});

test("runRetrospective skips if below threshold", async () => {
    const { store, cleanup } = makeStore();
    try {
        insertMessage(store, "msg1");
        insertMessage(store, "msg2");
        const result = await runRetrospective(store, async () => [{ content: "x", target: "user" as const }], { minMessagesThreshold: 5 });
        assert.equal(result.messagesProcessed, 0);
    } finally { cleanup(); }
});

test("getUnprocessedMessages returns messages after given ID", () => {
    const { store, cleanup } = makeStore();
    try {
        insertMessage(store, "first");
        insertMessage(store, "second");
        insertMessage(store, "third");
        const all = store.getUnprocessedMessages(0, 10);
        assert.equal(all.length, 3);
        const afterFirst = store.getUnprocessedMessages(all[0].id, 10);
        assert.equal(afterFirst.length, 2);
        assert.equal(afterFirst[0].content, "second");
    } finally { cleanup(); }
});
