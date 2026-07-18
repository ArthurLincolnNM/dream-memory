/**
 * dream-memory/utils/constants.ts
 * Shared constants for tool parameter schemas
 */

export const MEMORY_TARGETS = ["user", "memory", "project", "failure"] as const;
export const MEMORY_SCOPES = ["global", "project", "agent", "session"] as const;
export const MEMORY_CATEGORIES = [
	"failure",
	"correction",
	"insight",
	"preference",
	"convention",
	"tool-quirk",
	"procedure",
] as const;
export const MEMORY_STATUSES = ["active", "resolved", "superseded"] as const;
export const MEMORY_SOURCE_TYPES = ["user", "file", "web", "tool-result", "conversation", "query-synthesis"] as const;
export const TTL_CLASSES = ["permanent", "long", "medium", "short", "session"] as const;

// ── Trust Hierarchy (v2.0) ──────────────────────────────────────────
// Inspired by YesMem's 4-tier trust model: user_stated > agreed_upon >
// claude_suggested > llm_extracted. Numeric for decay weighting and
// contradiction arbitration.
//
// The hierarchy answers: "when two memories conflict, which one wins?"
// Higher trust wins by default. Equal trust = ask user or heuristic.

/** Numeric trust levels (0-3). Higher = more trustworthy. */
export const TRUST_LEVELS = {
	/** Auto-captured from tool usage. Lowest trust — agent observed a pattern. */
	llm_extracted: 0,
	/** Agent suggested, no explicit user confirmation. */
	llm_suggested: 1,
	/** User confirmed or agent suggested + user accepted. Default for legacy. */
	agreed_upon: 2,
	/** User stated directly. Highest trust — user's own words. */
	user_stated: 3,
} as const;

/** Human-readable labels for trust levels (used in injection output). */
export const TRUST_LEVEL_NAMES: Record<number, string> = {
	0: "llm_extracted",
	1: "llm_suggested",
	2: "agreed_upon",
	3: "user_stated",
};

/**
 * Trust weights for decay calculation. Higher trust = slower decay.
 * Applied as a multiplier on the base decay score.
 *
 *   trust=3 (user_stated)  → ×1.25  (lasts 25% longer)
 *   trust=2 (agreed_upon)  → ×1.00  (baseline)
 *   trust=1 (llm_suggested) → ×0.85  (decays 15% faster)
 *   trust=0 (llm_extracted) → ×0.70  (decays 30% faster)
 */
export const TRUST_DECAY_WEIGHTS: Record<number, number> = {
	0: 0.70,
	1: 0.85,
	2: 1.00,
	3: 1.25,
};

/**
 * Trust weights for contradiction arbitration. When two memories conflict,
 * the one with higher trust wins by default (auto-replace). Equal trust
 * = needs arbitration (ask user or heuristic).
 *
 * Maps trust_level → priority score for sorting.
 */
export const TRUST_PRIORITY: Record<number, number> = {
	0: 10,
	1: 20,
	2: 30,
	3: 40,
};

/**
 * Batch window: consecutive `dream_memory_add` calls within this time
 * share a batch_id. Used for atomic batch-revert.
 */
export const BATCH_WINDOW_MS = 60_000;

// ── Schema discipline: target + category descriptions ────────────────
//
// Inspired by Akshay Pachaar's "Pydantic fixed my Agent's Memory" — the
// insight is that an LLM agent that picks enum values without a vocabulary
// produces generic, low-signal memories. By giving each target/category a
// canonical description with examples, the agent (the LLM) classifies more
// accurately and retrieval becomes more useful.
//
// The descriptions are rendered into the `promptSnippet` of `dream_memory_add`
// via `utils/schema.ts::renderSchemaBlock()`. Keeping them in constants
// (not inlined in the prompt) means adding a new category is a one-line change
// here and the prompt updates automatically.
//
// We follow the Zep 10/10/10 principle (per the article): 4 targets + 6
// categories = 10 types — already at the cap. Resist the urge to add more;
// if a memory doesn't fit any existing type, the closest match + a clear
// `content` is better than introducing a new type that fragments retrieval.

/**
 * Canonical description of each `target` value. The `target` answers
 * "what is this memory ABOUT?" — the entity the memory refers to.
 */
export const TARGET_DESCRIPTIONS: Record<(typeof MEMORY_TARGETS)[number], string> = {
	user: "About the user: their preferences, workflow, style. Use when memory describes WHO the user is or HOW they work — not what the project does.",
	memory: "Meta-memory: notes about the memory system itself, observations about prior recall/synthesis. Rare — mostly agent self-reflection.",
	project: "About the codebase or product: structure, dependencies, architecture, conventions. Use for facts about the code, not the user.",
	failure: "About a specific failure event: what broke, what was tried, the error. Distinct from category=failure — target=failure means SUBJECT is a failure.",
};

/**
 * Canonical description of each `category` value. The `category` answers
 * "what KIND of memory is this?" — the role the memory plays in reasoning.
 *
 * Selection rule (rendered into the prompt): pick the MOST SPECIFIC category
 * that fits. If two seem right, prefer the one that makes retrieval sharper:
 *   - preference > insight (a stated preference is more actionable than a
 *     derived observation)
 *   - failure > tool-quirk (a real failure is more important than a quirk)
 *   - convention > insight (a code convention is a stable fact, not a guess)
 */
export const CATEGORY_DESCRIPTIONS: Record<(typeof MEMORY_CATEGORIES)[number], string> = {
	preference:
		"User choice (e.g., 'prefers dark mode', 'uses vim'). Explicit like/dislike, not derived.",
	convention:
		"Project rule the code follows (e.g., '2-space indent', 'tests next to source'). Stable, reproducible.",
	insight:
		"Derived conclusion connecting prior memories (e.g., 'user prefers X for Y'). For new synthesis, not raw facts.",
	failure:
		"Something broken (e.g., 'skip validation → TypeError on null', 'npm fails on Node 22').",
	correction:
		"How a failure was fixed. Pair with the failure (reason='corrects:<id>').",
	"tool-quirk":
		"Tool behavior that surprised the user (e.g., 'rg --type-add needs tsconfig sibling'). Not broken — just remember.",
	procedure:
		"Multi-step workflow the user follows (e.g., 'write failing test → fix → commit small'). Action-oriented.",
};

/**
 * Edge type vocabulary: which typed relationships are valid between
 * which category pairs. Inspired by the article's source/target
 * constraints (Zep EntityEdgeSourceTarget) — limit the relationship
 * space so the agent doesn't invent generic 'RELATES_TO' edges.
 *
 * Phase 1: heuristic-only, no LLM call. Used to score `metadata.links`
 * entries when comparing two memories for relatedness. Future: drive
 * auto-link edge type inference from this table.
 *
 * Format: key = "fromCategory::toCategory", value = array of valid
 * edge type labels. Order in array = preference (first is most likely).
 */
export const EDGE_TYPE_RULES: Record<string, readonly string[]> = {
	"failure::correction": ["corrects", "caused_by"],
	"correction::failure": ["corrects", "fixes"],
	"insight::preference": ["explains", "derived_from"],
	"insight::convention": ["explains", "derived_from"],
	"insight::failure": ["learned_from", "caused_by"],
	"preference::preference": ["supersedes", "conflicts_with", "related_to"],
	"convention::convention": ["supersedes", "related_to"],
	"failure::failure": ["similar_to", "caused_by"],
	"tool-quirk::tool-quirk": ["similar_to", "related_to"],
};
