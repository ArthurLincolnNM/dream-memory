/**
 * dream-memory/capture/signals.ts
 *
 * Auto-capture: detect high-signal patterns in tool usage and save them as memories
 * without explicit user prompt. Inspired by Anthropic Auto Memory.
 *
 * Two signal types detected (deterministic, no LLM):
 *
 * 1. TOOL_SUCCESS_PATTERN — same tool+args used ≥N times in lookback window
 *    → Save as `project:convention` (likely a workflow step)
 *
 * 2. TOOL_FAILURE_PATTERN — same tool+args failed ≥N times in lookback window
 *    → Save as `failure:tool-quirk` (likely a bug or environment issue)
 *
 * Anti-spam: max 1 memory per (tool, args_hash) tuple. We check for existing
 * auto-capture memories before saving.
 */

import type { DreamStore } from "../store/sqlite.js";
import { sanitizeCredentials } from "../sanitize/credentials.js";
import { isRealProject } from "../scope/resolver.js";
import { normalizeTemporalReferences } from "../sanitize/temporal.js";

export type SignalType = "tool-success-pattern" | "tool-failure-pattern";

export interface CaptureConfig {
	enabled: boolean;
	toolPatternMinFrequency: number;
	toolFailureMinFrequency: number;
	lookbackDays: number;
	minConfidence: number;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
	enabled: true,
	toolPatternMinFrequency: 5,
	toolFailureMinFrequency: 3,
	lookbackDays: 7,
	minConfidence: 0.75,
};

export interface DetectedSignal {
	type: SignalType;
	tool: string;
	argsHash: string;
	argsPreview: string;
	frequency: number;
	confidence: number;
	scope: "global" | "project";
	target: "user" | "memory" | "project" | "failure";
	category: "convention" | "tool-quirk";
	suggestedContent: string;
	suggestedMetadata: Record<string, any>;
	/** v2.0: trust level assigned by auto-capture. Default 0 (llm_extracted). */
	trust_level?: number;
}

/**
 * Detect all signals from the tool_usage table for the current state.
 * Used by the auto-capture hook in tool_execution_end.
 *
 * Strategy: run detection ONLY for the tool that just completed (not full scan).
 * We query `tool_usage` for the same (tool, args_hash) in the lookback window.
 */
