/**
 * dream-memory/contradiction/detector.ts
 * Contradiction detection via embedding similarity
 */

import type { Memory } from "../store/sqlite.js";
import { TRUST_PRIORITY } from "../utils/constants.js";

export interface ContradictionCandidate {
	existing: Memory;
	similarity: number;
	needsArbitration: boolean; // true if similarity is in ambiguous range OR trust levels conflict
	/** v2.0: true when the new memory has LOWER trust than the existing one. */
	newIsLowerTrust?: boolean;
}

export interface ContradictionConfig {
	similarityThreshold: number; // Above this = potential contradiction
	arbitrationThreshold: number; // Above this = auto-resolve (high confidence)
}

const DEFAULT_CONFIG: ContradictionConfig = {
	similarityThreshold: 0.85,
	arbitrationThreshold: 0.95,
};

/**
 * Detect potential contradictions between a new memory and existing memories
 *
 * Uses simple string similarity as a proxy for semantic similarity.
 * In production, this should use embedding vectors.
 */
export function detectContradictions(
	newContent: string,
	newMemoryTarget: Memory["target"],
	existingMemories: Memory[],
	config: ContradictionConfig = DEFAULT_CONFIG,
	newTrustLevel: number = 2,
): ContradictionCandidate[] {
	const candidates: ContradictionCandidate[] = [];

	for (const existing of existingMemories) {
		// Only compare same target type
		// (don't compare user preferences with project conventions)
		if (existing.target !== newMemoryTarget) continue;

		const similarity = calculateStringSimilarity(newContent, existing.content);

		if (similarity >= config.similarityThreshold) {
			// Negation polarity check: if the new memory has negation tokens
			// and the existing one doesn't (or vice versa), the two may have
			// OPPOSITE meaning despite high bigram similarity. Force arbitration
			// so the user is asked instead of auto-replacing — the cost of a
			// false positive (one extra user prompt) is much lower than the
			// cost of a false negative (silent data loss).
			//
			// Both negated or neither negated → let similarity score decide.
			const negationMismatch = hasNegationMismatch(newContent, existing.content);

			// v2.0: Trust-aware arbitration.
			// - new memory HIGHER trust → auto-replace (user said it > agent extracted it)
			// - new memory LOWER trust → keep existing, flag for user review
			// - equal trust → needs arbitration (same as before)
			const newTrust = newTrustLevel;
			const existingTrust = existing.trust_level ?? 2;
			const trustDiff = TRUST_PRIORITY[newTrust] - TRUST_PRIORITY[existingTrust];
			const newIsLowerTrust = trustDiff < 0;

			// needsArbitration when:
			//   1. similarity in ambiguous range (< arbitrationThreshold), OR
			//   2. negation mismatch, OR
			//   3. trust levels are equal (neither clearly wins)
			// Auto-resolve when similarity is high AND one trust clearly dominates.
			const needsArbitration =
				similarity < config.arbitrationThreshold ||
				negationMismatch ||
				Math.abs(trustDiff) < 10; // same trust level

			candidates.push({
				existing,
				similarity,
				needsArbitration,
				newIsLowerTrust,
			});
		}
	}

	// Sort by similarity (highest first)
	return candidates.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Calculate string similarity using bigram method
 * Returns value between 0 and 1 (Jaccard index of bigram sets)
 */
/**
 * Calculate string similarity using bigram method
 * Returns value between 0 and 1 (Jaccard index of bigram sets).
 *
 * Exported for reuse in recall/inject.ts dedup pass (R1 v3) — near-duplicate
 * memories with similarity > 0.7 are kept as a single top-scored result.
 * The export is intentional: dedup is read-time, not contradiction-time, so
 * keeping the same function in both places avoids subtle drift between
 * "is this a contradiction?" and "is this a near-duplicate?" thresholds.
 */
export function calculateStringSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;

	// Normalize
	const normA = a.toLowerCase().trim();
	const normB = b.toLowerCase().trim();

	if (normA === normB) return 1;

	// Bigram Jaccard: |A ∩ B| / |A ∪ B|. We use SETS (not multisets) so
	// repeated bigrams don't inflate the numerator. The previous code used
	// array.filter, which counted duplicates — e.g. "ee" appearing 3 times
	// in A and 1 time in B would add 3 to intersection but only 1 to union
	// (a Set), pushing similarity above 1.0 (mathematically impossible for
	// Jaccard). With sets, similarity stays in [0, 1].
	const setA = new Set(getBigrams(normA));
	const setB = new Set(getBigrams(normB));

	let intersection = 0;
	for (const bg of setA) {
		if (setB.has(bg)) intersection++;
	}
	const union = new Set([...setA, ...setB]).size;

	return union === 0 ? 0 : intersection / union;
}

