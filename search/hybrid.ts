/**
 * dream-memory/search/hybrid.ts
 * Search using FTS5 + BM25 with relative score floor (MiMo-Code approach)
 *
 * Hybrid pipeline:
 *   1. BM25 lexical search (FTS5)
 *   2. Semantic re-rank (optional, gated by query vector availability)
 *   3. Temporal decay multiplier
 *   4. Link expansion
 *
 * The semantic re-rank is opt-in: when `semanticQuery` is a non-null
 * Float32Array AND a candidate memory has a stored embedding, the BM25
 * score is blended with cosine similarity via Reciprocal Rank Fusion.
 * Memories without embeddings (legacy rows, before the feature shipped)
 * fall back to BM25-only — no penalty, no error.
 */

import type { Memory, DreamStore } from "../store/sqlite.js";
import { normalizeLinkedTo } from "../store/sqlite.js";
import { calculateDecay } from "../ttl/decay.js";
import { bytesToVector, cosineSim, getCachedQueryEmbedding } from "../embeddings/embed.js";
import { createHash } from "node:crypto";

export interface SearchResult {
	memory: Memory;
	score: number;
	snippet: string;
	anchorToken?: string; // Rarest matching query token (Trellis-style anchor-rarity)
	/**
	 * True if this result was surfaced via link expansion (not a direct FTS5
	 * match). Linked results have their score dampened (0.5x) so they rank
	 * below direct matches. Used to flag for the agent that this memory is
	 * "related" rather than "matched".
	 */
	isLinked?: boolean;
	/**
	 * If this result was surfaced via link expansion, this is the ID of the
	 * parent memory that linked to it. Useful for the agent to understand
	 * "I found A, and A is linked to B, so I'm surfacing B".
	 */
	linkedFrom?: string;
	/**
	 * F1: The semantic relation type between the parent and this linked memory
	 * (e.g., "updates", "extends", "derives", "related_to").
	 */
	linkRelation?: string;
}

export interface SearchOptions {
	scope?: string;
	scopeId?: string;
	target?: string;
	category?: string;
	status?: string;
	tier?: string;
	/** Max results. Aliased to topK for backwards compat. */
	limit?: number;
	/** Alias for limit. Accepts both for ergonomics. */
	topK?: number;
	scoreFloorRatio?: number;
	/**
	 * Apply temporal decay to search results. When true (default), BM25 scores
	 * are multiplied by a decay factor based on recency and access count.
	 * Set to false to get pure BM25 ranking (e.g. for debugging or listing).
	 */
	applyDecay?: boolean;
	/**
	 * Pre-computed query embedding for semantic re-rank. When provided AND
	 * a candidate memory has a stored embedding, the BM25 score is blended
	 * with cosine similarity via RRF. Pass `null` to skip the semantic layer
	 * (callers that haven't computed/primed a query vector should do this).
	 * Default: null (semantic layer disabled). This keeps the call signature
	 * backward-compatible and lets callers opt in per-call.
	 */
	semanticQuery?: Float32Array | null;
	/**
	 * Weight of the semantic channel in the RRF blend, in [0, 1].
	 * 0 = pure BM25 (semantic is a tiebreaker only)
	 * 1 = pure semantic (BM25 is a tiebreaker only)
	 * Default: 0.5 (balanced). Tuned by hand against the eval set; higher
	 * values over-weight paraphrased matches at the expense of exact
	 * keyword hits, which the user usually wants.
	 */
	semanticWeight?: number;
	/**
	 * Summary mode: return compact results with only id, first 80 chars,
	 * target, category, and score. Saves ~10x tokens vs full content.
	 */	summaryMode?: boolean;
}

export interface StorePair {
	global: DreamStore;
	project: DreamStore | null;
	projectId: string | null;
}

// ── F17: Recall cache per turn ──
// Avoids redundant search within the same turn when the agent makes
// multiple tool calls with similar queries. TTL = 60s (typical turn duration).
// Key is a hash of query + filter params; value is the result array.
// Cleared on memory mutations (add/update/delete) via invalidateRecallCache().
const RECALL_CACHE_TTL_MS = 60_000;
const recallCache = new Map<string, { results: SearchResult[]; expiresAt: number }>();
const RECALL_CACHE_MAX_ENTRIES = 50;

