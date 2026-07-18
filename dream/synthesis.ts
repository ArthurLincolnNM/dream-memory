/**
 * dream-memory/dream/synthesis.ts
 * Synthesis detection for /dream command
 *
 * Detects patterns across similar memories and creates consolidated memories.
 * No LLM required — uses pure-JS clustering by shared key terms (extracted
 * via Unicode-aware regex). NOT FTS5-based: the implementation is O(n²) per
 * group via pairwise term overlap. For >10k memories, consider switching to
 * FTS5-backed similarity (out of scope for this PR).
 */

import type { Memory, DreamStore } from "../store/sqlite.js";

export interface SynthesisCandidate {
	pattern: string; // Description of the pattern
	synthesizedContent: string;
	sourceIds: string[];
	target: Memory["target"];
	category: Memory["category"];
	tier: Memory["tier"];
	confidence: number; // 0-1, how confident we are in this synthesis
}

/**
 * Find synthesis candidates in a store
 * Groups memories by (target, category) and finds clusters of ≥3 similar ones
 */
export async function findSynthesisCandidates(
	store: DreamStore,
	options: {
		minClusterSize?: number;
		maxResults?: number;
		maxClusterSize?: number;
		/**
		 * Optional focus terms from the user (e.g., "vim, postgresql, tests").
		 * A candidate whose synthesizedContent or pattern contains ANY focus
		 * term (case-insensitive) gets a +0.15 confidence boost. After all
		 * candidates are built, the list is re-sorted by confidence DESC so
		 * focused candidates bubble up and are processed first when the
		 * maxResults cap kicks in. This implements the `focus on X` directive
		 * from /dream that was previously parsed but ignored.
		 */
		focusTerms?: string[];
		/**
		 * F4 (dream delta): only consider memories updated at or after
		 * this epoch ms. In delta mode the caller passes the timestamp of
		 * the previous dream run; clusters are formed only from new and
		 * edited memories. Auto-dream uses delta; manual /dream defaults
		 * to delta but accepts `--full` to force a full re-cluster.
		 */
		since?: number;
	} = {},
): SynthesisCandidate[] {
	const minClusterSize = options.minClusterSize || 3;
	const maxResults = options.maxResults || 10;
	// Cap on cluster size: prevents one mega-cluster from absorbing hundreds
	// of memories. The synthesized "facts" excerpt is the most distinctive
	// sentence from each, so 20 sources is more than enough context.
	const maxClusterSize = options.maxClusterSize || 20;
	// Normalize focus terms once so the per-candidate check below is cheap.
	const focusTerms = (options.focusTerms ?? []).map((t) => t.toLowerCase()).filter(Boolean);

	// Step 1: Group memories by (target, category)
	// Only consider ACTIVE memories — resolved/superseded are excluded from synthesis
	const groups = new Map<string, Memory[]>();
	const allMemories = store.getActiveMemories({
		limit: 10000,
		// F4: pass the since filter through so the candidate set is
		// restricted to memories updated since the last dream run. When
		// `since` is undefined (full mode), the option is a no-op.
		since: options.since,
	});

	for (const mem of allMemories) {
		// Map undefined/empty category to "insight" up front to avoid passing
		// the literal string "none" through the type cast downstream.
		const effectiveCategory = mem.category || "insight";
		const key = `${mem.target}::${effectiveCategory}`;
		if (!groups.has(key)) {
			groups.set(key, []);
		}
		groups.get(key)!.push(mem);
	}

	// Step 2: For each group with ≥3 memories, find clusters
	const candidates: SynthesisCandidate[] = [];

	// Track source IDs already claimed by an earlier candidate in this pass.
	// Without this, a memory that fits two different clusters would be in
	// both candidates' sourceIds, and the later synthesis would either
	// (a) try to consolidate it again (overwriting consolidatedInto) or
	// (b) skip it (causing the second cluster to underflow). The
	// applySynthesis layer handles (a) and (b) defensively, but skipping
	// here keeps the candidate count clean.
	const globallyClaimed = new Set<string>();

	for (const [key, memories] of groups) {
		if (memories.length < minClusterSize) continue;
		if (candidates.length >= maxResults) break;

		const [target, category] = key.split("::");
		const clusters = findSimilarClusters(memories, store, minClusterSize, maxClusterSize, globallyClaimed);

		for (const cluster of clusters) {
			if (candidates.length >= maxResults) break;
			// Skip if cluster is too small after dedup
			const availableSources = cluster.filter((m) => !globallyClaimed.has(m.id));
			if (availableSources.length < minClusterSize) continue;
			let candidate: SynthesisCandidate | null = null;
			// MEM1-inspired: use LLM for large clusters if callback provided
			if (options.llmConsolidate && availableSources.length >= 6) {
				try {
					const llmResult = await options.llmConsolidate(
						availableSources.map(m => ({
							content: m.content,
							target: m.target || target,
							category: m.category || category || "insight",
						}))
					);
					if (llmResult && llmResult.trim().length > 0) {
						const date = new Date().toISOString().split("T")[0];
						const synthContent = `[Synthesized ${date} from ${availableSources.length} memories via LLM] ${llmResult}`;
						const tier: "factual" | "operational" =
							target === "user" || target === "project" ? "factual" : "operational";
						candidate = {
							pattern: availableSources.map(m => extractKeyTerms(m.content).slice(0, 2).join(" ")).join(", "),
							synthesizedContent: synthContent.length > 400 ? synthContent.slice(0, 397) + "..." : synthContent,
							sourceIds: availableSources.map(m => m.id),
							target: target as Memory["target"],
							category: category as Memory["category"],
							tier,
							confidence: 0.9,
						};
					}
				} catch (err) {
					if (process.env.DREAM_DEBUG) {
						console.warn("[dream] LLM synthesis failed, falling back to keywords:", err);
					}
				}
			}
			// Fallback: keyword-based synthesis if LLM didn't produce a result
			if (!candidate) {
				candidate = synthesize(availableSources, target, category);
			}
			if (candidate) {
				candidates.push(candidate);
				for (const m of availableSources) globallyClaimed.add(m.id);
			}
		}
	}

	// Apply focus boost: +0.15 confidence for any candidate that contains
	// a focus term in its synthesized content or pattern. Cap at 0.95 to
	// match the decay module's MAX_DECAY ceiling — we don't want focus
	// boost to make a candidate appear artificially perfect.
	if (focusTerms.length > 0) {
		for (const c of candidates) {
			const haystack = (c.synthesizedContent + " " + c.pattern).toLowerCase();
			if (focusTerms.some((t) => haystack.includes(t))) {
				c.confidence = Math.min(0.95, c.confidence + 0.15);
			}
		}
		// Re-sort by confidence DESC so focused candidates bubble up
		// before the maxResults cap trims the list. The previous code
		// preserved insertion order, so a strong cluster that happened
		// to be discovered after a weak one could be silently dropped.
		candidates.sort((a, b) => b.confidence - a.confidence);
	}

	return candidates;
}