function getBigrams(str: string): string[] {
	const bigrams: string[] = [];
	for (let i = 0; i < str.length - 1; i++) {
		bigrams.push(str.slice(i, i + 2));
	}
	return bigrams;
}

/**
 * Check if two memories are about the same "field"
 * (e.g., both mention "editor", both mention "language")
 */
export function detectSameField(a: string, b: string): boolean {
	const fields = ["editor", "ide", "language", "framework", "os", "terminal", "shell", "theme", "font"];

	const normA = a.toLowerCase();
	const normB = b.toLowerCase();

	for (const field of fields) {
		if (normA.includes(field) && normB.includes(field)) {
			return true;
		}
	}

	return false;
}

// ── Negation Detection ──────────────────────────────────────────────
//
// Problem: bigram similarity is high for "use Vim" vs "don't use Vim"
// (~0.7-0.9) even though they're semantically opposite. Without negation
// detection, the detector flags them as contradictions with HIGH confidence
// (>0.85 threshold) and the resolver auto-replaces — silently overwriting
// the user's preference.
//
// Solution: extract negation tokens from each memory. If one has negation
// and the other doesn't, force needsArbitration=true so the user is asked
// instead of auto-replace. False positive cost: we ask once when we could
// have auto-replaced. False negative cost: silent data loss. The asymmetry
// makes "ask more often" the right default.

/**
 * Negation words in Portuguese. Lowercase, diacritic-stripped for matching
 * (pt-BR users may type "não" or "nao"). Includes:
 *   - Direct negators: não, nunca, jamais, nem
 *   - Negative pronouns: nenhum, nenhuma, nada, ninguém
 */
const NEGATION_WORDS_PT_BR = new Set([
	"nao", "nunca", "jamais", "nem",
	"nenhum", "nenhuma", "nada", "ninguem",
]);

/**
 * Negation words in English. Lowercase. Includes:
 *   - Direct negators: not, no, never, neither, nor, without
 *   - Indefinite negatives: nothing, none
 *   - Contractions: n't, dont, doesnt, didnt, isnt, arent, wasnt, werent,
 *     wont, wouldnt, shouldnt, couldnt, cant, cannot
 *
 * Contractions are checked as standalone tokens (not substrings) to avoid
 * false positives like "notify" matching "not".
 */
const NEGATION_WORDS_EN = new Set([
	"not", "no", "never", "neither", "nor", "without",
	"nothing", "none",
	"n't", "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent",
	"wont", "wouldnt", "shouldnt", "couldnt", "cant", "cannot",
]);

/**
 * Tokenize text into lowercase word tokens. Uses Unicode-aware regex
 * (matches `[\p{L}\p{N}_]+`) so diacritics in pt-BR text are preserved
 * inside each token. Apostrophes split words — "don't" becomes ["don", "t"]
 * but we also check the original lowercased text for "n't" as a unit.
 */
function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
}

/**
 * Normalize a token for negation matching: strip diacritics via NFD
 * decomposition + combining mark removal. So "não" → "nao", "é" → "e".
 * This lets a single set entry ("nao") match both the diacritic and the
 * ASCII spellings users actually type. Without this, "não uso Zed"
 * wouldn't match the set entry "nao" and the negation detection would
 * miss pt-BR content.
 */
