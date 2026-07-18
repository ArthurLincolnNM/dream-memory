/**
 * Tests for the coreference resolver.
 *
 * Strategy: conservative resolution. Tests verify that:
 *   1. Pronouns ARE resolved when there's exactly one clear entity
 *   2. Pronouns are NOT resolved when ambiguous (multiple entities)
 *   3. Non-referential "it"/"isso" are NOT resolved
 *   4. Gender filtering works (he→masculine, she→feminine)
 *   5. Edge cases: no entities, empty text, single word
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveCoreferences, hasResolvablePronoun } from "../sanitize/coreference.js";

// ── Basic resolution ─────────────────────────────────────────────────

test("resolves 'ele' to single masculine entity (pt-BR)", () => {
	const result = resolveCoreferences("Alice configurou o servidor. Ele está funcionando.");
	assert.equal(result.changed, true);
	assert.equal(result.resolutions.length, 1);
	assert.equal(result.resolutions[0].pronoun, "ele");
	assert.equal(result.resolutions[0].resolvedTo, "Alice");
	assert.ok(result.resolved.includes("Alice está funcionando"), `Got: ${result.resolved}`);
});

test("resolves 'she' to single feminine entity (EN)", () => {
	const result = resolveCoreferences("Maria wrote the tests. She passed them all.");
	assert.equal(result.changed, true);
	assert.equal(result.resolutions[0].pronoun, "she");
	assert.equal(result.resolutions[0].resolvedTo, "Maria");
});

test("resolves 'he' to single masculine entity (EN)", () => {
	const result = resolveCoreferences("Bob fixed the bug. He used a clever trick.");
	assert.equal(result.changed, true);
	assert.equal(result.resolutions[0].pronoun, "he");
	assert.equal(result.resolutions[0].resolvedTo, "Bob");
});

// ── Multiple entities → skip (ambiguous) ─────────────────────────────

test("does NOT resolve 'he' when two entities present (Alice + Bob)", () => {
	// Both Alice and Bob are entities. 'he' is ambiguous → skip
	const result = resolveCoreferences("Alice and Bob worked on the fix. He pushed the commit.");
	assert.equal(result.changed, false);
});

test("does NOT resolve 'ela' with two feminine entities", () => {
	const result = resolveCoreferences("Maria e Ana discutiram. Ela não concordou.");
	assert.equal(result.changed, false);
});

// ── Non-referential "it"/"isso" → skip ───────────────────────────────

test("does NOT resolve 'it' in 'make it work'", () => {
	const result = resolveCoreferences("Alice configured the server. Now make it work.");
	assert.equal(result.changed, false);
});

test("does NOT resolve 'it' in 'get it done'", () => {
	const result = resolveCoreferences("Bob reviewed the PR. He said to get it done.");
	// "he" might resolve to Bob, but "it" should not
	const itResolution = result.resolutions.find(r => r.pronoun === "it");
	assert.equal(itResolution, undefined);
});

test("does NOT resolve 'isso' in 'é isso'", () => {
	const result = resolveCoreferences("Alice explicou o problema. É isso que precisa mudar.");
	assert.equal(result.changed, false);
});

test("does NOT resolve 'it' after preposition", () => {
	const result = resolveCoreferences("Alice deployed the fix. He agreed with it.");
	// "he" might resolve, but "it" after "with" should not
	const itResolution = result.resolutions.find(r => r.pronoun === "it");
	assert.equal(itResolution, undefined);
});

// ── No entities → skip ───────────────────────────────────────────────

test("does NOT resolve when no entities in text", () => {
	const result = resolveCoreferences("ele gosta de café");
	assert.equal(result.changed, false);
});

test("does NOT resolve when only common words capitalized", () => {
	const result = resolveCoreferences("The server is down. It needs fixing.");
	assert.equal(result.changed, false);
});

// ── Gender filtering ─────────────────────────────────────────────────

test("does NOT resolve 'he' to obviously feminine entity", () => {
	const result = resolveCoreferences("Ana deployed the fix. He tested it.");
	// "he" should not resolve to "Ana" (feminine)
	const heResolution = result.resolutions.find(r => r.pronoun === "he");
	assert.equal(heResolution, undefined);
});

test("does NOT resolve 'she' to obviously masculine entity", () => {
	const result = resolveCoreferences("Marco reviewed the code. She approved it.");
	const sheResolution = result.resolutions.find(r => r.pronoun === "she");
	assert.equal(sheResolution, undefined);
});

// ── Case preservation ────────────────────────────────────────────────

test("resolves capitalized 'She' and preserves case", () => {
	const result = resolveCoreferences("Alice started the deploy. She said it would work.");
	// 'She' → 'Alice' (capitalized preserved)
	assert.equal(result.changed, true);
	const sheResolutions = result.resolutions.filter(r => r.pronoun === "she");
	assert.equal(sheResolutions.length, 1);
	assert.ok(result.resolved.includes("Alice said"), `Got: ${result.resolved}`);
});

// ── Multiple pronouns of same type ───────────────────────────────────

test("resolves multiple 'he' references to same entity", () => {
	const result = resolveCoreferences("Bob fixed the bug. He pushed the commit. He updated the docs.");
	assert.equal(result.changed, true);
	// Should resolve both "he" references
	const heResolutions = result.resolutions.filter(r => r.pronoun === "he");
	assert.equal(heResolutions.length, 2);
});

// ── hasResolvablePronoun helper ──────────────────────────────────────

test("hasResolvablePronoun detects Portuguese pronouns", () => {
	assert.equal(hasResolvablePronoun("ele gosta de café"), true);
	assert.equal(hasResolvablePronoun("ela configurou o server"), true);
	assert.equal(hasResolvablePronoun("isso é importante"), true);
	assert.equal(hasResolvablePronoun("usuário prefere vim"), false);
});

test("hasResolvablePronoun detects English pronouns", () => {
	assert.equal(hasResolvablePronoun("he fixed the bug"), true);
	assert.equal(hasResolvablePronoun("she wrote the tests"), true);
	assert.equal(hasResolvablePronoun("it works now"), true);
	assert.equal(hasResolvablePronoun("the server is down"), false);
});

// ── Edge cases ───────────────────────────────────────────────────────

test("handles empty string", () => {
	const result = resolveCoreferences("");
	assert.equal(result.changed, false);
	assert.equal(result.resolved, "");
});

test("handles single word", () => {
	const result = resolveCoreferences("hello");
	assert.equal(result.changed, false);
});

test("handles text with only pronouns and no entities", () => {
	const result = resolveCoreferences("ele disse que ela não concordou");
	assert.equal(result.changed, false);
});

// ── Real-world scenarios ─────────────────────────────────────────────

test("scenario: single developer + pronouns", () => {
	const result = resolveCoreferences(
		"Arthur implementou o sistema de memória. Ele usou SQLite como backend. Ela funciona bem para o caso de uso."
	);
	// "Ele" → "Arthur", "Ela" → could be "memória" but that's not an entity (lowercase)
	// Only "Ele" should resolve
	assert.equal(result.changed, true);
	const eleResolutions = result.resolutions.filter(r => r.pronoun === "ele");
	assert.equal(eleResolutions.length, 1);
	assert.equal(eleResolutions[0].resolvedTo, "Arthur");
});

test("scenario: tech content with 'it' in multiple positions", () => {
	const result = resolveCoreferences(
		"Alice set up the CI pipeline. She configured it to run tests. It passes now."
	);
	// "She" → Alice (resolve)
	// First "it" → after "configured" → could be referential (skip because multiple entities or non-referential check)
	// Second "It" → subject position, but no clear entity → skip
	assert.equal(result.changed, true);
	const sheResolutions = result.resolutions.filter(r => r.pronoun === "she");
	assert.equal(sheResolutions.length, 1);
	// "it" should NOT be resolved
	const itResolutions = result.resolutions.filter(r => r.pronoun === "it");
	assert.equal(itResolutions.length, 0);
});