/**
 * Find clusters of similar memories using shared key terms
 * Two memories are similar if they share key terms
 */
function findSimilarClusters(
	memories: Memory[],
	store: DreamStore,
	minClusterSize: number,
	maxClusterSize: number,
	globallyClaimed: Set<string>,
): Memory[][] {
	const clusters: Memory[][] = [];
	const processed = new Set<string>();

	// PERF FIX: precompute keyTerms for every memory ONCE. The previous code
	// extracted keyTerms inside the inner loop, so for a 10k-memory group
	// we ran extractKeyTerms 10k * 10k = 100M times. With caching, it's
	// 10k once, and the inner loop just looks up two pre-computed sets.
	const termsById = new Map<string, string[]>();
	for (const mem of memories) {
		termsById.set(mem.id, extractKeyTerms(mem.content));
	}

	// PERF FIX: build an inverted index from term → list of memory ids that
	// contain that term. The inner loop then only compares against memories
	// that share at least one term (typically O(small_set) instead of O(all)).
	const termIndex = new Map<string, string[]>();
	for (const mem of memories) {
		for (const term of termsById.get(mem.id) || []) {
			if (!termIndex.has(term)) termIndex.set(term, []);
			termIndex.get(term)!.push(mem.id);
		}
	}

	// For each memory, find similar ones via the inverted index.
	for (const mem of memories) {
		if (processed.has(mem.id)) continue;

		// Work with ids during clustering, map back to Memory at the end.
		const clusterIds: string[] = [mem.id];
		processed.add(mem.id);

		const keyTerms = termsById.get(mem.id) || [];
		if (keyTerms.length === 0) continue;

		// Collect candidate ids from the inverted index: any memory that
		// shares at least one term with `mem`. We dedup in the inner loop
		// because a memory can appear under multiple term entries.
		const candidates = new Set<string>();
		for (const term of keyTerms) {
			for (const id of termIndex.get(term) || []) {
				if (id !== mem.id) candidates.add(id);
			}
		}

		// For each candidate, count shared terms with `mem` to filter by
		// the "at least 2 shared terms" threshold. Using a pre-built
		// index of term-to-ids keeps this O(matched) instead of O(N).
		for (const otherId of candidates) {
			if (processed.has(otherId)) continue;
			if (clusterIds.length >= maxClusterSize) break;

			const otherTerms = termsById.get(otherId) || [];
			let sharedCount = 0;
			for (const t of keyTerms) {
				if (otherTerms.includes(t)) sharedCount++;
			}
			if (sharedCount >= 2) {
				clusterIds.push(otherId);
				processed.add(otherId);
			}
		}

		if (clusterIds.length >= minClusterSize) {
			// Map back to Memory objects; the indexes stored ids, not objects.
			const clusterMems: Memory[] = [];
			for (const id of clusterIds) {
				if (globallyClaimed.has(id)) continue;
				const m = memories.find((x) => x.id === id);
				if (m) clusterMems.push(m);
			}
			if (clusterMems.length >= minClusterSize) {
				clusters.push(clusterMems);
			}
		}
	}

	return clusters;
}

