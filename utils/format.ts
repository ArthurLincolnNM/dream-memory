/**
 * dream-memory/utils/format.ts
 *
 * Formatting helpers shared between commands and tests.
 */

/**
 * Format a byte count for display in TUI notifications.
 *
 * Returns the smallest unit where the value is at least 1, e.g.:
 *   512       → "512B"
 *   2048      → "2.0KB"
 *   5_242_880 → "5.0MB"
 *
 * Defensive against non-finite or negative inputs (NaN, Infinity, -1).
 * The previous inline version in index.ts rendered "NaNMB" for NaN,
 * which surfaced in cleanup notifications when a stat() race made the
 * sum invalid. We return "0B" instead — the safest display for a
 * notification that was about to be shown regardless.
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0B";
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Truncate text to `maxChars` characters, appending "..." if cut.
 * Used by /dream-list and the dream_memory_list tool to keep memory
 * previews at a consistent, TUI-friendly length.
 *
 * The cap was tuned by hand:
 *   - 60 chars: too short — truncated "Tool `read` used 3 times..." to
 *     nothing useful, defeating the point of the preview.
 *   - 200 chars: too long — wrapped in 2-3 lines in the TUI and pushed
 *     other entries off-screen.
 *   - 115 chars: roughly one full sentence in pt-BR/en plus a bit of
 *     context. Fits on a single TUI line for the common case.
 *
 * Returns the input unchanged if it already fits.
 */
export function truncateForPreview(text: string, maxChars: number = 115): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars - 3) + "...";
}

/**
 * Format a timestamp as a relative age string (e.g. "3d ago", "2h ago").
 * Used by dream_memory_list, /dream-list, and search output to show
 * recency alongside absolute dates.
 *
 * Handles future timestamps gracefully (returns "just now").
 */
export function formatRelativeAge(timestampMs: number, nowMs: number = Date.now()): string {
	const diffMs = nowMs - timestampMs;
	if (diffMs < 0) return "just now";

	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;

	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;

	const years = Math.floor(days / 365);
	return `${years}y ago`;
}
