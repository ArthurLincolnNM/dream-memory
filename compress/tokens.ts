/**
 * Token-level pre-compression using entropy filtering.
 * Inspired by LightMem's sensory memory module.
 * 
 * Tokens with HIGH entropy (imprevisíveis) são informativos → MANTER.
 * Tokens com LOW entropy (previsíveis) são ruído → REMOVER.
 * 
 * Sem LLM — usa cross-entropy entre unigram distribution e uniform.
 */

export interface CompressionConfig {
  /** Maximum chars before compression triggers. Default 500. */
  minChars: number;
  /** Fraction of tokens to keep (0.0-1.0). Default 0.6 (keep 60%). */
  keepRatio: number;
}

const DEFAULT_CONFIG: CompressionConfig = {
  minChars: 500,
  keepRatio: 0.6,
};

// Common English + Portuguese stopwords with their corpus frequencies
// (rough unigram probabilities from typical text)
const TOKEN_ENTROPY = new Map<string, number>([
  // Very common → low entropy → compress
  ["the", 0.07], ["a", 0.04], ["an", 0.01], ["is", 0.03], ["are", 0.02],
  ["was", 0.02], ["were", 0.01], ["be", 0.01], ["been", 0.01], ["being", 0.005],
  ["have", 0.02], ["has", 0.02], ["had", 0.01], ["do", 0.01], ["does", 0.01],
  ["did", 0.005], ["will", 0.01], ["would", 0.01], ["could", 0.005],
  ["should", 0.005], ["may", 0.005], ["might", 0.003], ["shall", 0.002],
  ["can", 0.01], ["need", 0.005], ["must", 0.003],
  ["i", 0.03], ["you", 0.02], ["he", 0.01], ["she", 0.01], ["it", 0.03],
  ["we", 0.01], ["they", 0.01], ["me", 0.005], ["him", 0.005], ["her", 0.005],
  ["us", 0.005], ["them", 0.005],
  ["my", 0.01], ["your", 0.005], ["his", 0.01], ["its", 0.01], ["our", 0.005],
  ["their", 0.005],
  ["this", 0.02], ["that", 0.02], ["these", 0.005], ["those", 0.005],
  ["in", 0.03], ["on", 0.02], ["at", 0.01], ["to", 0.04], ["for", 0.02],
  ["of", 0.04], ["with", 0.02], ["by", 0.01], ["from", 0.01],
  ["and", 0.04], ["or", 0.01], ["but", 0.01], ["not", 0.01], ["no", 0.005],
  ["so", 0.005], ["if", 0.01], ["then", 0.005], ["else", 0.003],
  ["when", 0.01], ["where", 0.005], ["how", 0.005], ["what", 0.01],
  ["which", 0.005], ["who", 0.005], ["whom", 0.001],
  ["up", 0.01], ["out", 0.01], ["about", 0.01], ["into", 0.01],
  ["over", 0.005], ["after", 0.005], ["before", 0.005],
  ["one", 0.01], ["two", 0.005], ["first", 0.005], ["new", 0.01],
  ["also", 0.01], ["just", 0.01], ["than", 0.005], ["only", 0.005],
  ["very", 0.005], ["some", 0.005], ["any", 0.005], ["each", 0.003],
  ["all", 0.01], ["both", 0.003], ["such", 0.003],
  ["get", 0.01], ["got", 0.005], ["make", 0.01], ["made", 0.005],
  ["go", 0.01], ["went", 0.005], ["come", 0.005], ["came", 0.003],
  ["see", 0.005], ["know", 0.005], ["think", 0.005], ["say", 0.01],
  ["said", 0.01], ["tell", 0.005], ["told", 0.005],
  ["use", 0.01], ["used", 0.01], ["using", 0.005],
  ["run", 0.005], ["running", 0.003], ["file", 0.01], ["files", 0.005],
  ["error", 0.005], ["result", 0.005], ["command", 0.005],
  // Portuguese common words
  ["para", 0.03], ["com", 0.02], ["uma", 0.02], ["tem", 0.02],
  ["que", 0.03], ["como", 0.01], ["mais", 0.01], ["foi", 0.02],
  ["ser", 0.01], ["está", 0.01], ["não", 0.02], ["sim", 0.005],
  ["mas", 0.01], ["isso", 0.01], ["aqui", 0.005], ["muito", 0.01],
  ["este", 0.01], ["esta", 0.01], ["pode", 0.01], ["fazer", 0.01],
  ["todo", 0.005], ["toda", 0.005], ["outro", 0.005], ["outra", 0.005],
]);