/**
 * Extract key terms from content (longer than 3 chars, not common words)
 */
function extractKeyTerms(content: string): string[] {
	const stopWords = new Set([
		"the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was",
		"one", "our", "out", "this", "that", "with", "have", "from", "they", "what",
		"when", "make", "like", "time", "just", "know", "take", "into", "year", "your",
		"good", "some", "could", "them", "than", "look", "only", "its", "over", "also",
		"para", "com", "que", "uma", "tem", "isso", "aqui", "como", "mais", "foi",
		"este", "esta", "muito", "ser", "nao", "sim", "mas",
	]);

	const words = content.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
	const terms: string[] = [];

	for (const word of words) {
		if (word.length < 4) continue;
		if (stopWords.has(word)) continue;
		terms.push(word);
	}

	// Deduplicate
	return Array.from(new Set(terms));
}

/**
 * Synthesize a cluster of similar memories into a single memory.
 *
 * Confidence is computed from actual cluster cohesion (not just a count of
 * top terms). The previous code returned 0.5 or 0.7 depending on whether
 * `topTerms.length >= 2`, which ignored cluster size, content length, and
 * term dominance. This version uses:
 *   - cluster coverage: how many of the cluster's memories share each top term
 *   - term dominance: how dominant the top terms are vs the rest
 *   - cluster size: more sources = more confidence (with diminishing returns)
 */
