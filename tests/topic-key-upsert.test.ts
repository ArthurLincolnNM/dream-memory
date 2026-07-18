import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";

function makeStore() {
	const dir = mkdtempSync(join(tmpdir(), "dm-topic-key-test-"));
	const store = new DreamStore(join(dir, "test.db"));
	return { store, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("findByTopicKey returns null when no match", () => {
	const { store, cleanup } = makeStore();
	try {
		const result = store.findByTopicKey("preference:vscode", "global");
		assert.equal(result, null);
	} finally { cleanup(); }
});

test("findByTopicKey finds memory with matching topic_key", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({ content: "dark mode", scope: "global", target: "user", topic_key: "preference:dark-mode" });
		const found = store.findByTopicKey("preference:dark-mode", "global");
		assert.ok(found, "Should find memory by topic key");
		assert.equal(found!.content, "dark mode");
	} finally { cleanup(); }
});

test("findByTopicKey scopes by scope parameter", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({ content: "global mem", scope: "global", target: "user", topic_key: "preference:vim" });
		const foundGlobal = store.findByTopicKey("preference:vim", "global");
		const foundProject = store.findByTopicKey("preference:vim", "project");
		assert.ok(foundGlobal, "Should find in global scope");
		assert.equal(foundProject, null, "Should not find in different scope");
	} finally { cleanup(); }
});

test("findByTopicKey excludes superseded memories", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({ content: "old", scope: "global", target: "user", topic_key: "preference:theme" });
		store.updateMemory(mem.id, { status: "superseded" });
		const found = store.findByTopicKey("preference:theme", "global");
		assert.equal(found, null, "Should not find superseded memory");
	} finally { cleanup(); }
});

test("topic_key stored correctly in memory", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({ content: "test", scope: "global", target: "user", topic_key: "convention:typescript:strict" });
		const retrieved = store.getMemory(mem.id);
		assert.equal((retrieved as any).topic_key, "convention:typescript:strict");
	} finally { cleanup(); }
});
