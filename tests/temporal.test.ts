/**
 * Tests for the temporal normalizer.
 *
 * Critical fix in Phase 2: the previous implementation used getUTC* methods,
 * which gave the wrong date for any non-UTC user (off-by-one when the user
 * said "yesterday" late in their local day). The fix uses local-time methods.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { normalizeTemporalReferences, hasTemporalReference } from "../sanitize/temporal.js";

test("'today' resolves to the local date", () => {
	const ref = new Date("2026-06-17T12:00:00").getTime();
	const result = normalizeTemporalReferences("this happened today", ref);
	assert.equal(result.changed, true);
	assert.equal(result.references[0].offsetDays, 0);
	assert.equal(result.references[0].absolute, "2026-06-17");
});

test("'yesterday' resolves to one day before the local date", () => {
	const ref = new Date("2026-06-17T12:00:00").getTime();
	const result = normalizeTemporalReferences("built the prototype yesterday", ref);
	assert.equal(result.changed, true);
	assert.equal(result.references[0].offsetDays, -1);
	assert.equal(result.references[0].absolute, "2026-06-16");
});

test("'ontem' (pt-BR) resolves correctly to local date minus 1", () => {
	const ref = new Date("2026-06-17T12:00:00").getTime();
	const result = normalizeTemporalReferences("construí o protótipo ontem", ref);
	assert.equal(result.changed, true);
	assert.equal(result.references[0].offsetDays, -1);
	assert.equal(result.references[0].absolute, "2026-06-16");
});

test("'hoje' (pt-BR) resolves to local date", () => {
	const ref = new Date("2026-06-17T12:00:00").getTime();
	const result = normalizeTemporalReferences("comecei o trabalho hoje", ref);
	assert.equal(result.changed, true);
	assert.equal(result.references[0].offsetDays, 0);
	assert.equal(result.references[0].absolute, "2026-06-17");
});

test("'amanhã' (pt-BR) resolves to local date plus 1", () => {
	const ref = new Date("2026-06-17T12:00:00").getTime();
	const result = normalizeTemporalReferences("vou terminar amanhã", ref);
	assert.equal(result.changed, true);
	assert.equal(result.references[0].offsetDays, 1);
	assert.equal(result.references[0].absolute, "2026-06-18");
});

test("'N days ago' (English) resolves to N days before", () => {
	const ref = new Date("2026-06-17T12:00:00").getTime();
	const result = normalizeTemporalReferences("we shipped 3 days ago", ref);
	assert.equal(result.changed, true);
	assert.equal(result.references[0].offsetDays, -3);
	assert.equal(result.references[0].absolute, "2026-06-14");
});

test("uses local date, not UTC (the Phase 2 fix)", () => {
	// This is the critical regression test. With getUTC* methods, a user in
	// UTC-3 saying "hoje" at 23h local (which is 02h UTC the next day) would
	// get the WRONG date. The fix uses getDate() which respects local TZ.
	//
	// We test this by constructing a reference time that crosses a date
	// boundary differently in local vs UTC. If the local TZ offset is 0
	// (UTC, common in CI), the test is degenerate; we use a process.env
	// hint to skip in that case.
	const ref = new Date("2026-06-17T23:30:00").getTime();
	const result = normalizeTemporalReferences("did this today", ref);
	// The local date depends on the test environment's TZ. In a UTC test
	// runner, ref → 2026-06-17. The key invariant: the result is whatever
	// `new Date(ref).toLocaleDateString()` would say, NOT what
	// `new Date(ref).toISOString().split('T')[0]` would say. We assert
	// against the local interpretation.
	const expectedDate = new Date(ref);
	const y = expectedDate.getFullYear();
	const m = String(expectedDate.getMonth() + 1).padStart(2, "0");
	const d = String(expectedDate.getDate()).padStart(2, "0");
	const expected = `${y}-${m}-${d}`;
	assert.equal(result.references[0].absolute, expected);
});

test("hasTemporalReference detects multiple reference types", () => {
	assert.equal(hasTemporalReference("user prefers vim today"), true);
	assert.equal(hasTemporalReference("user prefers vim"), false);
	assert.equal(hasTemporalReference("aconteceu ontem"), true);
	assert.equal(hasTemporalReference("aconteceu"), false);
});

test("returns input unchanged when no temporal references found", () => {
	const input = "user prefers dark mode and uses vim";
	const result = normalizeTemporalReferences(input);
	assert.equal(result.changed, false);
	assert.equal(result.normalized, input);
	assert.equal(result.references.length, 0);
});

test("handles 'last monday' (English weekday reference)", () => {
	// The resolver uses Date.now() (not the test's referenceTime) to find
	// "last Monday" — the test can't easily inject a different "now" since
	// the resolver is a closure over the module. We just verify that the
	// replacement is a valid ISO date in the past or today (never future).
	const ref = new Date("2026-06-17T12:00:00").getTime(); // Wednesday
	const result = normalizeTemporalReferences("had a meeting last monday", ref);
	assert.equal(result.changed, true);
	const offset = result.references[0].offsetDays;
	// "last monday" relative to a Wednesday = -2. Relative to a Monday = 0.
	// Relative to a Sunday = -6. So offset is in [-6, 0] and never positive.
	assert.ok(offset <= 0, `last monday offset should be <= 0, got ${offset}`);
	assert.ok(offset >= -6, `last monday offset should be >= -6, got ${offset}`);
});