export function synthesize(
	cluster: Memory[],
	target: string,
	category: string,
	llmConsolidate?: (memories: Array<{ content: string; target: string; category: string }>) => Promise<string | null>,
): SynthesisCandidate | null {
	if (cluster.length < 3) return null;

	// Find common theme (most frequent non-stopword)
	const termFreq = new Map<string, number>();
	for (const mem of cluster) {
		const terms = extractKeyTerms(mem.content);
		for (const term of terms) {
			termFreq.set(term, (termFreq.get(term) || 0) + 1);
		}
	}

	// Sort by frequency, take top 3
	const topTerms = Array.from(termFreq.entries())
		.filter(([_, count]) => count >= 2) // appears in at least 2 memories
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([term]) => term);

	if (topTerms.length === 0) return null;

	// Real confidence: combine three signals.
	// 1) Cluster coverage: % of memories that contain at least one top term
	const memsCoveredByTop = cluster.filter((m) => {
		const lower = m.content.toLowerCase();
		return topTerms.some((t) => lower.includes(t));
	}).length;
	const coverage = memsCoveredByTop / cluster.length;

	// 2) Term dominance: how much of the total term mass is in top terms
	let totalTermCount = 0;
	for (const v of termFreq.values()) totalTermCount += v;
	const topTermCount = topTerms.reduce((s, t) => s + (termFreq.get(t) || 0), 0);
	const dominance = totalTermCount > 0 ? topTermCount / totalTermCount : 0;

	// 3) Cluster size: diminishing returns via 1 - 1/n
	const sizeBoost = 1 - 1 / cluster.length;

	// Weighted blend, clamped to [0.3, 0.95] to avoid degenerate 0 or 1.
	const raw = 0.5 * coverage + 0.3 * dominance + 0.2 * sizeBoost;
	const confidence = Math.max(0.3, Math.min(0.95, raw));

	// Extract a representative "fact" from each memory: pick the sentence
	// containing the most top-terms (not the truncated prefix). This preserves
	// more of the source content than the previous "first 100 chars" approach,
	// which silently dropped the relevant tail for long memories.
	const facts = cluster.map((m) => {
		if (m.content.length <= 200) return m.content;
		const sentences = m.content.split(/(?<=[.!?])\s+/);
		let bestSentence = sentences[0] || m.content;
		let bestScore = -1;
		for (const s of sentences) {
			const lower = s.toLowerCase();
			let score = 0;
			for (const t of topTerms) if (lower.includes(t)) score++;
			if (score > bestScore) {
				bestScore = score;
				bestSentence = s;
			}
		}
		// Hard cap: even the best sentence gets truncated at 200 chars to keep
		// the synthesized memory readable.
		return bestSentence.length > 200 ? bestSentence.slice(0, 200) + "..." : bestSentence;
	});

	// ── R2 v3: episodic → semantic abstraction ──
	// Pick the most distinctive "approach" sentence: longest fact that
	// contains the most top-terms. This becomes the reusable principle
	// instead of a raw concatenation of all source facts. Memory-as-a-Tool
	// (vicgalle/arXiv 2601.05960) showed that synthesizing principles
	// (not fact lists) is what makes feedback amortize across tasks.
	let approach = facts[0] || "";
	let approachScore = -1;
	for (const f of facts) {
		const lower = f.toLowerCase();
		let s = 0;
		for (const t of topTerms) if (lower.includes(t)) s++;
		// Prefer higher top-term count; break ties on length (more detail wins).
		if (s > approachScore || (s === approachScore && f.length > approach.length)) {
			approach = f;
			approachScore = s;
		}
	}
	// Hard-cap the approach sentence itself so one chatty fact can't
	// dominate the synthesized memory.
	approach = approach.length > 180 ? approach.slice(0, 177) + "..." : approach;

	// For richer clusters (N >= 5), include 1–2 short examples to give the
	// agent concrete cases alongside the principle. Skipped for small
	// clusters to keep the output principle-focused (not example-dump).
	let examplesLine = "";
	if (cluster.length >= 5) {
		const otherFacts = facts.filter((f) => f !== approach);
		const examples = otherFacts.slice(0, 2).map((f) => (f.length > 70 ? f.slice(0, 67) + "..." : f));
		if (examples.length > 0) {
			examplesLine = ` Examples: ${examples.join(" | ")}.`;
		}
	}

	// Build synthesized content
	const date = new Date().toISOString().split("T")[0];
	const pattern = topTerms.join(", ");
	let content = `[Synthesized ${date} from ${cluster.length} memories] ` +
		`Pattern: ${pattern}. ` +
		`Approach: ${approach}.` +
		examplesLine;

	// Cap at 400 chars (R2 v3; was 1500). Forces abstraction: a principle
	// must fit in ~2 sentences, not a fact dump. Aligns with
	// Memory-as-a-Tool — synthesize rules, not logs. Also well under the
	// recall budget (perMemoryTokens=300 * 4 = 1200 chars) so the synthesis
	// never gets truncated by recall.injection downstream.
	const MAX_SYNTHESIS_CHARS = 400;
	if (content.length > MAX_SYNTHESIS_CHARS) {
		content = content.slice(0, MAX_SYNTHESIS_CHARS - 3) + "...";
	}

	// Determine tier. Factual (permanent) for stable knowledge — user
	// preferences and project conventions outlive the workflow that
	// produced them. Operational (short TTL) for ephemeral material like
	// session notes and failure patterns, which lose relevance quickly.
	// The previous code marked project as operational (7d TTL), causing
	// synthesized project knowledge to expire within a week.
	const tier: "factual" | "operational" =
		target === "user" || target === "project" ? "factual" : "operational";

	return {
		pattern,
		synthesizedContent: content,
		sourceIds: cluster.map((m) => m.id),
		target: target as Memory["target"],
		// The grouping pass at the top of findSynthesisCandidates normalizes
		// undefined/empty category to "insight" before building group keys,
		// so by the time we reach here `category` is never empty. Cast directly.
		category: category as Memory["category"],
		tier,
		confidence,
	};
}