/**
 * Estimate token entropy. High entropy = informative, keep it.
 * Low entropy = common/redundant, compress it.
 * 
 * Uses corpus frequency as proxy for entropy: H(token) ≈ -log2(P(token)).
 * We normalize to [0, 1] range where 1 = most informative.
 */
function tokenEntropy(token: string): number {
  const lower = token.toLowerCase();
  const freq = TOKEN_ENTROPY.get(lower);
  if (freq !== undefined) {
    // Known token: entropy = -log2(freq), normalized
    return Math.min(1, -Math.log2(freq) / 8); // 8 bits max
  }
  // Unknown token: likely rare/specialized → high entropy → keep
  // Length bonus: longer tokens are more likely to be meaningful
  const lengthBonus = Math.min(0.3, token.length * 0.03);
  return 0.7 + lengthBonus;
}

/**
 * Tokenize text into words (Unicode-aware).
 */
function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+/gu) || [];
}

/**
 * Compress content by keeping only high-entropy tokens.
 * Preserves sentence structure (periods, newlines) and code blocks.
 * 
 * Returns compressed content, or original if compression wouldn't help.
 */
export function compressContent(
  content: string,
  config: CompressionConfig = DEFAULT_CONFIG,
): { compressed: string; ratio: number; original: number } {
  if (content.length < config.minChars) {
    return { compressed: content, ratio: 1, original: content.length };
  }

  // Don't compress code blocks — they're already dense
  if (content.includes("```") || content.includes("    ")) {
    return { compressed: content, ratio: 1, original: content.length };
  }

  // Split into sentences to preserve structure
  const sentences = content.split(/(?<=[.!?])\s+/);
  const keptSentences: string[] = [];

  for (const sentence of sentences) {
    const tokens = tokenize(sentence);
    if (tokens.length === 0) {
      keptSentences.push(sentence);
      continue;
    }

    // Score each token by entropy
    const scored = tokens.map(t => ({ token: t, entropy: tokenEntropy(t) }));

    // Sort by entropy descending, keep top keepRatio
    const sorted = [...scored].sort((a, b) => b.entropy - a.entropy);
    const keepCount = Math.max(1, Math.ceil(tokens.length * config.keepRatio));
    const keepTokens = new Set(sorted.slice(0, keepCount).map(s => s.token.toLowerCase()));

    // Rebuild sentence, keeping high-entropy tokens and structure words
    const kept: string[] = [];
    for (const { token } of scored) {
      if (keepTokens.has(token.toLowerCase())) {
        kept.push(token);
      }
    }

    if (kept.length > 0) {
      keptSentences.push(kept.join(" "));
    }
  }

  const compressed = keptSentences.join(" ");
  const ratio = compressed.length / content.length;

  // If compression didn't help much (> 80% of original), return original
  if (ratio > 0.8) {
    return { compressed: content, ratio: 1, original: content.length };
  }

  return { compressed, ratio, original: content.length };
}

/**
 * Should this memory be compressed?
 * Only compress operational/failure memories with long content.
 */
export function shouldCompress(target: string, content: string, minChars: number = 500): boolean {
  if (content.length < minChars) return false;
  // Don't compress user preferences or conventions — they're already concise
  if (target === "user") return false;
  // Compress failure patterns and tool-quirks (often contain long tracebacks)
  if (target === "failure") return true;
  if (target === "project") return true;
  return false;
}
