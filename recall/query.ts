/**
 * dream-memory/recall/query.ts
 * Query derivation from user input
 */

import { expandQueryTokens } from "./expand.js";

/**
 * Derive a recall query from user input
 * Strips noise, extracts key terms, expands via synonym dictionary
 *
 * Preserves Unicode letters/digits (Portuguese, accented chars, etc.).
 * The previous `/[^\w\s]/g` regex was ASCII-only and corrupted recall
 * for non-English input (e.g. "não use" → "n o use").
 *
 * Expansion step: after cleanup, tokenize and run each token through
 * the synonym dictionary (recall/expand.ts). The expanded string is what
 * reaches the FTS5 BM25 search. Expansion is opt-out via
 * `options.expand = false` for callers that want a literal query (e.g.,
 * the /dream-list-style commands that need exact matches).
 */
export function deriveRecallQuery(userInput: string, options?: { maxChars?: number; expand?: boolean }): string {
	const maxChars = options?.maxChars || 800;
	const expand = options?.expand !== false; // default true

	// Skip recall for certain inputs (also acts as type guard)
	if (typeof userInput !== "string" || shouldSkipRecall(userInput)) {
		return "";
	}

	// Clean input
	let query = userInput
		// Remove markdown
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`]+`/g, "")
		// Remove URLs
		.replace(/https?:\/\/\S+/g, "")
		// Remove special chars but PRESERVE Unicode letters/digits (\p{L} = letter,
		// \p{N} = digit). \w would be ASCII-only and break pt-BR recall.
		.replace(/[^\p{L}\p{N}_\s]/gu, " ")
		// Collapse whitespace
		.replace(/\s+/g, " ")
		.trim();

	if (!query) return "";

	// Expansion: turn "bug" into "bug erro error fail failure" etc. The
	// expanded string is what the FTS5 BM25 sees. The semantic embedder
	// (when installed) handles the rest of the paraphrase space.
	if (expand) {
		const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
		if (tokens.length > 0) {
			const expanded = expandQueryTokens(tokens);
			// Re-join with single spaces. We don't re-truncate here because
			// expandQueryTokens already caps output at MAX_EXPANDED_TOKENS.
			query = expanded.join(" ");
		}
	}

	// Truncate if too long (post-expansion). The cap is a safety net for
	// pathological inputs that somehow bypass the expansion cap.
	if (query.length > maxChars) {
		query = query.slice(0, maxChars);
	}

	return query;
}

/**
 * Check if recall should be skipped for this input
 */
function shouldSkipRecall(input: string): boolean {
	const normalized = input.toLowerCase().trim();

	// Skip for continue prompts
	const continuePatterns = ["continue", "go on", "next", "keep going", "prossiga", "continua"];
	if (continuePatterns.includes(normalized)) {
		return true;
	}

	// Skip for very short inputs
	if (normalized.length < 3) {
		return true;
	}

	// Skip for slash commands without args
	if (normalized.startsWith("/") && !normalized.includes(" ")) {
		return true;
	}

	return false;
}

/**
 * Check if input is about memory system itself (meta-memory)
 * Only matches questions explicitly asking about what the agent knows/remembers,
 * not legitimate queries that happen to use these words.
 */
export function isMetaMemoryQuery(input: string): boolean {
	const normalized = input.toLowerCase().trim();

	// Explicit meta-memory patterns
	const metaPatterns = [
		/what (do you )?know about/i,
		/what (do you )?remember/i,
		/do you have any memory/i,
		/what'?s in your memory/i,
		/show (me )?your memory/i,
		/list (your )?memory/i,
		/o que (você )?sabe/i,
		/o que (você )?lembra/i,
		/você (tem )?memória/i,
		/mostra (sua )?memória/i,
		// Spanish coverage: the user works in pt-BR but occasionally writes
		// in Spanish. The previous code only matched EN+PT, so a query like
		// "qué recuerdas" or "mostrar tu memoria" would slip through and
		// trigger the recall-feedback loop (query → recall → query again).
		/qu[ée]\s+sabes/i,
		/qu[ée]\s+recuerdas?/i,
		/mostrar?\s+(tu|la)\s+memoria/i,
		/tienes?\s+memoria/i,
	];

	return metaPatterns.some((p) => p.test(normalized));
}
