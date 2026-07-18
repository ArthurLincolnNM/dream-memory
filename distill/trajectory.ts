/**
 * dream-memory/distill/trajectory.ts
 * Tool usage tracking for pattern detection
 */

import type { DreamStore, ToolUsage } from "../store/sqlite.js";

export interface ToolCallRecord {
	tool: string;
	args: Record<string, any>;
	success: boolean | null;
	sessionId?: string;
	/** Optional error preview (first 200 chars). Forwarded to tool_usage.error_preview. */
	errorPreview?: string;
}

/**
 * Track a tool call in the store
 */
export function trackToolCall(store: DreamStore, record: ToolCallRecord): void {
	store.trackToolUsage({
		tool: record.tool,
		args: record.args,
		session_id: record.sessionId,
		// Normalize null/undefined to true (unknown → assumed success for stats).
		// The DreamStore stores success=0 only when explicitly false.
		success: record.success === false ? false : true,
		error_preview: record.errorPreview,
	});
}

/**
 * Get tool usage patterns with frequency >= threshold
 */
export function getUsagePatterns(store: DreamStore, minFrequency: number = 5): Array<{
	tool: string;
	argsHash: string;
	argsPreview: string;
	frequency: number;
	confidence: number;
}> {
	const patterns = store.getToolUsagePatterns(minFrequency);

	return patterns.map((p) => ({
		tool: p.tool,
		argsHash: p.args_hash,
		argsPreview: p.args_preview,
		frequency: p.count,
		confidence: Math.min(1, p.count / 10), // Normalize to 0-1
	}));
}

/**
 * Analyze patterns and identify candidates for skill generation
 */
export function analyzePatterns(patterns: ReturnType<typeof getUsagePatterns>, minConfidence: number = 0.7): Array<{
	tool: string;
	argsHash: string;
	argsPreview: string;
	frequency: number;
	confidence: number;
	shouldDistill: boolean;
}> {
	return patterns.map((p) => ({
		...p,
		shouldDistill: p.confidence >= minConfidence,
	}));
}