/**
 * Apply synthesis candidates to a store. Creates new memories and marks
 * originals as consolidated.
 *
 * Source-tracking fix: a memory that appears in multiple candidate clusters
 * is only marked consolidated once (the FIRST synthesis that consumes it
 * "owns" the reference). Subsequent syntheses see the memory as already
 * consolidated and skip it. Without this, the second synthesis would
 * overwrite `metadata.consolidatedInto` on the shared source, losing the
 * pointer to the first synthesis.
 *
 * Atomicity: the create + markConsolidated calls for a single candidate
 * are wrapped in a SQLite transaction via `store.createMemory` and
 * `store.markConsolidated` (which use the same connection). If a partial
 * failure occurs mid-candidate, the next dream run can retry safely
 * because the createVersion audit trail records what was attempted.
 */
export interface SynthesisResult {
	created: SynthesisCandidate[];
	markedConsolidated: string[];
	alreadyConsolidated: string[];
}

export function applySynthesis(
	store: DreamStore,
	candidates: SynthesisCandidate[],
	scopeInfo: { scope: "global" | "project"; scopeId: string | null },
): SynthesisResult {
	const result: SynthesisResult = {
		created: [],
		markedConsolidated: [],
		alreadyConsolidated: [],
	};

	// Track which source IDs have already been consolidated in THIS pass.
	// Prevents overwriting consolidatedInto with a later synthesis's id.
	const claimedSources = new Set<string>();

	for (const candidate of candidates) {
		// Filter sourceIds: skip ones that were already claimed by an earlier
		// candidate in this pass, AND skip ones that are already consolidated
		// in the DB (e.g., from a previous dream run that ran partially).
		const availableSourceIds: string[] = [];
		for (const sourceId of candidate.sourceIds) {
			if (claimedSources.has(sourceId)) continue;
			const mem = store.getMemory(sourceId);
			if (!mem) continue;
			const meta = mem.metadata as any;
			if (meta?.consolidated) {
				result.alreadyConsolidated.push(sourceId);
				continue;
			}
			availableSourceIds.push(sourceId);
		}

		if (availableSourceIds.length < 3) {
			// Not enough sources left for a meaningful synthesis (minClusterSize=3)
			continue;
		}

		// Use the filtered subset for the new synthesis
		const newCandidate: SynthesisCandidate = {
			...candidate,
			sourceIds: availableSourceIds,
		};

		// Create the synthesized memory. The scope and scope_id come from the
		// caller (runDream) so that a synthesis running on a project output
		// store correctly tags the new memory as project-scoped, and a
		// synthesis on the global output tags it as global. The previous
		// implementation hardcoded `scope: "global"`, which polluted
		// project.db with global-scoped synthesized memories that the
		// global-only recall path would never find.
		const newMemory = store.createMemory({
			content: newCandidate.synthesizedContent,
			scope: scopeInfo.scope,
			scope_id: scopeInfo.scopeId ?? undefined,
			target: newCandidate.target,
			category: newCandidate.category,
			status: "active",
			tier: newCandidate.tier,
			// Factual memories are permanent (ttl_days=null); operational get
			// 30d. The store signature accepts `number | undefined` and treats
			// `null` as "use the existing value or default" — we coerce to
			// undefined here so the inferred type matches.
			ttl_days: newCandidate.tier === "factual" ? undefined : 30, // Factual is permanent
			confidence: "synthesized", // /dream consolidation
			// v1.7: synthesis produces semantic knowledge by definition
			// (it's the abstraction step). R4 re-clustering can update
			// these later if the cluster evolves.
			memory_kind: "semantic",
			// v2.0: synthesized memories get agreed_upon trust (2)
			// They're consolidation of existing memories, not raw user input
			// nor auto-extracted patterns.
			trust_level: 2,
			metadata: {
				synthesizedFrom: newCandidate.sourceIds,
				pattern: newCandidate.pattern,
				confidence: newCandidate.confidence,
				synthesizedAt: Date.now(),
				source: `synthesis:${newCandidate.sourceIds.length} memories from "${newCandidate.pattern}"`,
				sourceType: "synthesis",
				// Gap #2: reason field. Surfaced in recall XML so the agent
				// can tell WHY this synthesis exists and how strong the
				// abstraction is. Derived from cluster size, confidence,
				// and top terms (the same data the synthesizedContent uses).
				reason: buildSynthesisReason(newCandidate),
			},
		});

		// Mark source memories as consolidated. This is best-effort per
		// source: if marking one fails, we still try the others (they're
		// independent metadata writes).
		for (const sourceId of newCandidate.sourceIds) {
			try {
				store.markConsolidated(sourceId, newMemory.id);
				claimedSources.add(sourceId);
				result.markedConsolidated.push(sourceId);
			} catch (err) {
				// Skip this source — leave it for next pass. The synthesized
				// memory still exists with a partial sourceIds list, which
				// is recoverable from the audit trail.
			}
		}

		result.created.push(newCandidate);
	}

	return result;
}

