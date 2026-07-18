/**
 * Tests for the auto-capture dedup behavior.
 *
 * The previous behavior was a hard "skip" when ANY auto-capture memory
 * existed for a tool — regardless of pattern type. This created two real
 * bugs:
 *
 *   1. **Cross-pattern collision**: if a tool was first captured as a
 *      success pattern (`target=project, category=convention`), a later
 *      failure pattern for the same tool (`target=failure, category=tool-quirk`)
 *      was silently dropped. The user never learned the tool was failing.
 *
 *   2. **Stale frequency**: an auto-capture memory's `frequency` field
 *      was set at creation time and never refreshed, so "Tool `read`
 *      used 3 times" stayed "3 times" forever even if the user kept
 *      using `read` for the rest of the session.
 *
 * The fix: `findCaptureCollision` returns the existing memory and a
 * `samePattern` boolean. `saveSignal` updates the existing memory when
 * the pattern type matches, and creates a new one when it doesn't.
 *
 * Status filter: only `active` memories count as a collision. A memory
 * that was `superseded` (e.g., rolled into a synthesis) is re-detectable.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { findCaptureCollision } from "../capture/signals.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-capture-test-"));
	const store = new DreamStore(join(dir, "test.db"));
	return {
		store,
		dir,
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("findCaptureCollision: returns null when no auto-capture exists", () => {
	const { store, cleanup } = makeStore();
	try {
		const result = findCaptureCollision(store, "bash", "project", "convention");
		assert.equal(result.existing, null);
		assert.equal(result.samePattern, false);
	} finally {
		cleanup();
	}
});

test("findCaptureCollision: same pattern type (project/convention) → samePattern=true", () => {
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "Tool `bash` used 3 times with similar args. Likely a recurring workflow step.",
			scope: "global",
			target: "project",
			category: "convention",
			tier: "operational",
			confidence: "inferred",
			metadata: {
				source: "auto-capture:tool:bash",
				sourceType: "auto-capture",
				tool: "bash",
				frequency: 3,
			},
		});
		const result = findCaptureCollision(store, "bash", "project", "convention");
		assert.ok(result.existing, "expected an existing memory to be returned");
		assert.equal(result.samePattern, true);
	} finally {
		cleanup();
	}
});

test("findCaptureCollision: different pattern type → samePattern=false (lets new memory through)", () => {
	const { store, cleanup } = makeStore();
	try {
		// Success pattern exists
		store.createMemory({
			content: "Tool `read` used 3 times with similar args. Likely a recurring workflow step.",
			scope: "global",
			target: "project",
			category: "convention",
			tier: "operational",
			confidence: "inferred",
			metadata: { source: "auto-capture:tool:read", sourceType: "auto-capture", tool: "read" },
		});
		// Failure pattern collision check
		const result = findCaptureCollision(store, "read", "failure", "tool-quirk");
		assert.ok(result.existing, "expected existing success-pattern to be surfaced");
		assert.equal(result.samePattern, false, "failure pattern should NOT be blocked by success pattern");
	} finally {
		cleanup();
	}
});

test("findCaptureCollision: ignored when memory is superseded (re-detectable)", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "old",
			scope: "global",
			target: "project",
			category: "convention",
			tier: "operational",
			confidence: "inferred",
			metadata: { source: "auto-capture:tool:bash", sourceType: "auto-capture", tool: "bash" },
		});
		// Mark as superseded (e.g., synthesis rolled this up)
		store.updateMemory(mem.id, { status: "superseded" });
		const result = findCaptureCollision(store, "bash", "project", "convention");
		assert.equal(result.existing, null, "superseded captures are re-detectable");
	} finally {
		cleanup();
	}
});

test("findCaptureCollision: ignored when memory is resolved", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "old",
			scope: "global",
			target: "failure",
			category: "tool-quirk",
			tier: "operational",
			confidence: "inferred",
			metadata: { source: "auto-capture:tool:read", sourceType: "auto-capture", tool: "read" },
		});
		store.updateMemory(mem.id, { status: "resolved" });
		const result = findCaptureCollision(store, "read", "failure", "tool-quirk");
		assert.equal(result.existing, null);
	} finally {
		cleanup();
	}
});

test("findCaptureCollision: ignores non-auto-capture memories (e.g., user-stated preference)", () => {
	const { store, cleanup } = makeStore();
	try {
		// A user-stated preference has sourceType=undefined, not 'auto-capture'
		store.createMemory({
			content: "user prefers vim",
			scope: "global",
			target: "user",
			category: "preference",
			tier: "factual",
			confidence: "explicit",
			metadata: { source: "user-stated" },
		});
		// A `read` tool auto-capture collision check should not match the user pref
		const result = findCaptureCollision(store, "read", "project", "convention");
		assert.equal(result.existing, null);
	} finally {
		cleanup();
	}
});

// ── saveSignal end-to-end (create / update / cross-pattern) ─────────
//
// These tests cover the user-visible behavior: when the auto-capture hook
// fires in tool_execution_end, what should the memory store look like?
// We don't run the hook directly — we call saveSignal with a hand-built
// DetectedSignal so the tests stay focused on dedup logic.

import { saveSignal, type DetectedSignal } from "../capture/signals.js";

function makeSignal(overrides: Partial<DetectedSignal> = {}): DetectedSignal {
	return {
		type: "tool-success-pattern",
		tool: "bash",
		argsHash: "hash1",
		argsPreview: '{"cmd":"npm test"}',
		frequency: 5,
		confidence: 0.8,
		scope: "global",
		target: "project",
		category: "convention",
		suggestedContent: "Tool `bash` used 5 times with similar args. Likely a recurring workflow step.",
		suggestedMetadata: {
			source: "auto-capture:tool:bash",
			sourceType: "auto-capture",
			tool: "bash",
			argsHash: "hash1",
			frequency: 5,
		},
		...overrides,
	};
}

test("saveSignal: first call creates a memory (created=true, updated=false)", () => {
	const { store, cleanup } = makeStore();
	try {
		const result = saveSignal(store, makeSignal());
		assert.equal(result.created, true);
		assert.equal(result.updated, false);
		assert.ok(result.memoryId);
		const stored = store.getMemory(result.memoryId!);
		assert.ok(stored);
		assert.equal(stored.content, "Tool `bash` used 5 times with similar args. Likely a recurring workflow step.");
	} finally {
		cleanup();
	}
});

test("saveSignal: same-pattern re-detection UPDATES the existing memory (refreshes frequency)", () => {
	const { store, cleanup } = makeStore();
	try {
		const first = saveSignal(store, makeSignal({ frequency: 3 }));
		assert.equal(first.created, true);

		// Re-detect the same pattern with a higher frequency (e.g., 3 more
		// tool calls later, now 6 total uncaptured hits in the lookback
		// window after a few were marked captured).
		const second = saveSignal(
			store,
			makeSignal({
				frequency: 6,
				suggestedContent:
					"Tool `bash` used 6 times with similar args. Likely a recurring workflow step.",
				suggestedMetadata: {
					source: "auto-capture:tool:bash",
					sourceType: "auto-capture",
					tool: "bash",
					argsHash: "hash1",
					frequency: 6,
				},
			}),
		);
		assert.equal(second.created, false, "should NOT create a second memory");
		assert.equal(second.updated, true, "should update the existing one");
		assert.equal(second.memoryId, first.memoryId, "memory id stays stable across updates");

		// The stored memory now has the refreshed content and frequency
		const stored = store.getMemory(first.memoryId!)!;
		assert.ok(stored.content.includes("used 6 times"), "content reflects new frequency");
		assert.equal((stored.metadata as any).frequency, 6, "metadata.frequency refreshed");

		// Only one memory exists for this tool pattern (no duplicate)
		const all = store.findBySource("auto-capture:tool:bash");
		assert.equal(all.length, 1, "expected exactly one auto-capture memory, not duplicates");
	} finally {
		cleanup();
	}
});

test("saveSignal: cross-pattern (failure after success) creates a SECOND memory", () => {
	const { store, cleanup } = makeStore();
	try {
		// Success pattern saved first (override source to match the tool)
		const success = saveSignal(
			store,
			makeSignal({
				tool: "read",
				target: "project",
				category: "convention",
				suggestedMetadata: {
					source: "auto-capture:tool:read",
					sourceType: "auto-capture",
					tool: "read",
					frequency: 3,
				},
			}),
		);
		assert.equal(success.created, true);

		// Failure pattern for the SAME tool, different target/category
		const failure = saveSignal(
			store,
			makeSignal({
				tool: "read",
				target: "failure",
				category: "tool-quirk",
				type: "tool-failure-pattern",
				frequency: 4,
				confidence: 0.9,
				suggestedContent:
					"Tool `read` failed 4 times (5 attempts, 80% failure rate) with similar args.",
				suggestedMetadata: {
					source: "auto-capture:tool:read",
					sourceType: "auto-capture",
					tool: "read",
					frequency: 4,
				},
			}),
		);
		assert.equal(failure.created, true, "failure pattern should NOT be blocked by success pattern");
		assert.notEqual(failure.memoryId, success.memoryId, "should be a different memory");

		// Both memories coexist
		const all = store.findBySource("auto-capture:tool:read");
		assert.equal(all.length, 2, "expected both success and failure patterns to coexist");
	} finally {
		cleanup();
	}
});

test("saveSignal: low confidence signal is rejected (created=false, updated=false)", () => {
	const { store, cleanup } = makeStore();
	try {
		const result = saveSignal(store, makeSignal({ confidence: 0.2 }));
		assert.equal(result.created, false);
		assert.equal(result.updated, false);
		assert.equal(result.reason, "confidence too low");
	} finally {
		cleanup();
	}
});