function recallCacheKey(query: string, options: SearchOptions, stores: StorePair): string {
	const raw = JSON.stringify({
		q: query,
		scope: options.scope,
		target: options.target,
		cat: options.category,
		status: options.status,
		tier: options.tier,
		lim: options.limit ?? options.topK,
		pid: stores.projectId,
	});
	return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function recallCacheGet(key: string): SearchResult[] | null {
	const entry = recallCache.get(key);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		recallCache.delete(key);
		return null;
	}
	return entry.results;
}

function recallCacheSet(key: string, results: SearchResult[]): void {
	// Evict oldest if at capacity
	if (recallCache.size >= RECALL_CACHE_MAX_ENTRIES) {
		const oldest = recallCache.keys().next().value;
		if (oldest) recallCache.delete(oldest);
	}
	recallCache.set(key, { results, expiresAt: Date.now() + RECALL_CACHE_TTL_MS });
}

/** Clear the recall cache. Called on memory mutations. */
export function invalidateRecallCache(): void {
	recallCache.clear();
}

/**
 * Classify query complexity to determine retrieval depth.
 *
 * Inspired by SimpleMem's Intent-Aware Retrieval Planning:
 * "assign LOW if the query can be answered via direct fact lookup,
 * HIGH if it requires aggregation across multiple events".
 *
 * Simple queries get fewer results (faster, less noise).
 * Complex queries get more results (better recall).
 *
 * @returns { depth: number, complexity: "LOW" | "HIGH" }
 */
export function classifyQueryComplexity(query: string): { depth: number; complexity: "LOW" | "HIGH" } {
	const lower = query.toLowerCase();

	// Signals of HIGH complexity
	let complexityScore = 0;

	// Multi-entity: contains conjunctions or separators
	if (/\b(e\s|and\s|\be\b|\by\b|\bou\b|\bor\b|,\s)/i.test(query)) {
		complexityScore += 2;
	}

	// Temporal: references time
	if (/\b(when|when\s+did|when\s+was|when\s+were|quando|ontem|hoje|semana|month|year|last|past|ago|before|after|during|antes|depois|durante|entre)\b/i.test(lower)) {
		complexityScore += 2;
	}

	// Multi-hop: asks about relationships or comparisons
	if (/\b(compare|difference|between|relacion|conexão|link|pattern|trend|evolution|change|changed|before\s+and|antes\s+e|mudou|evoluiu)\b/i.test(lower)) {
		complexityScore += 3;
	}

	// Open-ended: asks for explanation or list
	if (/\b(why|how|explain|list|all|every|each|todos|cada|tudo|quais)\b/i.test(lower)) {
		complexityScore += 2;
	}

	// Query length: longer queries tend to be more complex
	const wordCount = query.split(/\s+/).length;
	if (wordCount > 8) complexityScore += 1;
	if (wordCount > 15) complexityScore += 1;

	// Single entity / short fact lookup → LOW
	if (complexityScore <= 1) {
		return { depth: 3, complexity: "LOW" };
	}

	// Multiple signals → HIGH
	return { depth: 15, complexity: "HIGH" };
}

/**
 * Search a single store using FTS5 + BM25 with optional semantic re-rank.
 */