export function detectToolSignals(
	store: DreamStore,
	tool: string,
	argsHash: string,
	argsPreview: string,
	isError: boolean,
	cwd: string,
	config: CaptureConfig = DEFAULT_CAPTURE_CONFIG,
): DetectedSignal | null {
	if (!config.enabled) return null;

	const lookbackMs = config.lookbackDays * 86400000;
	const since = Date.now() - lookbackMs;

	// Query tool_usage for this exact (tool, args_hash) in the lookback window
	const usages = store.getToolUsageInWindow({
		tool,
		argsHash,
		since,
	});

	if (usages.length === 0) return null;

	const total = usages.length;
	const failures = usages.filter((u) => !u.success).length;
	const successes = total - failures;

	// Signal 1: TOOL_FAILURE_PATTERN (failures >= threshold)
	if (failures >= config.toolFailureMinFrequency) {
		const failureRate = failures / total;
		// Confidence: base on failure rate × (frequency / threshold)
		// 3 failures at 100% rate = 0.6, 5+ = 1.0
		const confidence = Math.min(1, failureRate * (failures / 5));

		if (confidence < config.minConfidence) return null;

		// Sample error messages (if available)
		const errorSample = usages
			.filter((u) => !u.success && u.error_preview)
			.slice(0, 3)
			.map((u) => u.error_preview)
			.join(" | ");

		const preview = argsPreview.length > 100 ? argsPreview.slice(0, 100) + "..." : argsPreview;
		const errorInfo = errorSample ? ` Errors: ${errorSample}` : "";

		return {
			type: "tool-failure-pattern",
			tool,
			argsHash,
			argsPreview: argsPreview,
			frequency: failures,
			confidence,
			scope: detectScope(cwd),
			target: "failure",
			category: "tool-quirk",
			suggestedContent: `Tool \`${tool}\` failed ${failures} times (${total} attempts, ${Math.round(failureRate * 100)}% failure rate) with similar args. Args: ${preview}.${errorInfo}`,
			suggestedMetadata: {
				source: `auto-capture:tool:${tool}`,
				sourceType: "auto-capture",
				confidence,
				tool,
				argsHash,
				frequency: failures,
				totalAttempts: total,
				failureRate,
				errorSample,
				firstSeen: usages[0].timestamp,
				lastSeen: usages[usages.length - 1].timestamp,
				// Gap #2: reason field. Surfaced in recall XML so the agent
				// can tell WHY this auto-capture fired without inspecting
				// raw metadata. Concise (1-2 lines), derived from the same
				// data the suggestedContent uses.
				reason: buildAutoCaptureReason({
					tool,
					frequency: failures,
					failureRate,
					firstSeen: usages[0].timestamp,
					lastSeen: usages[usages.length - 1].timestamp,
					type: "failure",
				}),
			},
			// v2.0: auto-captured patterns get lowest trust (llm_extracted)
			trust_level: 0,
		};
	}

	// Signal 2: TOOL_SUCCESS_PATTERN (successes >= threshold)
	if (successes >= config.toolPatternMinFrequency) {
		// Confidence: 3 hits = 0.6, 5+ = 1.0
		const confidence = Math.min(1, successes / 5);
		if (confidence < config.minConfidence) return null;

		const preview = argsPreview.length > 100 ? argsPreview.slice(0, 100) + "..." : argsPreview;

		return {
			type: "tool-success-pattern",
			tool,
			argsHash,
			argsPreview: argsPreview,
			frequency: successes,
			confidence,
			scope: detectScope(cwd),
			target: "project",
			category: "convention",
			suggestedContent: `Tool \`${tool}\` used ${successes} times with similar args. Likely a recurring workflow step. Args: ${preview}`,
			suggestedMetadata: {
				source: `auto-capture:tool:${tool}`,
				sourceType: "auto-capture",
				confidence,
				tool,
				argsHash,
				frequency: successes,
				firstSeen: usages[0].timestamp,
				lastSeen: usages[usages.length - 1].timestamp,
				reason: buildAutoCaptureReason({
					tool,
					frequency: successes,
					firstSeen: usages[0].timestamp,
					lastSeen: usages[usages.length - 1].timestamp,
					type: "success",
				}),
			},
			// v2.0: auto-captured patterns get lowest trust (llm_extracted)
			trust_level: 0,
		};
	}

	return null;
}

/**
 * Determine memory scope based on cwd (project vs global).
 * If we can detect a project ID, scope=project. Otherwise global.
 *
 * Uses the shared `isRealProject` from scope/resolver.ts to keep the criterion
 * in one place. Without this, all auto-captures were hardcoded to "project"
 * and landed in global.db with scope_id=NULL — polluting global scope with
 * project conventions/failures and leaking them into every other project.
 *
 * Strict mode: only return "project" when cwd has a .git/ or package.json —
 * a basename fallback would otherwise mark every random directory as a
 * "project" (e.g., cwd=/tmp → project="tmp" → scope=project).
 */
function detectScope(cwd: string): "global" | "project" {
	return isRealProject(cwd) ? "project" : "global";
}

/**
 * Find an existing auto-capture memory for a (tool, pattern-type) tuple.
 *
 * The original `hasExistingCapture` did a binary check by tool name only
 * and returned `true` for ANY existing auto-capture. That caused two bugs:
 *
 *   1. **Cross-pattern collision**: a success-pattern capture (`project:
 *      convention`) for tool `read` silently blocked a later failure
 *      pattern (`failure: tool-quirk`) for the same tool. The user never
 *      learned that `read` started failing.
 *
 *   2. **Stale frequency**: the original `saveSignal` would skip on any
 *      existing capture, so the frequency counter froze at creation time.
 *      "Tool `read` used 3 times" stayed "3 times" forever, even if the
 *      user kept using `read` for the rest of the session.
 *
 * The new function returns the existing memory AND a `samePattern` boolean
 * so the caller can:
 *   - update the existing memory when the pattern type matches
 *     (refreshing frequency), OR
 *   - create a new memory when the pattern type differs
 *     (cross-pattern coexistence).
 *
 * Status filter: only `active` memories count. A capture that was
 * `superseded` (e.g., rolled into a synthesis) or `resolved` is
 * re-detectable — the previous behavior blocked re-detection even after
 * the user explicitly cleared the memory, which was surprising.
 *
 * Source-type filter: the memory must have `sourceType === "auto-capture"`.
 * A user-stated preference that happens to share a tool name in its
 * content (e.g., "user prefers rg over grep") should not block an
 * auto-capture for `rg`.
 */