// ── R4 v3: reclusterStaleSyntheses ─────────────────────────────────────
//
// Background: syntheses are static (their content is fixed at creation).
// If new sibling memories arrive after the synthesis (same target+category),
// the synthesis becomes stale — it summarizes an old cluster that's now
// incomplete. Cognee addresses this with an "improve" operation. R4 is
// the dream-memory equivalent: re-run synthesize() on the union of
// (synthesis's source memories) + (new siblings), and if the result
// differs, update the synthesis in place.
//
// Why re-cluster instead of always creating a new synthesis: preserves
// the synthesis id (external references like linked_to stay valid) and
// keeps the memory count bounded (no accumulation of stale syntheses).
//
// Triggers: a synthesis is reclustered when ALL of:
//   1. It has >= minNewSiblings new sibling memories (created after
//      synthesis's updated_at). Default 2.
//   2. It hasn't been reclustered recently (>= minDaysSinceUpdate since
//      its last update). Default 1 day. Without this, every /dream run
//      would recluster the same synthesis if the cluster keeps growing.
//   3. The new cluster produces different content (string inequality).
//      No change = no write.

export interface ReclusterResult {
	checked: number;
	reclustered: number;
	skipped: number;
	updated: Array<{ id: string; oldContent: string; newContent: string }>;
	/**
	 * Per-synthesis breakdown for verbose output. Each entry reports
	 * the action taken (reclustered or skipped) and the reason when
	 * skipped (which gate fired). For reclustered entries, the reason
	 * describes what changed (e.g., "date-header-updated" when the
	 * only difference is the date stamp).
	 */
	details: Array<{
		id: string;
		action: "reclustered" | "skipped";
		reason?: string;
		oldContent?: string;
		newContent?: string;
	}>;
}

export interface ReclusterOptions {
	/**
	 * Minimum number of new sibling memories required to trigger
	 * re-clustering. Default 2 (avoids reclustering on a single new
	 * memory that might not change the cluster much).
	 */
	minNewSiblings?: number;
	/**
	 * Skip syntheses updated within this many days. Prevents thrashing
	 * when /dream runs in a tight loop. Default 1.
	 */
	minDaysSinceUpdate?: number;
	/**
	 * Optional dry-run: compute what would change but don't write.
	 * Useful for `dream_memory_status` reporting.
	 */
	dryRun?: boolean;
	/**
	 * Gap #1 backfill: bypass the minNewSiblings and minDaysSinceUpdate
	 * gates. Re-synthesize every active synthesis to upgrade to the
	 * current template (e.g. R2 v3's "Approach:" format vs old "Facts:").
	 * The content-changed gate still applies, so already-upgraded
	 * syntheses are no-ops. Use for one-shot migrations after a
	 * synthesis template change.
	 */
	force?: boolean;
	/**
	 * Bypass the content-changed gate (Gate 4). When true, the
	 * synthesis is always written even if re-synthesize produces
	 * identical content (e.g., running on the same day produces the
	 * same date header). Useful for forcing a re-templating or for
	 * audit trails. Default false.
	 */
	bypassContentCheck?: boolean;
}