function normalizeForMatch(token: string): string {
	return token.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Count negation tokens in text. Returns the number of distinct negation
 * words found. A memory with 2+ negation words is "negated"; 0 means
 * "positive/affirmative". Edge case: 1 negation in a long sentence is
 * treated as negated (the heuristic is conservative).
 *
 * Affirmative-with-negation patterns like "not only", "not just",
 * "nao apenas" are filtered out before counting — they START with a
 * negation token but the statement is positive (the negation scopes
 * the quantifier, not the predicate). Without this filter, "I not
 * only use Vim" would be marked as negated and compared against "I use
 * Vim" would force a needless user arbitration.
 */
function countNegations(text: string): number {
	const stripped = stripAffirmativeWithNegation(text);
	const tokens = new Set(tokenize(stripped).map(normalizeForMatch));
	let count = 0;
	for (const word of tokens) {
		if (NEGATION_WORDS_PT_BR.has(word) || NEGATION_WORDS_EN.has(word)) {
			count++;
		}
	}
	// Also check for "n't" specifically since tokenize splits on apostrophe.
	// The token for "don't" is "don" and "t" — neither matches. We check the
	// raw lowercased text for "n't" as a substring. This is safe because
	// "n't" is highly specific to English negation contractions.
	if (stripped.toLowerCase().includes("n't")) {
		count++;
	}
	return count;
}

/**
 * Affirmative-with-negation patterns. These all have the shape
 * "[negation] [quantifier] [predicate]" where the negation scopes the
 * quantifier, NOT the predicate. The full statement is positive.
 *
 * Examples (each would be detected as negated by a naive word-list
 * approach because the negation token is present):
 *   - "I not only use Vim"       (EN) — actually means "I use Vim + more"
 *   - "I don't just use Vim"     (EN) — actually means "I use Vim + more"
 *   - "Nao apenas uso Zed"       (PT-BR) — actually means "uso Zed + mais"
 *
 * Strategy: replace the matched pattern with a single space so the
 * surrounding tokens (especially the negation) are gone from the
 * counting pass. The predicate ("use Vim", "uso Zed") survives intact
 * for bigram similarity. If a memory has ONLY an affirmative-with-
 * negation pattern and no other negation, countNegations now returns 0.
 */
const AFFIRMATIVE_WITH_NEGATION_PATTERNS: ReadonlyArray<RegExp> = [
	// EN: "not only", "not just", "not merely", "not simply"
	/\bnot\s+(?:only|just|merely|simply)\b/gi,
	// EN: "don't just", "doesn't only", etc. — negation + affirmative quantifier
	/\b(?:don't|doesn't|didn't|won't|wouldn't|shouldn't|can't|cannot)\s+(?:only|just|merely|simply)\b/gi,
	// PT-BR: "nao apenas", "nao so", "nao somente", "nao meramente", "nao simplesmente"
	// Diacritics stripped on purpose: users may type either "nao" or "não",
	// and "apenas" or "apenas" — but "apenas" has no diacritics, "so" has none.
	// We match on the lowercased ASCII form for consistency with the rest of
	// the negation detection.
	/\bnao\s+(?:apenas|so|somente|meramente|simplesmente)\b/gi,
];

/**
 * Strip affirmative-with-negation patterns from text. Returns text with
 * the matched spans replaced by a single space. Whitespace is normalized
 * at the end so the result tokenizes cleanly.
 */
function stripAffirmativeWithNegation(text: string): string {
	let result = text;
	for (const pattern of AFFIRMATIVE_WITH_NEGATION_PATTERNS) {
		result = result.replace(pattern, " ");
	}
	return result.replace(/\s+/g, " ").trim();
}

/**
 * Detect negation polarity mismatch between two memory contents.
 *
 * Returns true when one memory has negation tokens and the other doesn't.
 * This is the signal that auto-replace is unsafe — the two memories may
 * have OPPOSITE meaning despite high bigram similarity.
 *
 * Examples:
 *   hasNegationMismatch("use Vim", "don't use Vim")    → true
 *   hasNegationMismatch("uso Zed", "não uso Zed")      → true
 *   hasNegationMismatch("don't use Vim", "use Emacs")  → true
 *   hasNegationMismatch("don't use Vim", "don't use Emacs") → false
 *   hasNegationMismatch("use Vim", "use Emacs")         → false
 *
 * Note: this is a coarse heuristic. It catches the common case of explicit
 * negation but may miss subtle polarity (e.g., "I used to use X" implying
 * no longer use X). Embedding-based detection would catch more, but for
 * pt-BR/en personal use, the word-list approach has the best cost/benefit.
 */
export function hasNegationMismatch(contentA: string, contentB: string): boolean {
	const negA = countNegations(contentA);
	const negB = countNegations(contentB);
	// Mismatch = exactly one has negation tokens. If both have it, the
	// memories may still contradict but the polarity is similar (both
	// are negative statements) — let the bigram similarity score decide.
	// If neither has it, no negation concerns.
	return (negA > 0) !== (negB > 0);
}
