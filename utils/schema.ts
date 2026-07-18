/**
 * dream-memory/utils/schema.ts
 *
 * Renders the dream-memory schema (targets, categories, edge type rules)
 * as a compact markdown block suitable for injection into a tool's
 * `promptSnippet`. The block teaches the LLM agent the vocabulary it
 * needs to classify memories correctly — without it, the agent invents
 * generic labels that defeat retrieval (the "Pydantic fixed my Agent's
 * Memory" problem).
 *
 * Token budget: target ~150 tokens. This block is injected into every
 * system prompt for tools that use it, so compactness matters. We render
 * one line per type with description inline; no headers, no bullets,
 * no decoration. Tested by tests/schema.test.ts (pin the format so a
 * future "improvement" doesn't bloat the prompt).
 *
 * The Zep 10/10/10 principle (per the article) is enforced by keeping
 * the type count small: 4 targets + 6 categories = 10. Adding a new type
 * here is a deliberate, reviewed decision.
 */

import {
	MEMORY_TARGETS,
	MEMORY_CATEGORIES,
	TARGET_DESCRIPTIONS,
	CATEGORY_DESCRIPTIONS,
	EDGE_TYPE_RULES,
	TRUST_LEVEL_NAMES,
} from "./constants.js";

/**
 * Render the dream-memory schema as a single-line-per-type markdown block.
 *
 * Format:
 *   Memory schema (use the most specific target + category that fits):
 *   target=user: <desc>
 *   target=memory: <desc>
 *   target=project: <desc>
 *   target=failure: <desc>
 *   category=preference: <desc>
 *   category=convention: <desc>
 *   category=insight: <desc>
 *   category=failure: <desc>
 *   category=correction: <desc>
 *   category=tool-quirk: <desc>
 *   Edges: failure↔correction via corrects/caused_by | insight↔preference/convention/failure via explains/learned_from | preference↔preference via supersedes/conflicts_with
 *
 * Returns a single string with `\n` separators. The caller is responsible
 * for embedding it in the broader promptSnippet.
 */
export function renderSchemaBlock(): string {
	const targetLines = MEMORY_TARGETS.map(
		(t) => `target=${t}: ${TARGET_DESCRIPTIONS[t]}`,
	);
	const categoryLines = MEMORY_CATEGORIES.map(
		(c) => `category=${c}: ${CATEGORY_DESCRIPTIONS[c]}`,
	);

	// Edge rules: collapse the table into a single readable line. Each rule
	// becomes "<from>↔<to> via <edge1>/<edge2>". We sort the keys for stable
	// output (and stable test snapshots).
	const edgeEntries = Object.entries(EDGE_TYPE_RULES)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([pair, edges]) => {
			const [from, to] = pair.split("::");
			return `${from}↔${to} via ${edges.join("/")}`;
		});

	const lines: string[] = [
		"Schema (use the most specific target + category that fits; do not invent new types):",
		...targetLines,
		...categoryLines,
		`Edges: ${edgeEntries.join(" | ")}`,
		"Trust: user(3)>agreed(2)>suggested(1)>extracted(0)",
	];

	return lines.join("\n");
}
