/**
 * Tests for utils/schema.ts
 *
 * The schema block is injected into the system prompt on every turn.
 * Two regressions we want to prevent:
 *   1. The block grows unbounded (token bloat) — pin a soft cap.
 *   2. A type/description drift (target added in constants but missing
 *      in the renderer, or vice versa) — render and parse back.
 *
 * Stable test design: don't pin the exact string, but pin the structure
 * (one line per target, one per category, edges present) and the cap.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { renderSchemaBlock } from "../utils/schema.js";
import {
	MEMORY_TARGETS,
	MEMORY_CATEGORIES,
	TARGET_DESCRIPTIONS,
	CATEGORY_DESCRIPTIONS,
} from "../utils/constants.js";

test("renderSchemaBlock: includes every target with its description", () => {
	const block = renderSchemaBlock();
	for (const target of MEMORY_TARGETS) {
		assert.ok(
			block.includes(`target=${target}:`),
			`schema block must mention target=${target}`,
		);
		assert.ok(
			block.includes(TARGET_DESCRIPTIONS[target]),
			`schema block must include description for target=${target}`,
		);
	}
});

test("renderSchemaBlock: includes every category with its description", () => {
	const block = renderSchemaBlock();
	for (const category of MEMORY_CATEGORIES) {
		assert.ok(
			block.includes(`category=${category}:`),
			`schema block must mention category=${category}`,
		);
		assert.ok(
			block.includes(CATEGORY_DESCRIPTIONS[category]),
			`schema block must include description for category=${category}`,
		);
	}
});

test("renderSchemaBlock: includes edge rules summary", () => {
	const block = renderSchemaBlock();
	assert.ok(
		block.includes("Edges:"),
		"schema block must have an 'Edges:' section",
	);
	// Spot-check: failure↔correction is the most important edge (fix flow)
	assert.ok(
		block.includes("failure↔correction"),
		"schema block must list failure↔correction edge",
	);
});

test("renderSchemaBlock: stays under 2000 chars (token budget)", () => {
	const block = renderSchemaBlock();
	assert.ok(
		block.length < 2000,
		`schema block is ${block.length} chars — exceeds 2000 char soft cap (~500 tokens). Tighten the descriptions in constants.ts.`,
	);
});

test("renderSchemaBlock: output is deterministic (stable order)", () => {
	// Two calls produce identical output — important for test snapshots
	// and for any future caching of the rendered block.
	assert.equal(renderSchemaBlock(), renderSchemaBlock());
});

test("renderSchemaBlock: prefix sets the right expectation", () => {
	const block = renderSchemaBlock();
	assert.ok(
		block.startsWith("Schema"),
		"schema block must start with 'Schema' to set the right LLM expectation",
	);
	// Anti-invention rule: tell the LLM not to make up new types
	assert.ok(
		block.includes("do not invent new types") || block.includes("use the most specific"),
		"schema block must include a selection rule that prevents the LLM from inventing new types",
	);
});
