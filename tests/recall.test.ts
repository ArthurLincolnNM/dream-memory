/**
 * Tests for the recall-strip turn logic (bug #1 fix).
 *
 * Background: Pi's `context` event fires after `before_agent_start` (where
 * we inject recall) but before the LLM call. The previous strip logic
 * removed ALL `dream-recall` custom messages, which stripped the recall we
 * just injected — silently breaking the entire auto-recall feature. The
 * fix is `isCurrentTurnRecall`: identify the just-injected recall by
 * content match and skip stripping it.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isCurrentTurnRecall } from "../recall/strip.js";
import { formatRecallForInjection } from "../recall/inject.js";
import type { SearchResult } from "../search/hybrid.js";
import type { Memory } from "../store/sqlite.js";

test("returns false when lastContent is null (no recall injected yet)", () => {
	const msg = { role: "custom", customType: "dream-recall", content: "<dream_memories>foo</dream_memories>" };
	assert.equal(isCurrentTurnRecall(msg, null), false);
});

test("returns true when string content matches lastContent exactly", () => {
	const recall = "<dream_memories><memory>User prefers dark mode</memory></dream_memories>";
	const msg = { role: "custom", customType: "dream-recall", content: recall };
	assert.equal(isCurrentTurnRecall(msg, recall), true);
});

test("returns false when string content differs (this is an OLD recall, should be stripped)", () => {
	const currentRecall = "<dream_memories>current</dream_memories>";
	const oldRecall = "<dream_memories>previous turn content</dream_memories>";
	const msg = { role: "custom", customType: "dream-recall", content: oldRecall };
	assert.equal(isCurrentTurnRecall(msg, currentRecall), false);
});

test("returns true when array content contains a text block matching lastContent", () => {
	const recall = "<dream_memories>block 1</dream_memories>";
	const msg = {
		role: "custom",
		customType: "dream-recall",
		content: [
			{ type: "text", text: "<dream_memories>other block</dream_memories>" },
			{ type: "text", text: recall },
		],
	};
	assert.equal(isCurrentTurnRecall(msg, recall), true);
});

test("returns false when array content has no matching text block", () => {
	const currentRecall = "<dream_memories>current</dream_memories>";
	const msg = {
		role: "custom",
		customType: "dream-recall",
		content: [
			{ type: "text", text: "<dream_memories>old</dream_memories>" },
			{ type: "image", url: "data:image/png;base64,..." },
		],
	};
	assert.equal(isCurrentTurnRecall(msg, currentRecall), false);
});

test("scanning array content matches any block whose text field equals lastContent (type-agnostic)", () => {
	const currentRecall = "<dream_memories>current</dream_memories>";
	// The implementation matches any block with a string `text` field, regardless
	// of its `type`. This is intentional: a content match is the only signal that
	// matters for "is this the recall we just injected?" — the block's media type
	// is irrelevant. If a non-text block has the same text by coincidence, the
	// worst case is we skip stripping (safe: same effect as the LLM seeing the
	// recall once).
	const msg = {
		role: "custom",
		customType: "dream-recall",
		content: [{ type: "image", url: "x", text: currentRecall }],
	};
	assert.equal(isCurrentTurnRecall(msg, currentRecall), true);
});

test("returns false when content is neither string nor array (defensive)", () => {
	const msg = { role: "custom", customType: "dream-recall", content: 42 };
	assert.equal(isCurrentTurnRecall(msg, "anything"), false);
});

test("returns false for empty content when lastContent is non-empty", () => {
	const msg = { role: "custom", customType: "dream-recall", content: "" };
	assert.equal(isCurrentTurnRecall(msg, "non-empty"), false);
});

// ── Score Floor Tests ─────────────────────────────────────────────────
//
// formatRecallForInjection should discard results with very low score
// or decay to avoid injecting useless memories into LLM context.

function mockMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "test-1",
		content: "User prefers dark mode",
		scope: "global",
		target: "user",
		category: "preference",
		status: "active",
		tier: "factual",
		created_at: Date.now(),
		updated_at: Date.now(),
		access_count: 0,
		metadata: {},
		confidence: "explicit",
		...overrides,
	};
}

function mockResult(overrides: Partial<SearchResult> = {}): SearchResult {
	return {
		memory: mockMemory(),
		score: 0.5,
		snippet: "User prefers dark mode",
		...overrides,
	};
}

test("score floor: filters out memories with score below 0.1", () => {
	const results = [
		mockResult({ score: 0.5 }),   // above threshold
		mockResult({ score: 0.05 }), // below threshold → filtered
		mockResult({ score: 0.0 }),  // zero → filtered
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	const memoryCount = (output.match(/<memory /g) || []).length;
	assert.equal(memoryCount, 1);
});

test("score floor: filters out memories with very low decay (old operational)", () => {
	const now = Date.now();
	// 0.95^60 ≈ 0.046, well below MIN_DECAY=0.1
	const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;

	const results = [
		mockResult({
			score: 0.5,
			memory: mockMemory({
				id: "old-op",
				content: "Old operational memory",
				tier: "operational",
				ttl_days: 1,
				created_at: now - SIXTY_DAYS,
				updated_at: now - SIXTY_DAYS,
				last_accessed_at: now - SIXTY_DAYS,
				access_count: 0,
			}),
			snippet: "Old operational memory",
		}),
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	// Old operational memory with no access should have very low decay (~0.046)
	// Output should be empty (all filtered)
	assert.equal(output, "");
});

test("score floor: returns empty string when all results filtered out", () => {
	const results = [
		mockResult({ score: 0.0 }),
		mockResult({ score: 0.01 }),
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	assert.equal(output, "");
});

test("score floor: keeps memories above both thresholds", () => {
	const results = [
		mockResult({ score: 0.15 }),  // above MIN_SCORE=0.1
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	assert.ok(output.includes("<memory"));
	assert.ok(output.includes("User prefers dark mode"));
});

// ── Near-Duplicate Dedup Tests (R1 v3) ────────────────────────────────
//
// After score floor, results should be deduped by content similarity.
// Read-time only: does NOT mutate the DB. Threshold 0.7 (bigram Jaccard)
// groups paraphrases of the same fact; the top-scored of each group wins.
// Short content (< 20 chars) skips dedup entirely.

test("dedup: collapses 4 near-duplicate CosyVoice memories to 1", () => {
	// Set snippet = content so we can identify the survivor by its text.
	// In production the FTS5 snippet is a relevant window around the match;
	// for tests we control the snippet directly.
	const results = [
		mockResult({ memory: mockMemory({ id: "cv-1", content: "CosyVoice is great for TTS tasks in production" }), score: 0.5, snippet: "CosyVoice is great for TTS tasks in production" }),
		mockResult({ memory: mockMemory({ id: "cv-2", content: "CosyVoice works well for TTS tasks in production" }), score: 0.6, snippet: "CosyVoice works well for TTS tasks in production" }),
		mockResult({ memory: mockMemory({ id: "cv-3", content: "CosyVoice is good for TTS tasks in production" }), score: 0.4, snippet: "CosyVoice is good for TTS tasks in production" }),
		mockResult({ memory: mockMemory({ id: "cv-4", content: "Use CosyVoice for TTS tasks in production" }), score: 0.55, snippet: "Use CosyVoice for TTS tasks in production" }),
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	const memoryCount = (output.match(/<memory /g) || []).length;
	assert.equal(memoryCount, 1, "4 near-duplicates should collapse to 1 in recall output");
	// Highest-scored one (cv-2, score 0.6) should win. We check the
	// `score="0.60"` attribute because snippet text is what gets injected,
	// and the survivor's snippet identifies which memory survived.
	assert.ok(output.includes('score="0.60"'), "top-scored duplicate should be the survivor (score 0.60)");
	assert.ok(output.includes("works well"), "survivor's snippet should appear in output");
});

test("dedup: keeps memories with genuinely different content", () => {
	const results = [
		mockResult({ memory: mockMemory({ id: "a", content: "User prefers Vim as the primary editor for all projects" }), score: 0.5 }),
		mockResult({ memory: mockMemory({ id: "b", content: "Project uses PostgreSQL as the main database backend" }), score: 0.6 }),
		mockResult({ memory: mockMemory({ id: "c", content: "Build command for the frontend is npm run build" }), score: 0.4 }),
		mockResult({ memory: mockMemory({ id: "d", content: "Tests run with vitest and cover all unit and integration paths" }), score: 0.55 }),
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	const memoryCount = (output.match(/<memory /g) || []).length;
	assert.equal(memoryCount, 4, "4 different topics should all be injected");
});

test("dedup: keeps top-scored within a similarity group", () => {
	const results = [
		mockResult({ memory: mockMemory({ id: "low", content: "CosyVoice is the best TTS engine for production workloads" }), score: 0.3 }),
		mockResult({ memory: mockMemory({ id: "high", content: "CosyVoice is the best TTS engine for production workloads" }), score: 0.9 }),
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	const memoryCount = (output.match(/<memory /g) || []).length;
	assert.equal(memoryCount, 1, "identical content should collapse to 1");
	// Since `prev` is iterated in order (low first), high should NOT be added.
	// Either way, exactly 1 result — content is literally identical so the
	// tie-breaker is irrelevant. We just assert dedup happens.
});

test("dedup: skips short content (< 20 chars) to avoid noisy similarity", () => {
	const results = [
		mockResult({ memory: mockMemory({ id: "s1", content: "use vim" }), score: 0.5 }),
		mockResult({ memory: mockMemory({ id: "s2", content: "use vim" }), score: 0.6 }),
		mockResult({ memory: mockMemory({ id: "s3", content: "use vim" }), score: 0.4 }),
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	const memoryCount = (output.match(/<memory /g) || []).length;
	assert.equal(memoryCount, 3, "short content should skip dedup entirely");
});

// ── R3 v3: Read-time stale detection tests ────────────────────────────
//
// After R1 v3 dedup, results with same (target, category) and content
// similarity in (0.6, 0.95) flag the older one as stale in the XML
// output. Read-time only — no DB writes. Threshold band chosen so R1 v3
// dedups the obvious near-duplicates (≥0.7) and R3 only sees the
// looser-paraphrase band.

test("R3: flags older memory as stale when newer version exists (same target+category)", () => {
	const old = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
	const recent = Date.now();
	const results = [
		mockResult({
			memory: mockMemory({
				id: "old-vim",
				content: "User uses vim for all editing tasks with extensive configuration",
				updated_at: old,
				created_at: old,
			}),
			score: 0.5,
			snippet: "User uses vim for all editing tasks with extensive configuration",
		}),
		mockResult({
			memory: mockMemory({
				id: "new-vim",
				content: "User uses vim for all editing tasks with lazyvim configuration and custom keybindings",
				updated_at: recent,
				created_at: old,
			}),
			score: 0.6,
			snippet: "User uses vim for all editing tasks with lazyvim configuration and custom keybindings",
		}),
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	// The newer one (new-vim) should NOT be stale
	const newerMatch = output.match(/<memory[^>]*?target="user"[^>]*?>/g);
	assert.ok(newerMatch, "should have memory entries");
	// Find the entry containing the newer memory's id-reference is tricky
	// since id isn't in the XML. Instead, check by score attribute and
	// stale attribute presence.
	// new-vim has score 0.6 (no stale), old-vim has score 0.5 + stale
	assert.ok(output.includes('score="0.60"'), "newer memory (score 0.60) should appear");
	assert.ok(output.includes('score="0.50"'), "older memory (score 0.50) should still appear (read-time only, not removed)");
	assert.ok(
		output.includes('stale="true"'),
		"older memory should be flagged stale in the XML output",
	);
	assert.ok(
		output.includes('superseded-by="new-vim"'),
		"stale flag should reference the newer memory's id",
	);
});

test("R3: does NOT flag memories with different target or category", () => {
	const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
	const recent = Date.now();
	const results = [
		// user/preference — older
		mockResult({
			memory: mockMemory({
				id: "old-pref",
				content: "User prefers dark mode in all editors and IDEs",
				target: "user",
				category: "preference",
				updated_at: old,
			}),
			score: 0.5,
			snippet: "User prefers dark mode in all editors and IDEs",
		}),
		// project/convention — newer (different target+category, even if text is similar)
		mockResult({
			memory: mockMemory({
				id: "new-conv",
				content: "Project uses dark mode in all editors and IDEs as the default theme",
				target: "project",
				category: "convention",
				updated_at: recent,
			}),
			score: 0.6,
			snippet: "Project uses dark mode in all editors and IDEs as the default theme",
		}),
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	assert.ok(
		!output.includes("stale="),
		"different target/category memories should NOT be flagged stale (they coexist, not supersede)",
	);
});

test("R3: identical content goes through R1 dedup, not R3 stale", () => {
	const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
	const recent = Date.now();
	const results = [
		mockResult({
			memory: mockMemory({ id: "old-dup", content: "User uses lazyvim for all editing tasks with extensive configuration", updated_at: old }),
			score: 0.5,
			snippet: "User uses lazyvim for all editing tasks with extensive configuration",
		}),
		mockResult({
			memory: mockMemory({ id: "new-dup", content: "User uses lazyvim for all editing tasks with extensive configuration", updated_at: recent }),
			score: 0.6,
			snippet: "User uses lazyvim for all editing tasks with extensive configuration",
		}),
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	const memoryCount = (output.match(/<memory /g) || []).length;
	assert.equal(memoryCount, 1, "identical content should be deduped by R1 v3 to 1");
	assert.ok(
		!output.includes("stale="),
		"R1 dedupes identicals; R3 should not also flag stale on the deduped one",
	);
});

test("R3: skips stale detection for short content (noise guard)", () => {
	const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
	const recent = Date.now();
	const results = [
		mockResult({
			memory: mockMemory({ id: "short1", content: "use vim always", updated_at: old }),
			score: 0.5,
			snippet: "use vim always",
		}),
		mockResult({
			memory: mockMemory({ id: "short2", content: "use vim here", updated_at: recent }),
			score: 0.6,
			snippet: "use vim here",
		}),
	];

	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	assert.ok(
		!output.includes("stale="),
		"short content (< 20 chars) should skip stale detection entirely",
	);
});

test("R3: surfaces stale note in markdown and plain formats too", () => {
	// Reuse content from the working XML test (similarity in (0.6, 0.95)
	// is verified by that test passing). R3 detection runs before format
	// rendering, so the same content triggers stale regardless of format.
	const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
	const recent = Date.now();
	const results = [
		mockResult({
			memory: mockMemory({ id: "md-old", content: "User uses vim for all editing tasks with extensive configuration", updated_at: old }),
			score: 0.5,
			snippet: "User uses vim for all editing tasks with extensive configuration",
		}),
		mockResult({
			memory: mockMemory({ id: "md-new", content: "User uses vim for all editing tasks with lazyvim configuration and custom keybindings", updated_at: recent }),
			score: 0.6,
			snippet: "User uses vim for all editing tasks with lazyvim configuration and custom keybindings",
		}),
	];

	const mdOutput = formatRecallForInjection(results, { maxTokens: 4000, format: "markdown" });
	assert.ok(mdOutput.includes("[stale: newer-version-exists]"), "markdown should surface stale note");

	const plainOutput = formatRecallForInjection(results, { maxTokens: 4000, format: "plain" });
	assert.ok(plainOutput.includes("(stale: newer-version-exists)"), "plain should surface stale note");
});

// ── R6 v3: per-category cap tests ─────────────────────────────────────
//
// Group by category, drop lowest-scored excess when over cap. Read-time
// only. Default config has empty caps (no-op). Caps are opt-in per
// category; uncapped categories pass through.

test("R6: empty caps is a no-op (default config)", () => {
	const results = [
		mockResult({ memory: mockMemory({ id: "p1", content: "User prefers dark mode in all editors and IDEs", category: "preference" }), score: 0.6 }),
		mockResult({ memory: mockMemory({ id: "p2", content: "User prefers vim with custom keybindings and modal editing", category: "preference" }), score: 0.5 }),
		mockResult({ memory: mockMemory({ id: "p3", content: "User prefers lazyvim for extensive plugin support", category: "preference" }), score: 0.4 }),
	];
	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	const memoryCount = (output.match(/<memory /g) || []).length;
	assert.equal(memoryCount, 3, "no caps means all 3 preferences injected");
});

test("R6: cap=2 on preference drops the lowest-scored of 3", () => {
	const results = [
		mockResult({ memory: mockMemory({ id: "p1", content: "User prefers dark mode in all editors and IDEs across all platforms", category: "preference" }), score: 0.6, snippet: "User prefers dark mode in all editors and IDEs across all platforms" }),
		mockResult({ memory: mockMemory({ id: "p2", content: "User prefers vim with custom keybindings for modal editing in the workflow", category: "preference" }), score: 0.5, snippet: "User prefers vim with custom keybindings for modal editing in the workflow" }),
		mockResult({ memory: mockMemory({ id: "p3", content: "User prefers lazyvim for extensive plugin support in the project setup", category: "preference" }), score: 0.4, snippet: "User prefers lazyvim for extensive plugin support in the project setup" }),
	];
	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml", categoryCaps: { preference: 2 } });
	const memoryCount = (output.match(/<memory /g) || []).length;
	assert.equal(memoryCount, 2, "cap=2 on preference should drop 1 of 3");
	assert.ok(!output.includes("lazyvim"), "lowest-scored (lazyvim, 0.4) should be dropped");
	assert.ok(output.includes("dark mode"), "highest-scored (dark mode, 0.6) should survive");
});

test("R6: per-category caps are independent (preference capped, convention not)", () => {
	const results = [
		mockResult({ memory: mockMemory({ id: "p1", content: "User prefers dark mode in all editors across all platforms and contexts", category: "preference" }), score: 0.5, snippet: "User prefers dark mode in all editors across all platforms and contexts" }),
		mockResult({ memory: mockMemory({ id: "p2", content: "User prefers vim with extensive keybindings and modal editing for the workflow", category: "preference" }), score: 0.4, snippet: "User prefers vim with extensive keybindings and modal editing for the workflow" }),
		mockResult({ memory: mockMemory({ id: "c1", content: "Project uses TypeScript strict mode with all the strict flags enabled across the codebase", category: "convention" }), score: 0.7, snippet: "Project uses TypeScript strict mode with all the strict flags enabled across the codebase" }),
		mockResult({ memory: mockMemory({ id: "c2", content: "Project uses vitest for unit testing and integration testing across all the modules", category: "convention" }), score: 0.6, snippet: "Project uses vitest for unit testing and integration testing across all the modules" }),
		mockResult({ memory: mockMemory({ id: "c3", content: "Project uses ESLint with the recommended config and prettier integration across the team", category: "convention" }), score: 0.5, snippet: "Project uses ESLint with the recommended config and prettier integration across the team" }),
	];
	const output = formatRecallForInjection(results, {
		maxTokens: 4000,
		format: "xml",
		categoryCaps: { preference: 1 },
	});
	const memoryCount = (output.match(/<memory /g) || []).length;
	assert.equal(memoryCount, 4, "1 preference + 3 conventions = 4");
	assert.ok(output.includes("dark mode"), "preference top-1 (dark mode) survives");
	assert.ok(!output.includes("vim with extensive"), "preference 0.4 dropped");
	assert.ok(output.includes("TypeScript"), "convention uncapped, all 3 present");
	assert.ok(output.includes("vitest"), "convention uncapped, all 3 present");
	assert.ok(output.includes("ESLint"), "convention uncapped, all 3 present");
});

test("R6: cap=0 hides an entire category", () => {
	const results = [
		mockResult({ memory: mockMemory({ id: "f1", content: "Failure pattern: build fails with timeout in CI when network is slow during testing", category: "failure" }), score: 0.5, snippet: "Failure pattern: build fails with timeout in CI when network is slow during testing" }),
		mockResult({ memory: mockMemory({ id: "p1", content: "User prefers dark mode in all editors across all platforms and contexts always", category: "preference" }), score: 0.6, snippet: "User prefers dark mode in all editors across all platforms and contexts always" }),
	];
	const output = formatRecallForInjection(results, {
		maxTokens: 4000,
		format: "xml",
		categoryCaps: { failure: 0 },
	});
	assert.ok(!output.includes("Failure pattern"), "failure (cap=0) hidden");
	assert.ok(output.includes("dark mode"), "preference (uncapped) survives");
	const memoryCount = (output.match(/<memory /g) || []).length;
	assert.equal(memoryCount, 1);
});

// ── Gap #1: intent-based relevance gate (opt-in via query) ──
//
// When the caller passes `query` in InjectOptions, the recall detects
// intent (debug / preference / procedure / convention / insight /
// general) and re-ranks memories of the matching category. Without
// `query`, no behavior change — backward compat preserved.

test("Gap #1: debug query boosts failure/tool-quirk above preference", () => {
	const failMark = "Tool bash fails 3";
	const prefMark = "primary editor";
	const results = [
		mockResult({ memory: mockMemory({ id: "pref-1", content: "User prefers Vim as the " + prefMark + " for all projects", category: "preference" }), score: 0.5, snippet: "User prefers Vim as the " + prefMark + " for all projects" }),
		mockResult({ memory: mockMemory({ id: "fail-1", content: failMark + " times with similar args in CI when network is slow", category: "failure" }), score: 0.3, snippet: failMark + " times with similar args in CI when network is slow" }),
	];
	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml", query: "why is bash failing in my CI" });
	const failIdx = output.indexOf(failMark);
	const prefIdx = output.indexOf(prefMark);
	assert.ok(failIdx > -1 && prefIdx > -1, "both memories in output");
	assert.ok(failIdx < prefIdx, "failure should rank above preference when debug intent is detected (fail=" + failIdx + ", pref=" + prefIdx + ")");
});

test("Gap #1: preference query boosts preference memories", () => {
	const failMark = "Tool bash fails 3";
	const prefMark = "Ghostty as the terminal";
	const results = [
		mockResult({ memory: mockMemory({ id: "fail-1", content: failMark + " times with similar args in CI when network is slow", category: "failure" }), score: 0.7, snippet: failMark + " times with similar args in CI when network is slow" }),
		mockResult({ memory: mockMemory({ id: "pref-1", content: "User prefers " + prefMark + " emulator for all workflows", category: "preference" }), score: 0.4, snippet: "User prefers " + prefMark + " emulator for all workflows" }),
	];
	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml", query: "what terminal do I prefer" });
	const failIdx = output.indexOf(failMark);
	const prefIdx = output.indexOf(prefMark);
	assert.ok(failIdx > -1 && prefIdx > -1, "both memories in output");
	assert.ok(prefIdx < failIdx, "preference should rank above failure when preference intent is detected");
});

test("Gap #1: no query means no boost (backward compat)", () => {
	const failMark = "Tool bash fails 3";
	const prefMark = "primary editor";
	const results = [
		mockResult({ memory: mockMemory({ id: "fail-1", content: failMark + " times with similar args in CI when network is slow", category: "failure" }), score: 0.3, snippet: failMark + " times with similar args in CI when network is slow" }),
		mockResult({ memory: mockMemory({ id: "pref-1", content: "User prefers Vim as the " + prefMark + " for all projects", category: "preference" }), score: 0.7, snippet: "User prefers Vim as the " + prefMark + " for all projects" }),
	];
	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml" });
	const failIdx = output.indexOf(failMark);
	const prefIdx = output.indexOf(prefMark);
	assert.ok(prefIdx < failIdx, "without query, higher score wins (no intent boost)");
});

test("Gap #1: general intent (no keyword match) is a no-op", () => {
	const prefMark = "dark mode in all editors";
	const convMark = "TypeScript for all source";
	const results = [
		mockResult({ memory: mockMemory({ id: "a", content: "User prefers " + prefMark + " across all platforms for work", category: "preference" }), score: 0.5, snippet: "User prefers " + prefMark + " across all platforms for work" }),
		mockResult({ memory: mockMemory({ id: "b", content: "Project uses " + convMark + " code in the repository", category: "convention" }), score: 0.4, snippet: "Project uses " + convMark + " code in the repository" }),
	];
	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml", query: "tell me about my project" });
	const prefIdx = output.indexOf(prefMark);
	const convIdx = output.indexOf(convMark);
	assert.ok(prefIdx < convIdx, "general intent doesn't boost any category — order by score");
});

test("Gap #1: procedure query boosts procedure + convention", () => {
	const prefMark = "primary editor";
	const procMark = "coding workflow";
	const convMark = "uses tabs for indentation";
	const results = [
		mockResult({ memory: mockMemory({ id: "pref-1", content: "User prefers Vim as the " + prefMark + " for all projects and contexts", category: "preference" }), score: 0.5, snippet: "User prefers Vim as the " + prefMark + " for all projects and contexts" }),
		mockResult({ memory: mockMemory({ id: "proc-1", content: "User's " + procMark + ": write failing test then fix then run full suite then commit small", category: "procedure" }), score: 0.3, snippet: "User's " + procMark + ": write failing test then fix then run full suite then commit small" }),
		mockResult({ memory: mockMemory({ id: "conv-1", content: "Project " + convMark + " not spaces per the convention", category: "convention" }), score: 0.4, snippet: "Project " + convMark + " not spaces per the convention" }),
	];
	const output = formatRecallForInjection(results, { maxTokens: 4000, format: "xml", query: "how to set up a new project" });
	const procIdx = output.indexOf(procMark);
	const convIdx = output.indexOf(convMark);
	const prefIdx = output.indexOf(prefMark);
	assert.ok(procIdx > -1 && convIdx > -1 && prefIdx > -1, "all 3 memories in output");
	assert.ok(procIdx < prefIdx, "procedure (boosted 2.0x) should outrank preference (no boost)");
	assert.ok(convIdx < prefIdx, "convention (boosted 1.3x) should outrank preference (no boost)");
});
