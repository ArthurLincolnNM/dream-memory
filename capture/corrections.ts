/**
 * dream-memory/capture/corrections.ts
 *
 * Automatic correction detection: when the user corrects the agent
 * ("no, use pnpm not npm", "actually fix X first"), auto-save as a
 * user:correction memory so the agent remembers across sessions.
 *
 * Pure function — no DB access, no side effects. The caller (index.ts
 * before_agent_start handler) decides whether to persist.
 */

export interface CorrectionConfig {
	enabled: boolean;
	strongPatterns: RegExp[];
	weakPatterns: RegExp[];
	negativePatterns: RegExp[];
	minContentLength: number;
}

export const DEFAULT_CORRECTION_CONFIG: CorrectionConfig = {
	enabled: true,
	// Strong: correction intent is unambiguous
	strongPatterns: [
		/(?:não|no|nao|don't|dont|stop)\b.*?\b(?:use|usa|use o|use the)\b/i,
		/(?:actually|na verdade|pelo contrário)\b/i,
		/(?:I said|eu disse|falei que|eu falei)\b/i,
		/(?:wrong|errado|incorreto)\b.*?\b(?:use|should be|deveria ser)\b/i,
		/(?:fix|arruma|corrige)\b.*?\b(?:first|antes|primeiro)\b/i,
		/(?:not that|não é isso|não era)\b.*?\b(?:this|isso|isto)\b/i,
	],
	// Weak: may be correction, needs imperative verb to confirm
	weakPatterns: [
		/(?:actually|na verdade)\b/i,
		/(?:wait|espera|pera)\b/i,
		/(?:instead|ao invés|em vez disso)\b/i,
		/(?:prefer|prefiro|prefira)\b/i,
	],
	// Negative: explicitly NOT corrections
	negativePatterns: [
		/(?:no worries|sem worries|tudo bem|no problem|tranquilo)/i,
		/(?:looks? great|ficou (?:bom|ótimo|perfeito|show))/i,
		/(?:perfect|perfeito|show|beleza)/i,
		/(?:thanks|obrigad[ao]|valeu|vlw)\b/i,
	],
	minContentLength: 10,
};

export interface CorrectionDetection {
	isCorrection: boolean;
	strength: "strong" | "weak";
	matchedPattern: string;
	suggestedContent: string;
}

/**
 * Detect if a user message is a correction.
 *
 * Returns null if not a correction. Returns a CorrectionDetection with
 * strength="strong" (auto-save) or "weak" (save with context) if matched.
 *
 * Negative patterns are checked first — "no worries, looks great" should
 * never trigger correction detection even though "no" matches a strong pattern.
 */
export function detectCorrectionPattern(
	userMessage: string,
	config: CorrectionConfig = DEFAULT_CORRECTION_CONFIG,
): CorrectionDetection | null {
	if (!config.enabled) return null;
	if (userMessage.length < config.minContentLength) return null;

	// Negative check first — bail if the message is clearly positive
	for (const pat of config.negativePatterns) {
		if (pat.test(userMessage)) return null;
	}

	// Strong patterns — unambiguous correction
	for (const pat of config.strongPatterns) {
		const match = userMessage.match(pat);
		if (match) {
			return {
				isCorrection: true,
				strength: "strong",
				matchedPattern: pat.source.slice(0, 60),
				suggestedContent: userMessage.trim(),
			};
		}
	}

	// Weak patterns — only trigger with imperative verb co-occurrence
	const hasImperative = /\b(?:use|usa|do|faz|try|tenta|change|muda|switch|troca|go with|vai com|pick|escolhe|choose)\b/i.test(userMessage);
	if (hasImperative) {
		for (const pat of config.weakPatterns) {
			const match = userMessage.match(pat);
			if (match) {
				return {
					isCorrection: true,
					strength: "weak",
					matchedPattern: pat.source.slice(0, 60),
					suggestedContent: userMessage.trim(),
				};
			}
		}
	}

	return null;
}