export function findCaptureCollision(
	store: DreamStore,
	tool: string,
	expectedTarget: "user" | "memory" | "project" | "failure",
	expectedCategory: "failure" | "correction" | "insight" | "preference" | "convention" | "tool-quirk",
): { existing: import("../store/sqlite.js").Memory | null; samePattern: boolean } {
	const candidates = store.findBySource(`auto-capture:tool:${tool}`);
	for (const m of candidates) {
		const meta = m.metadata as any;
		// Skip non-auto-capture memories (e.g., user-stated preferences)
		// and non-active memories (superseded/resolved are re-detectable).
		if (meta?.sourceType !== "auto-capture") continue;
		if (m.status !== "active") continue;
		// Match the (target, category) tuple exactly. A success pattern
		// (project/convention) and a failure pattern (failure/tool-quirk)
		// for the same tool are DIFFERENT memories that should coexist.
		if (m.target === expectedTarget && m.category === expectedCategory) {
			return { existing: m, samePattern: true };
		}
		// Different pattern type — return the first match so the caller
		// knows a collision exists, but mark samePattern=false so the
		// caller creates a new memory instead of updating this one.
		return { existing: m, samePattern: false };
	}
	return { existing: null, samePattern: false };
}

/**
 * Save a detected signal as a memory, after sanitization and temporal normalization.
 *
 * Three outcomes:
 *   1. **create** (no collision) — new memory persisted
 *   2. **update** (same-pattern collision) — existing memory's content and
 *      metadata are refreshed with the fresh frequency/timestamps. The
 *      memory id stays stable so external references (e.g., links) don't
 *      dangle. Resolves bug "stale frequency".
 *   3. **skip** (different-pattern collision that is somehow not a creation
 *      candidate — currently unused, reserved for future policies)
 *
 * @param store  The store where the new memory is persisted. May be the
 *               global or project store (depends on signal.scope).
 * @param toolUsageStore  The store that holds the `tool_usage` table.
 *               Always global.db in practice — tool_usage is written by
 *               `trackToolCall(global, ...)` in the tool_execution_end
 *               handler. The previous code passed `store` for both
 *               purposes, so signals with scope=project leaked captured_at
 *               updates into the project store (no-op for the project
 *               table, which has no tool_usage rows) while the global
 *               rows stayed uncaptured — allowing the same pattern to be
 *               re-detected next time. Now we take an explicit second
 *               argument so callers (index.ts) route the capture to global.
 */
