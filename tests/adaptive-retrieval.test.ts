/**
 * Tests for adaptive retrieval (query complexity classification).
 *
 * Verifies that the classifier correctly identifies simple vs complex
 * queries and assigns appropriate retrieval depths.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { classifyQueryComplexity } from "../search/hybrid.js";

// ── LOW complexity (depth=3) ─────────────────────────────────────────

test("simple entity lookup → LOW", () => {
	const result = classifyQueryComplexity("Alice");
	assert.equal(result.complexity, "LOW");
	assert.equal(result.depth, 3);
});

test("single concept query → LOW", () => {
	const result = classifyQueryComplexity("vim preferences");
	assert.equal(result.complexity, "LOW");
	assert.equal(result.depth, 3);
});

test("short fact lookup → LOW", () => {
	const result = classifyQueryComplexity("project name");
	assert.equal(result.complexity, "LOW");
	assert.equal(result.depth, 3);
});

test("single entity with verb → LOW", () => {
	const result = classifyQueryComplexity("what does Alice use");
	assert.equal(result.complexity, "LOW");
	assert.equal(result.depth, 3);
});

// ── HIGH complexity (depth=15) ───────────────────────────────────────

test("temporal query → HIGH", () => {
	const result = classifyQueryComplexity("when did Alice last deploy");
	assert.equal(result.complexity, "HIGH");
	assert.equal(result.depth, 15);
});

test("multi-entity with conjunction → HIGH", () => {
	const result = classifyQueryComplexity("Alice and Bob preferences");
	assert.equal(result.complexity, "HIGH");
	assert.equal(result.depth, 15);
});

test("comparison query → HIGH", () => {
	const result = classifyQueryComplexity("compare the approaches before and after");
	assert.equal(result.complexity, "HIGH");
	assert.equal(result.depth, 15);
});

test("open-ended explanation → HIGH", () => {
	const result = classifyQueryComplexity("why did the deployment fail last week");
	assert.equal(result.complexity, "HIGH");
	assert.equal(result.depth, 15);
});

test("long complex query → HIGH", () => {
	const result = classifyQueryComplexity("what patterns emerged in the codebase when we migrated from the old system to the new one");
	assert.equal(result.complexity, "HIGH");
	assert.equal(result.depth, 15);
});

test("temporal + multi-hop → HIGH", () => {
	const result = classifyQueryComplexity("what changed between last month and this month");
	assert.equal(result.complexity, "HIGH");
	assert.equal(result.depth, 15);
});

// ── Portuguese queries ───────────────────────────────────────────────

test("simple PT-BR query → LOW", () => {
	const result = classifyQueryComplexity("preferências do Arthur");
	assert.equal(result.complexity, "LOW");
	assert.equal(result.depth, 3);
});

test("temporal PT-BR query → HIGH", () => {
	const result = classifyQueryComplexity("quando Arthur fez o deploy ontem");
	assert.equal(result.complexity, "HIGH");
	assert.equal(result.depth, 15);
});

test("comparison PT-BR query → HIGH", () => {
	const result = classifyQueryComplexity("comparar abordagens antes e depois");
	assert.equal(result.complexity, "HIGH");
	assert.equal(result.depth, 15);
});

// ── Edge cases ───────────────────────────────────────────────────────

test("empty string → LOW", () => {
	const result = classifyQueryComplexity("");
	assert.equal(result.complexity, "LOW");
	assert.equal(result.depth, 3);
});

test("single word → LOW", () => {
	const result = classifyQueryComplexity("vim");
	assert.equal(result.complexity, "LOW");
	assert.equal(result.depth, 3);
});

test("query with 'all' → HIGH", () => {
	const result = classifyQueryComplexity("list all memories about deployment");
	assert.equal(result.complexity, "HIGH");
	assert.equal(result.depth, 15);
});

test("query with 'every' → HIGH", () => {
	const result = classifyQueryComplexity("every tool usage pattern");
	assert.equal(result.complexity, "HIGH");
	assert.equal(result.depth, 15);
});
