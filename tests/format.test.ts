/**
 * Tests for utils/format.ts.
 *
 * Regression coverage for BUG #12: the previous inline formatBytes in
 * index.ts rendered "NaNMB" for non-finite inputs, which surfaced in
 * cleanup notifications when a stat() race made the byte sum invalid.
 * The fix returns "0B" for NaN, Infinity, and negative values.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { formatBytes } from "../utils/format.js";

test("formatBytes: bytes < 1024 stay in B", () => {
	assert.equal(formatBytes(0), "0B");
	assert.equal(formatBytes(512), "512B");
	assert.equal(formatBytes(1023), "1023B");
});

test("formatBytes: 1KB-1MB uses KB with 1 decimal", () => {
	assert.equal(formatBytes(1024), "1.0KB");
	assert.equal(formatBytes(2048), "2.0KB");
	assert.equal(formatBytes(1024 * 512), "512.0KB");
});

test("formatBytes: >= 1MB uses MB with 1 decimal", () => {
	assert.equal(formatBytes(1024 * 1024), "1.0MB");
	assert.equal(formatBytes(1024 * 1024 * 5), "5.0MB");
	assert.equal(formatBytes(1024 * 1024 * 1024), "1024.0MB");
});

test("formatBytes: NaN returns 0B (regression for BUG #12)", () => {
	assert.equal(formatBytes(NaN), "0B", "NaN must not render as 'NaNMB'");
});

test("formatBytes: Infinity returns 0B", () => {
	assert.equal(formatBytes(Infinity), "0B");
	assert.equal(formatBytes(-Infinity), "0B");
});

test("formatBytes: negative values return 0B", () => {
	assert.equal(formatBytes(-1), "0B");
	assert.equal(formatBytes(-1024), "0B");
});

// ── truncateForPreview (the /dream-list and dream_memory_list cap) ────
//
// The cap was tuned by hand:
//   - 60: too short (truncated to "Tool `read` used 3 times...")
//   - 200: too long (wrapped in 2-3 TUI lines, pushed entries off-screen)
//   - 115: roughly one full sentence in pt-BR/en plus a bit of context.
// The test pins the cap so a future refactor doesn't accidentally regress
// the user-visible width.

import { truncateForPreview } from "../utils/format.js";

test("truncateForPreview: short text passes through unchanged", () => {
	assert.equal(truncateForPreview("short"), "short");
	assert.equal(truncateForPreview(""), "");
});

test("truncateForPreview: default cap is 115 chars", () => {
	const long = "x".repeat(200);
	const result = truncateForPreview(long);
	assert.equal(result.length, 115, "default cap should be 115 chars");
	assert.ok(result.endsWith("..."), "truncated text ends with ellipsis");
	assert.equal(result.slice(0, 112), "x".repeat(112), "first 112 chars are the original text");
});

test("truncateForPreview: custom maxChars is honored", () => {
	const text = "a".repeat(500);
	assert.equal(truncateForPreview(text, 50).length, 50);
	assert.equal(truncateForPreview(text, 200).length, 200);
	assert.equal(truncateForPreview(text, 3).length, 3, "cap=3 still produces a valid 3-char output");
});

test("truncateForPreview: text exactly at cap is NOT truncated", () => {
	const text = "a".repeat(115);
	assert.equal(truncateForPreview(text), text, "text at exactly 115 chars is returned unchanged");
	assert.ok(!truncateForPreview(text).endsWith("..."), "no ellipsis when text fits");
});

test("truncateForPreview: real-world memory preview is readable", () => {
	// A typical long preference: should be cut to a readable first sentence
	const memory = "Ao refatorar ou implementar código novo: entender tudo que pode ser quebrado, quais arquivos precisam ser alterados, e adicionar testes em cada etapa da implementação para evitar bugs. Abordagem incremental com validação constante.";
	const result = truncateForPreview(memory);
	assert.equal(result.length, 115);
	// The leading words should be preserved (cuts at the boundary, not mid-word if possible)
	assert.ok(result.startsWith("Ao refatorar"), "truncation should keep the beginning of the memory");
	assert.ok(result.endsWith("..."), "long memory should end with ellipsis");
});
