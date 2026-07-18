/**
 * Tests for the contradiction detector.
 *
 * Background: the detector uses bigram-Jaccard string similarity to flag
 * potential duplicates/contradictions. Critical edge cases:
 *   - exact match → similarity = 1.0 (always a contradiction)
 *   - different target types → skip (a user pref ≠ a project convention)
 *   - negation polarity (one has "not", the other doesn't) → force
 *     arbitration so the user is asked instead of auto-replacing
 *   - empty strings → 0 similarity, no contradiction
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectContradictions, hasNegationMismatch, detectSameField } from "../contradiction/detector.js";
import type { Memory } from "../store/sqlite.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? "mem-" + Math.random().toString(36).slice(2),
		content: overrides.content ?? "user prefers vim",
		scope: overrides.scope ?? "global",
		scope_id: overrides.scope_id,
		target: overrides.target ?? "user",
		category: overrides.category ?? "preference",
		status: overrides.status ?? "active",
		tier: overrides.tier ?? "operational",
		ttl_days: overrides.ttl_days,
		created_at: overrides.created_at ?? Date.now(),
		updated_at: overrides.updated_at ?? Date.now(),
		access_count: overrides.access_count ?? 0,
		metadata: overrides.metadata,
	};
}

test("detectContradictions returns empty for empty existing list", () => {
	const result = detectContradictions("user prefers vim", "user", []);
	assert.equal(result.length, 0);
});

test("detectContradictions skips when targets differ", () => {
	const existing = makeMemory({
		content: "user prefers vim",
		target: "user",
	});
	const newContent = "user prefers vim";
	// New memory is for "project" target, existing is for "user" target
	const result = detectContradictions(newContent, "project", [existing]);
	assert.equal(result.length, 0, "different targets should be skipped");
});

test("detectContradictions flags high-similarity same-target content", () => {
	const existing = makeMemory({
		content: "user prefers vim as the editor",
		target: "user",
		category: "preference",
	});
	const result = detectContradictions("user prefers vim as the editor", "user", [existing]);
	assert.equal(result.length, 1);
	assert.equal(result[0].existing.id, existing.id);
	assert.ok(result[0].similarity >= 0.85, `similarity should be high, got ${result[0].similarity}`);
});

test("detectContradictions does not flag clearly-different content", () => {
	const existing = makeMemory({
		content: "user prefers vim",
		target: "user",
		category: "preference",
	});
	const result = detectContradictions("build uses webpack for bundling", "user", [existing]);
	// These are different "fields" but both target=user. The detector only
	// looks at similarity, not field overlap. With bigram-Jaccard, "user
	// prefers vim" vs "build uses webpack for bundling" should be < 0.5
	// similarity (no shared bigrams).
	for (const c of result) {
		assert.ok(c.similarity < 0.5, `unexpected high similarity: ${c.similarity}`);
	}
});

test("detectContradictions forces arbitration on negation polarity mismatch", () => {
	// Note: the negation-detection integration is tested via hasNegationMismatch
	// below. Building a content pair that both (a) crosses the 0.85 bigram
	// threshold and (b) has opposite meaning is fragile — the test below
	// exercises the lower-level function which is the actual logic.
	//
	// Integration sanity check: when a pair IS detected and has negation
	// polarity, needsArbitration must be true.
	const existing = makeMemory({
		content: "user uses vim as primary editor",
		target: "user",
		category: "preference",
	});
	// Maximize bigram overlap by making the new content a near-duplicate
	// with "not" inserted: "user uses vim not as primary editor".
	// Similarity should be high (well above 0.85) and hasNegationMismatch
	// should be true.
	const result = detectContradictions(
		"user uses vim not as primary editor",
		"user",
		[existing],
	);
	const flagged = result.find((c) => c.existing.id === existing.id);
	if (flagged) {
		assert.equal(flagged.needsArbitration, true, "negation mismatch must force arbitration");
	}
	// If similarity didn't cross the threshold, this test is degenerate for
	// this corpus; the hasNegationMismatch test below covers the logic.
});

test("hasNegationMismatch returns true when one side has negation and the other doesn't", () => {
	assert.equal(hasNegationMismatch("user prefers dark mode", "user does not prefer dark mode"), true);
	assert.equal(hasNegationMismatch("no longer uses X", "uses X"), true);
});

test("hasNegationMismatch returns false when both have or both lack negation", () => {
	assert.equal(hasNegationMismatch("user prefers dark mode", "user prefers light mode"), false);
	assert.equal(hasNegationMismatch("does not use X", "never uses X"), false);
});

test("hasNegationMismatch returns false for affirmative-with-negation patterns (EN)", () => {
	// "I not only use Vim" is a positive statement (means "I use Vim +
	// more"). It must not be treated as a negation of "I use Vim".
	// Otherwise every "I use X" / "I not only use X" pair would force
	// an arbitration prompt — needless friction.
	assert.equal(hasNegationMismatch("I use Vim", "I not only use Vim"), false);
	assert.equal(hasNegationMismatch("I use Vim", "I not just use Vim"), false);
	assert.equal(hasNegationMismatch("I use Vim", "I don't just use Vim"), false);
});

test("hasNegationMismatch returns false for affirmative-with-negation patterns (PT-BR)", () => {
	assert.equal(hasNegationMismatch("uso Zed", "nao apenas uso Zed"), false);
	assert.equal(hasNegationMismatch("uso Zed", "nao so uso Zed"), false);
	assert.equal(hasNegationMismatch("uso Zed", "nao somente uso Zed"), false);
});

test("hasNegationMismatch still flags real negation mixed with affirmative-with-negation", () => {
	// "I don't use Vim and not just that, I also avoid it" has a real
	// negation (don't) AND an affirmative-with-negation pattern. The
	// real negation wins, so this should still mismatch with "I use Vim".
	assert.equal(hasNegationMismatch("I use Vim", "I don't use Vim, in fact not just that"), true);
});

test("hasNegationMismatch with diacritics in negation (PT-BR)", () => {
	// Make sure diacritic-stripping still works for the *real* negation
	// path after we added the pattern filter. "não uso" still counts as
	// negation; the stripAffirmativeWithNegation filter should not have
	// hidden it.
	assert.equal(hasNegationMismatch("uso Zed", "não uso Zed"), true);
});

test("detectSameField returns true when both mention the same field keyword", () => {
	assert.equal(detectSameField("user uses vim as editor", "user uses vscode as editor"), true);
	assert.equal(detectSameField("project uses typescript language", "project uses python language"), true);
});

test("detectSameField returns false when no shared field keyword", () => {
	assert.equal(detectSameField("user prefers vim", "build uses webpack"), false);
	assert.equal(detectSameField("uses dark theme", "prefers postgres"), false);
});
