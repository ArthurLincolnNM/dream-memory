/**
 * dream-memory/capture/evaluate.ts
 * Formation Pipeline — evaluate stage (Inspired by Memorix)
 *
 * Scores memory quality 0-1 based on:
 * - Novelty: how different from existing memories (using bigram similarity)
 * - Specificity: ratio of concrete facts (numbers, names, paths) vs generic text
 * - Actionability: can this memory change agent behavior?
 *
 * Classification:
 * - core (≥0.6): high-value, worth preserving long-term
 * - contextual (0.35-0.6): useful but not critical
 * - ephemeral (<0.35): low-value, fast decay
 */

import { calculateStringSimilarity } from "../contradiction/detector.js";
import type { Memory } from "../store/sqlite.js";

export interface EvaluationResult {
  score: number;
  classification: "core" | "contextual" | "ephemeral";
  novelty: number;
  specificity: number;
  actionability: number;
}

/**
 * Evaluate a memory's quality before storage.
 *
 * @param content - The memory content to evaluate
 * @param category - The memory category
 * @param target - The memory target
 * @param existingMemories - Array of existing memories to compare against
 * @returns EvaluationResult with score and classification
 */
export function evaluateMemory(
  content: string,
  category: string | undefined,
  target: string | undefined,
  existingMemories: Memory[],
): EvaluationResult {
  const novelty = computeNovelty(content, existingMemories);
  const specificity = computeSpecificity(content);
  const actionability = computeActionability(category, target, content);

  // Weighted combination
  const score = Math.min(1.0,
    novelty * 0.4 +
    specificity * 0.3 +
    actionability * 0.3
  );

  let classification: "core" | "contextual" | "ephemeral";
  if (score >= 0.6) classification = "core";
  else if (score >= 0.35) classification = "contextual";
  else classification = "ephemeral";

  return { score, classification, novelty, specificity, actionability };
}

/**
 * Novelty: 1.0 = completely new, 0.0 = duplicate of existing.
 * Uses max similarity against all existing memories.
 */
function computeNovelty(content: string, existing: Memory[]): number {
  if (existing.length === 0) return 1.0;

  let maxSimilarity = 0;
  for (const mem of existing) {
    const sim = calculateStringSimilarity(content, mem.content);
    if (sim > maxSimilarity) maxSimilarity = sim;
  }

  return 1.0 - maxSimilarity;
}

/**
 * Specificity: ratio of concrete tokens (numbers, file paths, identifiers)
 * vs total tokens. More specific = more actionable.
 */
function computeSpecificity(content: string): number {
  const tokens = content.split(/\s+/);
  if (tokens.length === 0) return 0;

  let concreteCount = 0;
  for (const token of tokens) {
    // Numbers
    if (/\d/.test(token)) { concreteCount++; continue; }
    // File paths
    if (/[\/\\]/.test(token) && token.length > 3) { concreteCount++; continue; }
    // CamelCase identifiers (function names, class names)
    if (/[a-z][A-Z]/.test(token)) { concreteCount++; continue; }
    // URLs
    if (/^https?:\/\//.test(token)) { concreteCount++; continue; }
    // Technical terms (containing dots like version numbers)
    if (/\d+\.\d+/.test(token)) { concreteCount++; continue; }
  }

  return Math.min(1.0, concreteCount / Math.max(tokens.length, 1) * 2); // *2 to normalize
}

/**
 * Actionability: can this memory change agent behavior?
 * Higher for: corrections, failures, procedures, preferences.
 * Lower for: meta-memory, insights (unless specific).
 */
function computeActionability(
  category: string | undefined,
  target: string | undefined,
  content: string,
): number {
  let score = 0.5; // baseline

  // Category boost
  const actionCategories: Record<string, number> = {
    "correction": 0.9,
    "failure": 0.8,
    "preference": 0.8,
    "convention": 0.7,
    "procedure": 0.85,
    "tool-quirk": 0.6,
    "insight": 0.4,
  };
  if (category && actionCategories[category]) {
    score = actionCategories[category];
  }

  // Content signals
  const lower = content.toLowerCase();
  // Imperative language = actionable
  if (/\b(always|never|must|should|use|prefer|avoid|don't|do not)\b/i.test(content)) {
    score = Math.min(1.0, score + 0.15);
  }
  // Contains a fix/solution
  if (/\b(fixed|solution|workaround|fix|solve)\b/i.test(lower)) {
    score = Math.min(1.0, score + 0.1);
  }
  // Very short = less actionable (probably noise)
  if (content.length < 20) {
    score = Math.max(0.1, score - 0.4);
  }

  return Math.min(1.0, score);
}
