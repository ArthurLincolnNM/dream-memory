/**
 * Tests for dream/instructions.ts parsing.
 *
 * Regression coverage for BUG #10: the previous `\s+e\s+` regex used to
 * split PT-BR conjunctions also matched inside compound words like
 * "Enterprise", "email", or "decide", silently breaking terms in half.
 * The fix uses `(?<!\w)e\s+` so the match only fires when `e` is preceded
 * by a non-word character (i.e., a real word boundary).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseInstructions } from "../dream/instructions.js";

test("parseInstructions: focus term stays whole when adjacent to compound words", () => {
	// "focus on Enterprise integration and OAuth flow"
	// "Enterprise" contains the substring "e", but is preceded by space, so
	// the negative lookbehind \w doesn't apply there. The split must NOT
	// break "Enterprise" into "nterprise".
	const result = parseInstructions("focus on Enterprise integration and OAuth flow");
	assert.deepEqual(
		result.focus.sort(),
		["Enterprise integration", "OAuth flow"].sort(),
		"should keep compound words intact and split only on real conjunctions",
	);
});

test("parseInstructions: focus on 'email' should keep 'email' as one term", () => {
	// The substring "e" inside "email" is preceded by another word char,
	// so the lookbehind \w fires and prevents the split.
	const result = parseInstructions("focus on email migration");
	assert.deepEqual(result.focus, ["email migration"]);
});

test("parseInstructions: PT-BR 'e' conjunction splits real lists", () => {
	// "focus on A e B" should produce two terms. The `e` here is preceded
	// by space (non-word), so the lookbehind allows the split.
	const result = parseInstructions("focus on Vim e Zed e Neovim");
	assert.deepEqual(result.focus.sort(), ["Vim", "Zed", "Neovim"].sort());
});

test("parseInstructions: comma split still works", () => {
	const result = parseInstructions("focus on TypeScript, Rust, and Go");
	assert.deepEqual(result.focus.sort(), ["TypeScript", "Rust", "Go"].sort());
});

test("parseInstructions: 'decide' inside a focus clause is not split", () => {
	// "focus on decide" — the previous code would have produced ["d", ""].
	const result = parseInstructions("focus on decide arquitetura hexagonal");
	assert.deepEqual(result.focus, ["decide arquitetura hexagonal"]);
});
