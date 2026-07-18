/**
 * dream-memory/ttl/decay.ts
 * Memory decay calculation
 *
 * Memories lose priority over time if not accessed.
 * Frequently accessed memories get a boost.
 */

import type { Memory } from "../store/sqlite.js";
import { TRUST_DECAY_WEIGHTS } from "../utils/constants.js";

export interface DecayConfig {
	factor: number; // Daily decay factor (0.95 = 5% decay per day)
	boostFactor: number; // Boost per access (log scale)
	/** Categories that are immune to decay (always return MAX_DECAY) */
	immuneCategories?: string[];
	/** Memory kinds that are immune to decay */
	immuneKinds?: string[];
	/** Minimum access_count for immunity (default: 5) */
	immuneAccessCount?: number;
	/** Multipliers by memory_kind (episodic decays faster) */
	kindMultipliers?: Record<string, number>;
	/** Multipliers by source_type */
	sourceMultipliers?: Record<string, number>;
}

const DEFAULT_DECAY_CONFIG: DecayConfig = {
	factor: 0.95,
	boostFactor: 0.1,
};

/**
 * Calculate decay score for a memory
 * Returns value in [0, MAX_DECAY]. MAX_DECAY < 1 so even freshly-accessed
 * memories retain a small "stale headroom" — this breaks the recall
 * feedback loop where `trackAccess` → higher decay → more recall → more
 * trackAccess, which would otherwise make heavily-accessed memories
 * permanently pinned at score 1.0.
 */
const MAX_DECAY = 0.95;
/** Maximum contribution of the access boost, regardless of access_count. */
const MAX_ACCESS_BOOST = 0.3;

export function calculateDecay(memory: Memory, config: DecayConfig = DEFAULT_DECAY_CONFIG): number {
	// Immunity check: certain memories never decay
	const immuneAccessCount = config.immuneAccessCount ?? 5;
	const isImmune =
		(config.immuneCategories?.includes(memory.category ?? "") ?? false) ||
		(config.immuneKinds?.includes(memory.memory_kind ?? "") ?? false) ||
		(memory.access_count >= immuneAccessCount) ||
		(memory.trust_level === 3 && memory.ttl_days === null); // user_stated + permanent

	if (isImmune) return MAX_DECAY;

	const now = Date.now();
	const lastAccess = memory.last_accessed_at || memory.created_at;
	const daysSinceAccess = (now - lastAccess) / (1000 * 60 * 60 * 24);

	// Ebbinghaus-inspired exponential decay with stability
	// Higher stability = slower decay. Default stability = 14 (baseline).
	const stability = (memory as any).stability ?? 14;
	// Lambda (decay rate) inversely proportional to stability
	// stability=14 → lambda ≈ 0.068 (half-life ~10 days)
	// stability=21 (after 1 reinforcement) → lambda ≈ 0.045 (half-life ~15 days)
	// stability=42 (after 2 reinforcements) → lambda ≈ 0.023 (half-life ~30 days)
	const lambda = 1.0 / stability;
	const decayFactor = Math.exp(-lambda * daysSinceAccess);

	// Boost for frequently accessed memories (logarithmic + capped)
	const accessBoost = Math.min(
		MAX_ACCESS_BOOST,
		Math.log(memory.access_count + 1) * config.boostFactor,
	);

	const baseDecay = Math.min(MAX_DECAY, decayFactor + accessBoost);

	// F3: utility_score multiplier
	const utility = memory.utility_score ?? 0;
	const utilityMultiplier = 1 + utility * 0.25;

	// v2.0: Trust Hierarchy multiplier
	const trustLevel = memory.trust_level ?? 2;
	const trustMultiplier = TRUST_DECAY_WEIGHTS[trustLevel] ?? 1.0;

	// Memory kind multiplier (episodic decays faster by default)
	const kindMultipliers = config.kindMultipliers ?? { semantic: 1.0, episodic: 0.8 };
	const kindMultiplier = kindMultipliers[memory.memory_kind ?? "semantic"] ?? 1.0;

	// Source type multiplier (from metadata)
	const sourceType = memory.metadata?.sourceType as string | undefined;
	const sourceMultipliers = config.sourceMultipliers ?? {};
	const sourceMultiplier = sourceType ? (sourceMultipliers[sourceType] ?? 1.0) : 1.0;

	return Math.min(MAX_DECAY, baseDecay * Math.max(0.5, Math.min(1.25, utilityMultiplier)) * trustMultiplier * kindMultiplier * sourceMultiplier);
}

/**
 * Apply decay to search results. Returns a NEW array of new result objects
 * with adjusted scores; the input array is not mutated.
 *
 * Decay reduces score for old, rarely-accessed memories while boosting
 * frequently-accessed ones. This prevents stale memories from dominating
 * recall simply because they had high BM25 scores in the past.
 *
 * Reference: Continuum Memory (2601.09913) shows d=1.84 effect size
 * on knowledge updates with selective retention.
 */
export function applyDecayToResults<T extends { memory: Memory; score: number }>(results: T[], config: DecayConfig = DEFAULT_DECAY_CONFIG): T[] {
	const decayed = results.map((result) => {
		const decay = calculateDecay(result.memory, config);
		return { ...result, score: result.score * decay };
	});
	return decayed.sort((a, b) => b.score - a.score);
}

/**
 * Get decay description for debugging
 *
 * NOTE: unused. Kept commented for reference; see `applyDecayToResults`.
 */
// export function describeDecay(memory: Memory, config: DecayConfig = DEFAULT_DECAY_CONFIG): string {
// 	const decay = calculateDecay(memory, config);
// 	const lastAccess = memory.last_accessed_at || memory.created_at;
// 	const daysSince = Math.floor((Date.now() - lastAccess) / (1000 * 60 * 60 * 24));
// 	return `decay=${decay.toFixed(3)}, days_since_access=${daysSince}, access_count=${memory.access_count}`;
// }
