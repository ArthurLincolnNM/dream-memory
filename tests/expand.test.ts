/**
 * Tests for recall/expand.ts (synonym dictionary + token expansion)
 * and the integration in recall/query.ts (deriveRecallQuery).
 *
 * The expansion is the "cheap first pass" of recall — it has to work
 * without any model or API. These tests cover:
 *   - synonym lookup (known token, unknown token)
 *   - case-insensitivity
 *   - diacritic-stripping (pt-BR)
 *   - dedup (same token from two paths)
 *   - per-token and total caps
 *   - end-to-end via deriveRecallQuery
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	expandQueryTokens,
	normalizeToken,
	dictionarySize,
} from "../recall/expand.js";
import { deriveRecallQuery, isMetaMemoryQuery } from "../recall/query.js";

// ── normalizeToken ─────────────────────────────────────────────────────

test("normalizeToken: lowercase", () => {
	assert.equal(normalizeToken("BUG"), "bug");
	assert.equal(normalizeToken("Bug"), "bug");
	assert.equal(normalizeToken("bug"), "bug");
});

test("normalizeToken: diacritic stripping (pt-BR)", () => {
	// "não" with tilde → "nao" without
	assert.equal(normalizeToken("não"), "nao");
	assert.equal(normalizeToken("NÃO"), "nao");
	assert.equal(normalizeToken("cor"), "cor");
	assert.equal(normalizeToken("côr"), "cor");
	assert.equal(normalizeToken("é"), "e");
	assert.equal(normalizeToken("linguagem"), "linguagem");
});

test("normalizeToken: preserves non-letter characters (not stripped)", () => {
	// Diacritic strip removes combining marks, but keeps base chars
	assert.equal(normalizeToken("crème"), "creme");
	assert.equal(normalizeToken("naïve"), "naive");
});

// ── expandQueryTokens: known tokens ─────────────────────────────────────

test("expandQueryTokens: 'bug' expands to error-related terms", () => {
	const result = expandQueryTokens(["bug"]);
	// 'bug' itself is always present (preserves the user's term)
	assert.ok(result.includes("bug"), "original token preserved");
	// At least some of the expected synonyms should be present
	const expectedSyns = ["erro", "error", "fail", "failure", "broken", "crash", "falha"];
	const present = expectedSyns.filter((s) => result.includes(s));
	assert.ok(present.length >= 3, `expected at least 3 synonyms, got ${present.length}: ${present.join(", ")}`);
});

test("expandQueryTokens: 'editor' expands to IDE synonyms", () => {
	const result = expandQueryTokens(["editor"]);
	assert.ok(result.includes("editor"));
	const present = ["ide", "vscode", "zed", "vim", "neovim"].filter((s) => result.includes(s));
	assert.ok(present.length >= 3, `expected at least 3 editor synonyms, got ${present.length}`);
});

test("expandQueryTokens: 'prefer' expands to preference verbs", () => {
	const result = expandQueryTokens(["prefer"]);
	assert.ok(result.includes("prefer"));
	assert.ok(result.includes("gosto") || result.includes("like"),
		"should include at least one preference synonym");
});

test("expandQueryTokens: 'keybinding' expands to shortcut terms", () => {
	const result = expandQueryTokens(["keybinding"]);
	assert.ok(result.includes("keybinding"));
	assert.ok(result.includes("shortcut") || result.includes("atalho"));
});

// ── expandQueryTokens: pt-BR native ─────────────────────────────────────

test("expandQueryTokens: 'erro' (pt-BR) expands to error-related", () => {
	const result = expandQueryTokens(["erro"]);
	assert.ok(result.includes("erro"));
	assert.ok(result.includes("bug") || result.includes("error") || result.includes("fail"));
});

test("expandQueryTokens: 'lembrar' (pt-BR) expands to remember", () => {
	const result = expandQueryTokens(["lembrar"]);
	assert.ok(result.includes("lembrar"));
	assert.ok(result.includes("remember") || result.includes("recall"));
});

// ── expandQueryTokens: unknown tokens ───────────────────────────────────

test("expandQueryTokens: unknown token passes through unchanged", () => {
	const result = expandQueryTokens(["xyzzy", "plumbus"]);
	assert.deepEqual(result, ["xyzzy", "plumbus"]);
});

test("expandQueryTokens: mixed known and unknown tokens", () => {
	const result = expandQueryTokens(["bug", "xyzzy", "editor"]);
	assert.ok(result.includes("bug"));
	assert.ok(result.includes("xyzzy"));
	assert.ok(result.includes("editor"));
	assert.ok(result.includes("error") || result.includes("erro")); // from bug
});

// ── expandQueryTokens: case insensitivity ──────────────────────────────

test("expandQueryTokens: lookup is case-insensitive", () => {
	const lower = expandQueryTokens(["bug"]);
	const upper = expandQueryTokens(["BUG"]);
	const mixed = expandQueryTokens(["Bug"]);
	// All three should produce the same synonym set
	const lowerSet = new Set(lower.filter((t) => t !== "bug"));
	const upperSet = new Set(upper.filter((t) => t !== "BUG"));
	assert.deepEqual([...lowerSet].sort(), [...upperSet].sort(),
		"BUG and bug should produce identical synonym sets");
});

// ── expandQueryTokens: diacritic insensitivity ──────────────────────────

test("expandQueryTokens: pt-BR diacritics do not affect lookup (case-insensitive set)", () => {
	// "não" and "nao" are equivalent at the lookup level (both normalize to "nao").
	// Neither is a dictionary key, so both just pass through unchanged. The
	// original-cased token is preserved (so 'não' stays 'não', not 'nao'),
	// but the SYNONYM SET is the same: empty for both.
	const withDiacritic = expandQueryTokens(["não"]);
	const without = expandQueryTokens(["nao"]);
	// Compare the lowercase normalized forms (which is what the lookup uses)
	const diacriticSet = new Set(withDiacritic.map((t) => normalizeToken(t)));
	const withoutSet = new Set(without.map((t) => normalizeToken(t)));
	assert.deepEqual([...diacriticSet].sort(), [...withoutSet].sort());
});

test("expandQueryTokens: diacritic on a real key still hits the synonym set", () => {
	// 'cor' and 'côr' both normalize to 'cor' (the dictionary key).
	// So both should expand to include 'theme'/'tema'/'color' etc.
	const withoutDiacritic = expandQueryTokens(["cor"]);
	const withDiacritic = expandQueryTokens(["côr"]);
	// The SYNONYMS (everything except the original token) should match.
	const withoutSyns = withoutDiacritic.slice(1).map((t) => normalizeToken(t)).sort();
	const withSyns = withDiacritic.slice(1).map((t) => normalizeToken(t)).sort();
	assert.deepEqual(withSyns, withoutSyns,
		"'côr' and 'cor' should produce identical synonym lists");
});

// ── expandQueryTokens: dedup ────────────────────────────────────────────

test("expandQueryTokens: dedup across shared synonyms", () => {
	// 'erro' and 'bug' share many synonyms; the shared ones should appear ONCE
	const result = expandQueryTokens(["erro", "bug"]);
	const counts = new Map<string, number>();
	for (const t of result) {
		const k = t.toLowerCase();
		counts.set(k, (counts.get(k) || 0) + 1);
	}
	for (const [token, count] of counts) {
		assert.equal(count, 1, `token "${token}" appears ${count} times, expected 1`);
	}
});

// ── expandQueryTokens: per-token cap ────────────────────────────────────

test("expandQueryTokens: per-token cap limits synonym bloat", () => {
	// 'editor' has 8 synonyms in the dict; cap is 5, so output should be
	// at most 1 (original) + 5 (synonyms) = 6 entries
	const result = expandQueryTokens(["editor"]);
	const editorCount = result.filter((t) =>
		["editor", "ide", "vscode", "zed", "vim", "neovim", "nvim", "sublime", "emacs"].includes(t.toLowerCase())
	).length;
	assert.ok(editorCount <= 6, `per-token cap should limit editor group to ≤6, got ${editorCount}`);
});

// ── expandQueryTokens: total cap ────────────────────────────────────────

test("expandQueryTokens: total cap prevents pathological expansion", () => {
	// 100 input tokens, each with 5 synonyms, would be 600 entries
	// without the cap. The 30-entry cap should kick in.
	const tokens = Array.from({ length: 100 }, (_, i) => `token${i}`);
	// Mix in some known tokens so expansion actually happens
	tokens[0] = "bug";
	tokens[1] = "editor";
	tokens[2] = "erro";
	const result = expandQueryTokens(tokens);
	assert.ok(result.length <= 30, `total cap should bound output to ≤30, got ${result.length}`);
});

// ── expandQueryTokens: empty / edge cases ───────────────────────────────

test("expandQueryTokens: empty input returns empty", () => {
	assert.deepEqual(expandQueryTokens([]), []);
});

test("expandQueryTokens: input with empty strings is filtered", () => {
	const result = expandQueryTokens(["bug", "", "  ", "editor"]);
	// Empty strings should be skipped, but "  " after .toLowerCase() is "  "
	// (we only check for non-empty after lowercase, not after trim)
	assert.ok(result.includes("bug"));
	assert.ok(result.includes("editor"));
});

// ── deriveRecallQuery: expansion integration ───────────────────────────

test("deriveRecallQuery: expansion adds synonyms to query", () => {
	const result = deriveRecallQuery("bug");
	assert.ok(result.includes("bug"), "original term preserved");
	assert.ok(result.includes("erro") || result.includes("error") || result.includes("fail"),
		"synonyms should be added to the query");
});

test("deriveRecallQuery: pt-BR query expands to pt-BR + en synonyms", () => {
	const result = deriveRecallQuery("lembrar");
	assert.ok(result.includes("lembrar"));
	assert.ok(result.includes("remember") || result.includes("recall"),
		"pt-BR 'lembrar' should expand to 'remember' or 'recall'");
});

test("deriveRecallQuery: short non-stopword query still expands", () => {
	// 'bug' is 3 chars, above the 3-char min
	const result = deriveRecallQuery("bug");
	assert.ok(result.length > 3, "should not be filtered as too short");
	assert.ok(result.split(" ").length > 1, "should be expanded to multiple terms");
});

test("deriveRecallQuery: options.expand=false disables expansion", () => {
	const expanded = deriveRecallQuery("bug", { expand: true });
	const literal = deriveRecallQuery("bug", { expand: false });
	assert.ok(literal.split(" ").length < expanded.split(" ").length,
		`literal should have fewer terms than expanded: literal="${literal}" expanded="${expanded}"`);
	assert.equal(literal.trim(), "bug", "literal mode returns just the cleaned query");
});

test("deriveRecallQuery: non-string input returns empty", () => {
	// @ts-expect-error - testing runtime safety
	assert.equal(deriveRecallQuery(null), "");
	// @ts-expect-error - testing runtime safety
	assert.equal(deriveRecallQuery(undefined), "");
	// @ts-expect-error - testing runtime safety
	assert.equal(deriveRecallQuery(42), "");
});

test("deriveRecallQuery: meta-memory check is at a different layer (index.ts), not here", () => {
	// deriveRecallQuery is a pure transformation; it doesn't know about
	// meta-memory vs. content queries. The meta-memory filter is applied
	// by the caller in index.ts (line 339: `if (isMetaMemoryQuery(query)) return;`).
	// So a "meta" input here will still be expanded normally — that's the
	// correct contract. We test that the EXPANSION happens (i.e., the
	// function doesn't reject the input on its own).
	const result = deriveRecallQuery("o que você lembra");
	assert.ok(result.includes("lembra") || result.includes("lembrar"),
		"should expand the pt-BR verb");
	assert.ok(result.includes("remember") || result.includes("recall"),
		"should include English synonyms");
});

test("isMetaMemoryQuery: matches the documented patterns", () => {
	// Separate test for the meta-memory predicate, since it's the layer
	// that actually blocks recall for self-referential queries.
	assert.equal(isMetaMemoryQuery("o que você lembra"), true,
		"pt-BR meta-memory should be detected");
	assert.equal(isMetaMemoryQuery("o que você sabe"), true);
	assert.equal(isMetaMemoryQuery("what do you remember"), true);
	assert.equal(isMetaMemoryQuery("list your memory"), true);
	// Negative case: a content query that happens to use these words
	assert.equal(isMetaMemoryQuery("como lembro o keybinding?"), false,
		"a content question about 'lembrar keybinding' should NOT be meta");
});

test("deriveRecallQuery: maxChars caps the expanded output", () => {
	const result = deriveRecallQuery("bug editor erro vim", { maxChars: 10 });
	assert.ok(result.length <= 10, `result length ${result.length} exceeds maxChars=10`);
});

// ── dictionarySize observability ───────────────────────────────────────

test("dictionarySize: returns a positive number (sanity check)", () => {
	const size = dictionarySize();
	assert.ok(size >= 50, `dictionary should have ≥50 entries, got ${size}`);
	assert.ok(size <= 200, `dictionary should have ≤200 entries (kept narrow), got ${size}`);
});

// ── End-to-end: expanded query finds related memory via FTS5 ───────────

test("end-to-end: 'bug' query finds a memory containing only 'erro' (via expansion)", () => {
	// We don't import the full FTS5 search here (covered by search.test.ts);
	// we just confirm the expanded query STRING is what we'd expect to feed in.
	const result = deriveRecallQuery("bug");
	// The expanded string is what reaches FTS5; FTS5 tokenizes it again on
	// whitespace. If both 'bug' and 'erro' are in the string, FTS5 will
	// match a memory containing either. Verify the expansion includes both.
	assert.ok(result.includes("bug"), "should include original 'bug'");
	assert.ok(result.includes("erro"), "should include 'erro' synonym");
	assert.ok(result.includes("error"), "should include 'error' synonym");
});

test("deriveRecallQuery: expansion result has no duplicate tokens (dedup integrity)", () => {
	// Catches mutations that break dedup at the integration layer
	// (e.g., appending the original tokens to the expanded list without
	// dedup). expandQueryTokens() dedups internally, but the caller
	// could re-introduce duplicates by mixing the original tokens back in.
	// This test asserts the FINAL string is dedup'd.
	const result = deriveRecallQuery("bug bug bug editor editor");
	const tokens = result.split(/\s+/);
	const unique = new Set(tokens);
	assert.equal(
		tokens.length,
		unique.size,
		`deriveRecallQuery should produce unique tokens. Got ${tokens.length} tokens but only ${unique.size} unique. ` +
		`Tokens: ${tokens.join(" ")}`,
	);
});
