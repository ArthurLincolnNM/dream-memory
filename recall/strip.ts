/**
 * dream-memory/recall/strip.ts
 * Strip recalled memories from context before next turn
 */

/**
 * Remove dream_memories blocks from message content
 * Used to strip ephemeral recall before next turn
 * (kept internal — not exported, not used externally)
 */
// Note: original exported function removed. stripRecallFromContent is used directly by index.ts.

/**
 * Remove dream_memories XML blocks from content
 *
 * Handles malformed XML defensively: if opening tag exists without closing tag,
 * strip from opening tag to end of content (better than leaking recall into context).
 */
export function stripRecallFromContent(content: string): string {
	// Remove well-formed XML blocks (non-greedy, handles multiple)
	let cleaned = content.replace(/<dream_memories>[\s\S]*?<\/dream_memories>/g, "");

	// Handle malformed: opening tag without closing tag → strip from opening to end
	// This prevents leaking partial recall into context if XML got truncated
	cleaned = cleaned.replace(/<dream_memories>[\s\S]*$/g, "");

	// Remove markdown format
	cleaned = cleaned.replace(/## Recalled Memories\n[\s\S]*?(?=\n##|\n$|$)/g, "");

	// Remove plain format. Use non-greedy `*?` and a clear stopping pattern
	// (blank line or end of string) so two consecutive "Memories:" blocks
	// don't merge into one giant match. The previous `*` (greedy) would
	// over-consume across block boundaries.
	cleaned = cleaned.replace(/^Memories:\n(?:- .+\n?)+(?=\n|$)/gm, "");

	// Clean up extra whitespace
	cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

	return cleaned;
}

/**
 * Check if content contains recall blocks
 */
export function hasRecallContent(content: string): boolean {
	return /<dream_memories>/.test(content) || /## Recalled Memories/.test(content) || /^Memories:\n- /m.test(content);
}

/**
 * Identify whether a `dream-recall` custom message is the one we just
 * injected this turn (vs. an old recall from a previous turn that should
 * be stripped).
 *
 * Background: Pi's `context` event fires AFTER `before_agent_start` (where
 * we inject the recall) but BEFORE the LLM call. Stripping unconditionally
 * removed the recall before the model ever saw it — silently breaking the
 * entire auto-recall feature. The fix is to compare the message's content
 * against the last recall we injected. If it matches, leave it alone for
 * this turn; on the NEXT turn, `lastRecallContent` will point to newer
 * recall, and the previous turn's message will be stripped.
 *
 * Note: we don't use a turn id / generation counter because the recall
 * content is uniquely generated per turn (timestamps, scores, order of
 * results). A content match is sufficient and avoids threading state
 * through Pi's message cloning.
 *
 * @param msg  A message from `event.messages` (role=custom, customType="dream-recall")
 * @param lastContent  The content string of the recall we most recently injected
 * @returns true if `msg` is the current turn's recall (should NOT be stripped)
 */
export function isCurrentTurnRecall(msg: any, lastContent: string | null): boolean {
	if (!lastContent) return false;
	if (typeof msg.content === "string") {
		return msg.content === lastContent;
	}
	if (Array.isArray(msg.content)) {
		return msg.content.some(
			(b: any) => b && typeof b === "object" && typeof b.text === "string" && b.text === lastContent,
		);
	}
	return false;
}