export function hybridSearch(store: DreamStore, query: string, options: SearchOptions = {}): SearchResult[] {
	// Honor both `limit` and `topK` — previous code dropped `topK` silently.
	const limit = options.limit ?? options.topK ?? 10;
	let results = store.searchByQuery(query, {
		scope: options.scope as any,
		scope_id: options.scopeId,
		target: options.target as any,
		category: options.category as any,
		status: (options.status as any) ?? "active",
		tier: options.tier as any,
		limit,
		scoreFloorRatio: options.scoreFloorRatio,
	});

	// Semantic re-rank via Reciprocal Rank Fusion.
	// - If `semanticQuery` is null/undefined: skip the semantic layer entirely.
	//   Callers that haven't warmed the query cache (e.g., legacy callers)
	//   pay zero overhead.
	// - For each candidate with a stored embedding: compute cosine similarity
	//   to the query vector. Build a parallel rank list. Combine with BM25
	//   rank using RRF: score = (1-semW) * rrf(lexicalRank) + semW * rrf(semanticRank).
	// - Candidates WITHOUT embeddings keep their BM25-derived score as-is
	//   (they get the worst possible semantic rank = N+1, which contributes
	//   ~0 to the RRF blend). This is the right behavior: missing embedding
	//   is equivalent to "this memory never got a chance to compete in
	//   semantic search", not a penalty.
	//
	// Why RRF instead of weighted sum: RRF is rank-based, not score-based,
	// so it's robust to scale differences between BM25 (negative) and cosine
	// (0-1). It also handles ties gracefully (no need to normalize).
	if (options.semanticQuery) {
		const semW = options.semanticWeight ?? 0.5;
		const lexW = 1 - semW;
		const N = results.length;

		// Compute cosine for each candidate. Parallel array of pairs
		// [cosine, index] — we'll sort by cosine to get semantic rank.
		const cosineByIdx: number[] = new Array(N);
		const hasEmbedding: boolean[] = new Array(N);
		for (let i = 0; i < N; i++) {
			const memEmbedding = bytesToVector(results[i].memory.embedding as any);
			if (memEmbedding) {
				cosineByIdx[i] = cosineSim(options.semanticQuery, memEmbedding);
				hasEmbedding[i] = true;
			} else {
				cosineByIdx[i] = 0;
				hasEmbedding[i] = false;
			}
		}

		// Build semantic rank list: indices sorted by cosine desc, but ONLY
		// for candidates that have an embedding. Missing-embedding entries
		// get rank = N (effectively zero contribution).
		const semanticRank = new Array<number>(N).fill(N);
		const sortedByCosine = Array.from({ length: N }, (_, i) => i)
			.filter((i) => hasEmbedding[i])
			.sort((a, b) => cosineByIdx[b] - cosineByIdx[a]);
		sortedByCosine.forEach((idx, rank) => {
			semanticRank[idx] = rank;
		});

		// RRF constant k=60 is the literature standard. It dampens the
		// contribution of very high ranks (rank 0 → 1/61 ≈ 0.016) and
		// makes the blend less sensitive to top-heaviness.
		const K = 60;
		results = results.map((r, i) => {
			const lexicalRank = i; // results came sorted by BM25 from searchByQuery
			const rrfLexical = 1 / (K + lexicalRank + 1);
			const rrfSemantic = 1 / (K + semanticRank[i] + 1);
			const blended = lexW * rrfLexical + semW * rrfSemantic;
			// Annotate with semantic score for observability (0 if no embedding).
			return {
				...r,
				score: blended,
				// Expose cosine via a metadata-ish field; type stays SearchResult
				// so we don't have to widen the public type. Tests use the
				// `.memory.embedding` field indirectly via store tests.
			};
		});

		results.sort((a, b) => b.score - a.score);
	}

	// Apply temporal decay: BM25 score * decay(memory).
	// Decay reduces score for old, rarely-accessed memories while boosting
	// frequently-accessed ones. Default ON; disable with applyDecay=false.
	if (options.applyDecay !== false) {
		results = results.map(r => ({
			...r,
			score: r.score * calculateDecay(r.memory),
		}));
		// Re-sort after decay adjustment
		results.sort((a, b) => b.score - a.score);
	}

	// Summary mode: truncate content for progressive disclosure
	if (options.summaryMode) {
		return results.map(r => ({
			...r,
			memory: {
				...r.memory,
				content: r.memory.content.length > 80
					? r.memory.content.slice(0, 80) + "…"
					: r.memory.content,
			},
		}));
	}

	return results;
}

/**
 * Search multiple stores (global + project) and merge by score.
 *
 * When `adaptive=true` (default), the retrieval depth is dynamically
 * adjusted based on query complexity. Simple queries get fewer results
 * (less noise, faster), complex queries get more (better recall).
 * Override with explicit `topK` to bypass adaptive sizing.
 *
 * Semantic layer: if the caller did NOT pass a `semanticQuery`, we look
 * it up in the module-level cache (populated by `primeQueryEmbedding` in
 * the recall path). If still not cached, the search runs BM25-only.
 * This lets the recall hook pre-warm the cache before search runs,
 * avoiding 30ms+ of embedding latency on the hot path.
 */
