import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DreamStore } from "../store/sqlite.js";
import { findSynthesisCandidates, applySynthesis } from "../dream/synthesis.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

function createTestStore(): DreamStore {
	const dir = mkdtempSync(join(tmpdir(), "dream-test-"));
	return new DreamStore(join(dir, "test.db"));
}

describe("LLM synthesis callback", () => {
	it("uses LLM callback for clusters >= 6", async () => {
		const store = createTestStore();
		// Create 6 similar memories about "vim"
		for (let i = 0; i < 6; i++) {
			store.createMemory({
				content: `User prefers vim for editing code files. Vim is the best editor for ${["python", "typescript", "go", "rust", "javascript", "c++"][i]}.`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "factual",
			});
		}

		let llmCalled = false;
		const candidates = await findSynthesisCandidates(store, {
			minClusterSize: 3,
			llmConsolidate: async (memories) => {
				llmCalled = true;
				return `User prefers vim for all programming languages.`;
			},
		});

		assert.ok(llmCalled, "LLM callback should be called for 6+ memories");
		assert.ok(candidates.length > 0, "should produce candidates");
		assert.ok(candidates[0].synthesizedContent.includes("LLM"), "should tag as LLM synthesis");
	});

	it("falls back to keyword template on LLM failure", async () => {
		const store = createTestStore();
		for (let i = 0; i < 6; i++) {
			store.createMemory({
				content: `User prefers vim for editing code files. Vim is the best editor for ${["python", "typescript", "go", "rust", "javascript", "c++"][i]}.`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "factual",
			});
		}

		const candidates = await findSynthesisCandidates(store, {
			minClusterSize: 3,
			llmConsolidate: async () => {
				throw new Error("LLM unavailable");
			},
		});

		assert.ok(candidates.length > 0, "should fall back to keyword synthesis");
		assert.ok(
			!candidates[0].synthesizedContent.includes("LLM"),
			"should NOT tag as LLM synthesis on fallback",
		);
	});

	it("does not use LLM for small clusters (< 6)", async () => {
		const store = createTestStore();
		for (let i = 0; i < 4; i++) {
			store.createMemory({
				content: `User prefers vim for editing code files. Vim is the best editor for ${["python", "typescript", "go", "rust"][i]}.`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "factual",
			});
		}

		let llmCalled = false;
		await findSynthesisCandidates(store, {
			minClusterSize: 3,
			llmConsolidate: async () => {
				llmCalled = true;
				return "test";
			},
		});

		assert.equal(llmCalled, false, "LLM should NOT be called for < 6 memories");
	});

	it("LLM synthesis produces valid SynthesisCandidate", async () => {
		const store = createTestStore();
		for (let i = 0; i < 6; i++) {
			store.createMemory({
				content: `Project uses PostgreSQL for all databases. Postgres version 16 is deployed for ${["auth", "users", "sessions", "analytics", "payments", "logs"]}.`,
				scope: "project",
				target: "project",
				category: "convention",
				tier: "factual",
			});
		}

		const candidates = await findSynthesisCandidates(store, {
			minClusterSize: 3,
			llmConsolidate: async () => {
				return "Project standardizes on PostgreSQL 16 for all database services.";
			},
		});

		assert.ok(candidates.length > 0);
		const c = candidates[0];
		assert.equal(c.target, "project");
		assert.equal(c.category, "convention");
		assert.equal(c.tier, "factual");
		assert.equal(c.confidence, 0.9);
		assert.equal(c.sourceIds.length, 6);
		assert.ok(c.synthesizedContent.includes("PostgreSQL 16"));
	});
});