export function saveSignal(
	store: DreamStore,
	signal: DetectedSignal,
	toolUsageStore: DreamStore = store,
): {
	created: boolean;
	updated: boolean;
	reason?: string;
	memoryId?: string;
} {
	// Sanitize credentials (defense in depth) before any dedup decision so the
	// content we store in both create + update paths is the same shape.
	const { sanitized } = sanitizeCredentials(signal.suggestedContent);
	const temporal = normalizeTemporalReferences(sanitized);
	const finalContent = temporal.normalized;

	// Reject if confidence too low after processing
	if (signal.confidence < 0.3) {
		return { created: false, updated: false, reason: "confidence too low" };
	}

	// Anti-spam with pattern-type awareness. Replaces the old binary
	// hasExistingCapture (which blocked any second signal for the same tool).
	// - samePattern: existing memory of the same (target, category). Refresh it.
	// - existing-but-different: cross-pattern collision. Create a new memory
	//   (failure and success patterns for the same tool coexist).
	// - no existing: create fresh.
	const collision = findCaptureCollision(store, signal.tool, signal.target, signal.category);

	if (collision.samePattern && collision.existing) {
		// Refresh the existing memory's content (fresh frequency count in the
		// text) and metadata (frequency, lastSeen, errorSample if failure).
		// We MERGE into the existing metadata so we keep fields that are
		// static across updates (e.g., `tool`, `source`, `sourceType`).
		const mergedMetadata = {
			...collision.existing.metadata,
			...signal.suggestedMetadata,
			...(temporal.changed ? { temporalNormalized: true } : {}),
		};
		const updated = store.updateMemory(collision.existing.id, {
			content: finalContent,
			metadata: mergedMetadata,
		});
		if (!updated) {
			// updateMemory returns null only if the row vanished between
			// the findCaptureCollision and the update (race). Fall through
			// to create — the tool_usage marks are best-effort and the
			// caller can re-fire next time.
			return { created: false, updated: false, reason: "race" };
		}
		// Do NOT call markToolUsageCaptured again: those rows were already
		// marked the first time, and the new high-confidence signal's rows
		// will get marked on the NEXT saveSignal cycle (when the new
		// tool_usage hits reach the threshold). Marking them now would
		// double-count and could create a different kind of inconsistency.
		return { created: false, updated: true, memoryId: updated.id };
	}

	// No same-pattern collision → create new memory. The cross-pattern case
	// (existing but different target/category) also falls here, so a
	// success pattern and a failure pattern for the same tool coexist.
	const memory = store.createMemory({
		content: finalContent,
		scope: signal.scope,
		target: signal.target,
		category: signal.category,
		tier: "operational", // auto-captures are operational knowledge
		ttl_days: 30, // medium TTL
		confidence: "inferred", // auto-capture: pattern detected, not user-stated
		// v1.7: auto-captures are episodic (concrete event: tool failed N
		// times in a 7-day window). The fact that this happened is a
		// specific observation, not yet an abstraction. Synthesis (R2 v3)
		// can later promote episodic memories into a semantic principle.
		memory_kind: "episodic",
		// v2.0: auto-captured patterns get lowest trust (llm_extracted)
		trust_level: signal.trust_level ?? 0,
		metadata: {
			...signal.suggestedMetadata,
			...(temporal.changed ? { temporalNormalized: true } : {}),
		},
	});

	// Mark the contributing tool_usage rows as captured so the auto-capture signal
	// stops firing for this (tool, args_hash) pattern. Without this, /dream-purge
	// creates a loop: delete the memory → next tool call re-detects 5+ tool_usage
	// hits → re-creates the same memory. With captured_at set, getToolUsageInWindow
	// excludes these rows and the next detection sees zero uncaptured hits.
	//
	// Use toolUsageStore (not the memory's destination store) so we always
	// mark the global tool_usage rows — they're the only ones that exist,
	// regardless of where the auto-capture memory was created.
	const CAPTURE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // match signals.ts default lookback
	toolUsageStore.markToolUsageCaptured({
		tool: signal.tool,
		argsHash: signal.argsHash,
		since: Date.now() - CAPTURE_LOOKBACK_MS,
	});

	return { created: true, updated: false, memoryId: memory.id };
}

// ── Gap #2: reason field auto-generation ──────────────────────────────
//
// Builds a concise reason string from the auto-capture's metadata. The
// reason appears in recall XML as `reason="..."` so the agent can tell
// WHY this memory exists without inspecting raw metadata. Derived from
// the same data the suggestedContent uses, so no extra signal.

interface AutoCaptureReasonInput {
	tool: string;
	frequency: number;
	failureRate?: number; // only present for failure patterns
	firstSeen: number;
	lastSeen: number;
	type: "failure" | "success";
}

function buildAutoCaptureReason(input: AutoCaptureReasonInput): string {
	const firstDate = new Date(input.firstSeen).toISOString().split("T")[0];
	const lastDate = new Date(input.lastSeen).toISOString().split("T")[0];
	const dateRange = firstDate === lastDate ? firstDate : `${firstDate} → ${lastDate}`;
	const span = Math.max(1, Math.round((input.lastSeen - input.firstSeen) / (24 * 60 * 60 * 1000)));
	if (input.type === "failure") {
		const ratePct = Math.round((input.failureRate ?? 0) * 100);
		return `Tool \`${input.tool}\` failed ${input.frequency}x (${ratePct}% failure rate) in ${span}-day window. Observed ${dateRange}.`;
	}
	return `Tool \`${input.tool}\` used ${input.frequency}x with similar args — likely recurring workflow. Observed ${dateRange}.`;
}