export function scopedSearch(stores: StorePair, query: string, options: SearchOptions = {}): SearchResult[] {
	const opts = { ...options };

	// Adaptive retrieval: classify query and adjust depth
	// unless the caller explicitly set topK/limit.
	const hasExplicitDepth = opts.topK !== undefined || opts.limit !== undefined;
	if (!hasExplicitDepth) {
		const { depth, complexity } = classifyQueryComplexity(query);
		opts.topK = depth;
		if (process.env.DREAM_DEBUG) {
			console.log(`[dream] adaptive retrieval: ${complexity} → topK=${depth}`);
		}
	}

	// Resolve the semantic query vector: explicit > cached > null.
	if (opts.semanticQuery === undefined) {
		opts.semanticQuery = getCachedQueryEmbedding(query);
	}

	const cacheKey = recallCacheKey(query, options, stores);
	const cached = recallCacheGet(cacheKey);
	if (cached) {
		if (process.env.DREAM_DEBUG) {
			console.log(`[dream] recall cache HIT for key=${cacheKey.slice(0, 8)}`);
		}
		return cached;
	}

	// Search global store
	const globalResults = hybridSearch(stores.global, query, opts);

	// Search project store if exists
	let projectResults: SearchResult[] = [];
	if (stores.project) {
		projectResults = hybridSearch(stores.project, query, opts);
	}

	// Merge by score, deduplicate by memory id. When the same memory id appears
	// in both global and project stores (e.g., a global insight copied as project
	// insight), keep the higher-scored instance. The previous code deduped by
	// content and kept whichever came first (always global), silently dropping
	// the more relevant project result.
	const allResults = [...globalResults, ...projectResults];
	const byId = new Map<string, typeof allResults[number]>();
	for (const r of allResults) {
		const existing = byId.get(r.memory.id);
		if (!existing || r.score > existing.score) {
			byId.set(r.memory.id, r);
		}
	}
	const deduped = Array.from(byId.values());

	// ── Spreading Activation (multi-hop) ──
	// Instead of 1-hop expansion, do BFS up to MAX_HOPS hops with dampening.
	// Each hop applies dampening^hop to the score.
	const MAX_HOPS = 2;
	const DAMPENING = 0.5;
	const finalLimit = opts.limit ?? opts.topK ?? 10;
	const knownIds = new Set(byId.keys());
	// Queue: [memoryId, hopDepth, parentScore]
	const queue: Array<{ id: string; hop: number; parentScore: number }> = [];

	// Seed: direct results
	for (const r of deduped) {
		const links = normalizeLinkedTo((r.memory.metadata as any)?.linked_to);
		for (const link of links) {
			if (!knownIds.has(link.id)) {
				queue.push({ id: link.id, hop: 1, parentScore: r.score });
			}
		}
	}

	// BFS
	while (queue.length > 0) {
		const item = queue.shift()!;
		if (knownIds.has(item.id)) continue;

		const parentStore = stores.project || stores.global;
		const linked = parentStore.getMemory(item.id);
		if (!linked) continue;

		knownIds.add(item.id);
		const hopScore = Math.max(item.parentScore * Math.pow(DAMPENING, item.hop), 0.05);

		byId.set(item.id, {
			memory: linked,
			score: hopScore,
			snippet: linked.content.length > 200
				? linked.content.slice(0, 197) + "..."
				: linked.content,
			isLinked: true,
			linkRelation: `hop-${item.hop}`,
		});

		// Expand to next hop if within limit
		if (item.hop < MAX_HOPS) {
			const nextLinks = normalizeLinkedTo((linked.metadata as any)?.linked_to);
			for (const link of nextLinks) {
				if (!knownIds.has(link.id)) {
					queue.push({ id: link.id, hop: item.hop + 1, parentScore: hopScore });
				}
			}
		}
	}

	// Sort by score descending and slice
	const finalResults = Array.from(byId.values())
		.sort((a, b) => b.score - a.score)
		.slice(0, finalLimit);

	// Log recall for observability (fire-and-forget, don't block return)
	try {
		const injectedTokens = finalResults.reduce((acc, r) => acc + Math.ceil(r.memory.content.length / 4), 0);
		stores.global.logRecall({
			query,
			resultsCount: finalResults.length,
			topScore: finalResults.length > 0 ? finalResults[0].score : undefined,
			injectedTokens,
			metadata: {
				categories: finalResults.reduce((acc, r) => {
					const cat = r.memory.category || "_none";
					acc[cat] = (acc[cat] || 0) + 1;
					return acc;
				}, {} as Record<string, number>),
				scopes: finalResults.reduce((acc, r) => {
					acc[r.memory.scope] = (acc[r.memory.scope] || 0) + 1;
					return acc;
				}, {} as Record<string, number>),
			},
		});
	} catch {
		// Don't let recall logging break search
	}

	// Summary mode: truncate content for progressive disclosure
	if (options.summaryMode) {
		const summarized = finalResults.map(r => ({
			...r,
			memory: {
				...r.memory,
				content: r.memory.content.length > 80
					? r.memory.content.slice(0, 80) + "…"
					: r.memory.content,
			},
		}));
		recallCacheSet(cacheKey, summarized);
		return summarized;
	}

	recallCacheSet(cacheKey, finalResults);
	return finalResults;
}