export function reclusterStaleSyntheses(
	store: DreamStore,
	options: ReclusterOptions = {},
): ReclusterResult {
	const minNewSiblings = options.minNewSiblings ?? 2;
	const minDaysSinceUpdate = options.minDaysSinceUpdate ?? 1;
	const dryRun = options.dryRun ?? false;
	const force = options.force ?? false;
	const bypassContentCheck = options.bypassContentCheck ?? false;

	const result: ReclusterResult = {
		checked: 0,
		reclustered: 0,
		skipped: 0,
		updated: [],
		details: [],
	};

	// Find all active syntheses
	const syntheses = store.listMemories({
		status: "active",
		limit: 10000,
	});
	const synthesisMems = syntheses.filter((m) => {
		const meta = m.metadata as any;
		return (
			m.confidence === "synthesized" &&
			meta?.sourceType === "synthesis" &&
			Array.isArray(meta?.synthesizedFrom)
		);
	});

	const now = Date.now();
	const minUpdateAge = minDaysSinceUpdate * 24 * 60 * 60 * 1000;

	for (const synth of synthesisMems) {
		result.checked++;

		// Gate 1: skip if recently updated (bypassed when force=true for
		// one-shot template upgrades)
		if (!force && now - synth.updated_at < minUpdateAge) {
			result.details.push({ id: synth.id, action: "skipped", reason: "min-days-since-update" });
			result.skipped++;
			continue;
		}

		const meta = synth.metadata as any;
		const sourceIds: string[] = meta.synthesizedFrom;

		// Gate 2: re-load the source memories (some may have been deleted)
		const sources = sourceIds
			.map((id) => store.getMemory(id))
			.filter((m): m is Memory => m !== null);

		if (sources.length < 3) {
			// minClusterSize is 3; can't form a cluster with fewer sources
			result.details.push({ id: synth.id, action: "skipped", reason: "sources-deleted (<3)" });
			result.skipped++;
			continue;
		}

		// Find new siblings: same (target, category) as synthesis, NOT in
		// the source list, created at or after synthesis's updated_at,
		// and status=active.
		const newSiblings = store
			.listMemories({
				target: synth.target,
				category: synth.category,
				status: "active",
				limit: 1000,
			})
			.filter(
				(m) =>
					m.id !== synth.id &&
					!sourceIds.includes(m.id) &&
					m.created_at >= synth.updated_at,
			);

		// Gate 3: enough new siblings to justify re-clustering (bypassed
		// when force=true for one-shot template upgrades)
		if (!force && newSiblings.length < minNewSiblings) {
			result.details.push({
				id: synth.id,
				action: "skipped",
				reason: `too-few-new-siblings (${newSiblings.length}/${minNewSiblings})`,
			});
			result.skipped++;
			continue;
		}

		// Recluster: union of original sources + new siblings
		const fullCluster = [...sources, ...newSiblings];
		const newCandidate = synthesize(fullCluster, synth.target || "user", synth.category || "insight");
		if (!newCandidate) {
			// synthesize() returned null (cluster didn't meet minClusterSize
			// or had no common terms). Skip.
			result.details.push({ id: synth.id, action: "skipped", reason: "synthesize-returned-null" });
			result.skipped++;
			continue;
		}

		// Gate 4: content actually changed (bypassed when bypassContentCheck=true)
		if (!bypassContentCheck && newCandidate.synthesizedContent === synth.content) {
			result.details.push({ id: synth.id, action: "skipped", reason: "content-unchanged" });
			result.skipped++;
			continue;
		}

		// Update in place. Preserve id, scope, scope_id, tier. Update content
		// and updated_at. Append recluster metadata for audit.
		const newMetadata = {
			...synth.metadata,
			lastReclusteredAt: now,
			previousContent: synth.content,
			reclusterNewSiblings: newSiblings.length,
		};
		if (!dryRun) {
			store.updateMemory(synth.id, {
				content: newCandidate.synthesizedContent,
				metadata: newMetadata,
			});
		}
		result.updated.push({
			id: synth.id,
			oldContent: synth.content,
			newContent: newCandidate.synthesizedContent,
		});
		result.details.push({
			id: synth.id,
			action: "reclustered",
			reason: bypassContentCheck ? "forced-write" : "content-changed",
			oldContent: synth.content,
			newContent: newCandidate.synthesizedContent,
		});
		result.reclustered++;
	}

	return result;
}

// ── Gap #2: reason field auto-generation for syntheses ────────────────
//
// Builds a concise reason string from a synthesis candidate. The reason
// appears in recall XML as `reason="..."` so the agent can tell WHY the
// synthesis exists, how strong the abstraction is, and what pattern it
// captures. Derived from cluster size, confidence, and top terms (the
// same data the synthesizedContent uses), so no extra signal needed.

function buildSynthesisReason(candidate: SynthesisCandidate): string {
	const sourceCount = candidate.sourceIds.length;
	const confidencePct = Math.round(candidate.confidence * 100);
	const topTerms = candidate.pattern || "no terms";
	return `Synthesized from ${sourceCount} sibling memor${sourceCount === 1 ? "y" : "ies"} (confidence ${confidencePct}%). Pattern: ${topTerms}.`;
}

// ── Gap #5: GC of stale memories ──────────────────────────────────────────────────
//
// Background: R3 v3 flags stale memories in recall output, but never removes
// them. Over time, the DB accumulates "always stale, never accessed"
// memories that pollute the active set. This GC finds candidates that
// are highly likely to be noise (low utility AND not accessed recently)
// and marks them as superseded (preserves for audit/recovery, but
// removes from active recall).
//
// Heuristics (configurable):
//   - maxUtilityScore: GC if utility_score <= this. Default -0.5
//     (memory has been chronically penalized; active forgetting
//     #3 already applied -0.05 five times = -0.25, plus F3 -0.02
//     per failure on top).
//   - maxDaysSinceAccess: GC if last_accessed_at is null OR older
//     than this. Default 90 days. None-recently-accessed memories are
//     likely irrelevant even if utility isn't deeply negative.
//
// Safety:
//   - Skips memories with `metadata.always_inject = true` (user-pinned).
//   - Skips memories with `confidence = "explicit"` AND access_count > 0
//     (user really cares about these).
//   - Skips memories with very recent updated_at (don't GC memories that
//     were just created/edited).
//   - dryRun option for preview.

export interface GcResult {
	checked: number;
	gcCount: number;
	skipped: number;
	ids: string[];
	details: Array<{
		id: string;
		action: "gc'd" | "skipped";
		reason: string;
		utilityScore?: number;
		lastAccessedAt?: number | null;
	}>;
}

export interface GcOptions {
	maxUtilityScore?: number;
	maxDaysSinceAccess?: number;
	minDaysSinceUpdate?: number;
	dryRun?: boolean;
}

export function garbageCollectStaleMemories(
	store: DreamStore,
	options: GcOptions = {},
): GcResult {
	const maxUtility = options.maxUtilityScore ?? -0.5;
	const maxDaysSinceAccess = options.maxDaysSinceAccess ?? 90;
	const minDaysSinceUpdate = options.minDaysSinceUpdate ?? 7;
	const dryRun = options.dryRun ?? false;
	const now = Date.now();
	const accessCutoff = now - maxDaysSinceAccess * 24 * 60 * 60 * 1000;
	const updateCutoff = now - minDaysSinceUpdate * 24 * 60 * 60 * 1000;

	const result: GcResult = {
		checked: 0,
		gcCount: 0,
		skipped: 0,
		ids: [],
		details: [],
	};

	// Get all active memories
	const candidates = store.listMemories({
		status: "active",
		limit: 10000,
	});

	for (const mem of candidates) {
		result.checked++;
		const utility = mem.utility_score ?? 0;
		const lastAccess = mem.last_accessed_at;
		const meta = mem.metadata as any;

		// Safety: skip always-inject (user-pinned)
		if (meta?.always_inject === true) {
			result.skipped++;
			result.details.push({
				id: mem.id,
				action: "skipped",
				reason: "always-inject (user-pinned)",
				utilityScore: utility,
				lastAccessedAt: lastAccess,
			});
			continue;
		}

		// Safety: skip memories with explicit confidence AND any access
		// (user really cares, don't GC even if utility is bad)
		if (mem.confidence === "explicit" && (mem.access_count ?? 0) > 0) {
			result.skipped++;
			result.details.push({
				id: mem.id,
				action: "skipped",
				reason: "explicit-with-access (user-cared)",
				utilityScore: utility,
				lastAccessedAt: lastAccess,
			});
			continue;
		}

		// Safety: skip memories updated recently (don't GC fresh work)
		if (mem.updated_at > updateCutoff) {
			result.skipped++;
			result.details.push({
				id: mem.id,
				action: "skipped",
				reason: "recently-updated",
				utilityScore: utility,
				lastAccessedAt: lastAccess,
			});
			continue;
		}

		// GC criteria: utility is too low AND not accessed recently
		const lowUtility = utility <= maxUtility;
		const staleAccess = !lastAccess || lastAccess <= accessCutoff;
		if (!lowUtility || !staleAccess) {
			// Doesn't meet BOTH criteria; skip without reason logged (verbose=false by default)
			result.skipped++;
			continue;
		}

		// Eligible for GC
		const reason = `low-utility (${utility.toFixed(2)}) + stale-access (${lastAccess ? Math.round((now - lastAccess) / (24 * 60 * 60 * 1000)) + "d ago" : "never"})`;
		if (!dryRun) {
			store.updateMemory(mem.id, { status: "superseded" });
		}
		result.ids.push(mem.id);
		result.details.push({
			id: mem.id,
			action: "gc'd",
			reason,
			utilityScore: utility,
			lastAccessedAt: lastAccess,
		});
		result.gcCount++;
	}

	return result;
}
