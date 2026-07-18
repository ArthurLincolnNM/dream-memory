/**
 * dream-memory — Pi Extension
 *
 * Hybrid memory system combining:
 * - Pi: reactive capture, rich taxonomy
 * - MiMo-Code: Dream consolidation, Distill
 * - hindsight-pi: ephemeral recall
 * - pi-everos-memory: hybrid search, contradiction resolution
 *
 * Features:
 * - Hybrid search (BM25 + IDF + RRF)
 * - Credential sanitization
 * - TTL
 * - Contradiction detection/resolution
 * - Ephemeral recall (stripped after each turn)
 * - Skill distillation from tool usage
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { DreamStore, type Memory, canonicalJsonStringify } from "./store/sqlite.js";
import { BankManager, autoCleanupFiles } from "./store/bank.js";
import { loadConfig } from "./utils/config.js";
import { Observability } from "./utils/observability.js";
import { formatBytes, truncateForPreview, formatRelativeAge } from "./utils/format.js";
import { MEMORY_TARGETS, MEMORY_SCOPES, MEMORY_CATEGORIES, MEMORY_STATUSES, MEMORY_SOURCE_TYPES, BATCH_WINDOW_MS, EDGE_TYPE_RULES, TRUST_LEVEL_NAMES } from "./utils/constants.js";
import { detectSourceType, extractEntities } from "./utils/detect.js";
import { sanitizeCredentials } from "./sanitize/credentials.js";
import { normalizeTemporalReferences } from "./sanitize/temporal.js";
import { resolveCoreferences } from "./sanitize/coreference.js";
import { resolveScope } from "./scope/resolver.js";
import { inferTTL, TTL_CLASSES } from "./ttl/manager.js";
import { calculateDecay } from "./ttl/decay.js";
import { detectContradictions } from "./contradiction/detector.js";
import { resolveContradiction, applyResolution } from "./contradiction/resolver.js";
import { embed as embedText, vectorToBytes, primeQueryEmbedding } from "./embeddings/embed.js";
import { scopedSearch, invalidateRecallCache, type SearchResult } from "./search/hybrid.js";
import { deriveRecallQuery, isMetaMemoryQuery } from "./recall/query.js";
import { formatRecallForInjection } from "./recall/inject.js";
import { stripRecallFromContent, hasRecallContent, isCurrentTurnRecall } from "./recall/strip.js";
import { trackToolCall, getUsagePatterns, analyzePatterns } from "./distill/trajectory.js";
import { saveSkill, skillExists } from "./distill/skill-gen.js";
import { parseInstructions } from "./dream/instructions.js";
import { findSynthesisCandidates, applySynthesis, reclusterStaleSyntheses, garbageCollectStaleMemories } from "./dream/synthesis.js";
import { acquireLock, releaseLock, getLockStatus, isDreamRunning } from "./dream/lock.js";
import { evaluateMemory } from "./capture/evaluate.js";
import { detectToolSignals, saveSignal, DEFAULT_CAPTURE_CONFIG } from "./capture/signals.js";
import { detectCorrectionPattern, DEFAULT_CORRECTION_CONFIG } from "./capture/corrections.js";
import { indexSessions } from "./sessions/indexer.js";
import { searchSessionMessages, getSessionIndexStats } from "./sessions/search.js";
import { renderSchemaBlock } from "./utils/schema.js";

// ── F4: Topic Key — stable key generation for upsert ──────────────────────
//
// Same inputs → same key → enables upsert (update instead of duplicate).
function generateTopicKey(category: string | undefined, tags: string[]): string {
	const cat = (category ?? "unknown").toLowerCase();
	const sortedTags = tags
		.map(t => t.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
		.sort()
		.slice(0, 3);
	return sortedTags.length > 0 ? `${cat}:${sortedTags.join(":")}` : `${cat}:general`;
}

// ── Gap #3: Active forgetting (top-level helper for testability) ─────────────
//
// Tracks per-memory consecutive tool-failure count. After threshold
// consecutive failures, an extra penalty is applied (on top of the
// per-failure F3 penalty). F3 success resets the counter to 0.
//
// Why per-memory, not per-cluster: a memory in recall + tool failed = bad
// signal for THAT memory, regardless of other recalled memories.
// Coarse-grained penalties (e.g., all recalled memories get chronic
// penalty) over-penalize.
//
// In-memory state (missCount): lost on restart, but the utility penalty
// persists. This is the right trade-off: we want chronic-noise detection
// to work across tool calls within a session, but we don't need it to
// persist across sessions (a memory that was chronically noisy yesterday
// might be perfectly useful today).
export function applyActiveForgetting(
	memIds: string[],
	success: boolean,
	missCount: Map<string, number>,
	stores: { global: DreamStore; project: DreamStore | null },
	options: { threshold: number; penalty: number },
): void {
	if (memIds.length === 0) return;

	if (success) {
		// F3 boost already applied; reset miss counts to 0.
		for (const id of memIds) {
			missCount.delete(id);
		}
		return;
	}

	// F3 penalty already applied; increment miss counts and apply chronic
	// penalty when threshold is hit.
	for (const id of memIds) {
		const misses = (missCount.get(id) ?? 0) + 1;
		if (misses >= options.threshold) {
			try {
				const probe = stores.global.getMemory(id) ||
					(stores.project?.getMemory(id) ?? null);
				const store = probe
					? probe.scope === "project" && stores.project
						? stores.project
						: stores.global
					: stores.global;
				store.adjustUtility(id, options.penalty);
				missCount.set(id, 0);
			} catch {
				// Memory deleted between recall and now — ignore.
			}
		} else {
			missCount.set(id, misses);
		}
	}
}

// Phase 1: session_start snapshot helper.
//
// Returns a focused one-time snapshot of top user-target memories
// (preferences, conventions, system specs) for injection at session
// open. Distinct from per-turn recall (query-driven via
// before_agent_start): this is "what does the system know about
// the user, surfaced once at start".
//
// Capped at 5 memories. Sorted by score DESC. Returns null when the
// DB has nothing relevant so the caller can skip the UI notify.
//
// Read-time, no LLM, no DB writes. Testable: takes the store directly.
// (SearchResult already imported from "./search/hybrid.js" at line 41.)

export const SNAPSHOT_TOP_K = 5;

export interface SnapshotResult {
	results: SearchResult[];
	counts: { preferences: number; conventions: number; systemSpecs: number };
}

export function getSessionSnapshot(stores: {
	global: import("./store/sqlite.js").DreamStore;
	project: import("./store/sqlite.js").DreamStore | null;
}): SnapshotResult | null {
	const { global, project } = stores;
	const merged: SearchResult[] = [];
	// listMemories (not searchByQuery) so empty query still returns all.
	// The list is unsorted; we sort by score DESC after merging.
	const collectFrom = (store: import("./store/sqlite.js").DreamStore) => {
		const rows = store.listMemories({ target: "user", status: "active", limit: 50 });
		for (const m of rows) {
			merged.push({ memory: m, score: m.utility_score ?? 0, snippet: m.content.slice(0, 200) });
		}
	};
	collectFrom(global);
	if (project) collectFrom(project);

	if (merged.length === 0) return null;

	const seen = new Set<string>();
	merged.sort((a, b) => b.score - a.score);
	const top: SearchResult[] = [];
	for (const r of merged) {
		if (seen.has(r.memory.id)) continue;
		seen.add(r.memory.id);
		top.push(r);
		if (top.length >= SNAPSHOT_TOP_K) break;
	}

	const counts = { preferences: 0, conventions: 0, systemSpecs: 0 };
	for (const r of top) {
		if (r.memory.category === "preference") counts.preferences++;
		else if (r.memory.category === "convention") counts.conventions++;
		else if (r.memory.target === "user" && r.memory.category === "tool-quirk") counts.systemSpecs++;
	}
	return { results: top, counts };
}

// Phase 2: session_shutdown breadcrumb helper.
//
// Saves a session-scoped memory with metadata about what was recalled
// during the session. Audit trail, not for agent recall. Scope=session
// means it's auto-cleaned at the next session_end (existing cleanup
// loop deletes all session-scope memories for the closing session).
//
// Off by default (config.recall.saveBreadcrumbs). When off, no memory
// is written. When on, one memory per session.
//
// Returns the breadcrumb memory id (or null if no memories surfaced
// or saveBreadcrumbs is disabled). Read-time only.
export function saveSessionBreadcrumb(
	store: import("./store/sqlite.js").DreamStore,
	sessionId: string,
	surfacedIds: string[],
	enabled: boolean,
): string | null {
	if (!enabled) return null;
	if (surfacedIds.length === 0) return null;

	const shortId = sessionId.slice(0, 8);
	const mem = store.createMemory({
		content: `Session ${shortId}: surfaced ${surfacedIds.length} memor${surfacedIds.length === 1 ? "y" : "ies"} (${surfacedIds.slice(0, 3).join(", ")}${surfacedIds.length > 3 ? "…" : ""})`,
		scope: "session",
		scope_id: sessionId,
		target: "user",
		category: "convention",
		tier: "operational",
		ttl_days: 1, // session-scoped, auto-cleanup at next session_end
		confidence: "explicit",
		memory_kind: "semantic",
		metadata: {
			session_summary: true,
			surfaced_count: surfacedIds.length,
			surfaced_ids: surfacedIds,
			ended_at: Date.now(),
		},
	});
	return mem.id;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	if (!config.enabled) {
		return;
	}

	// Initialize bank manager
	const bankManager = new BankManager({
		strategy: "per-repo",
		basePath: config.storage.path.replace(/\.db$/, ""),
	});
	const observability = new Observability();

	// Helper to get stores (global + project)
	function getStores(cwd: string): { global: DreamStore; project: DreamStore | null; projectId: string | null } {
		return bankManager.getStores({ cwd });
	}

	// Helper to resolve store for a specific scope
	function getStoreForScope(scope: string, cwd: string): DreamStore {
		const { store } = bankManager.resolveStoreForScope(scope, cwd);
		return store;
	}

	// Track last recall for stripping
	let lastRecallContent: string | null = null;
	// Memory IDs that were in the last recall (F3 — utility feedback). The
	// next tool_execution_end will boost each by +0.05 if the tool ran
	// without error (implicit positive signal: the agent's advice was
	// useful enough to act on). Cleared on each before_agent_start.
	let lastRecalledMemoryIds: string[] = [];
	// Gap #3 active forgetting: per-memory consecutive tool-failure count.
	// When a memory is in recall and the next tool call FAILS, we increment
	// the miss count for that memory. After ACTIVE_FORGETTING_THRESHOLD
	// consecutive failures, an extra penalty is applied (on top of the
	// per-failure F3 penalty). Reset on F3 boost (success). The Map is
	// in-memory: lost on restart, but the utility penalty persists. This
	// captures the "chronic noise" signal that pure F3 misses — a memory
	// that's in recall 5 times in a row during failing tool calls is
	// almost certainly irrelevant (or worse: misleading the agent).
	let recallMissCount = new Map<string, number>();
	const ACTIVE_FORGETTING_THRESHOLD = 5;
	const ACTIVE_FORGETTING_PENALTY = -0.05;
	let currentSessionId: string | null = null;
	// Correction detection state: track last agent tool to provide context
	// when the user corrects the agent in the next turn.
	let lastAgentToolName: string | null = null;
	let lastAgentToolSuccess: boolean | null = null;
	// v1.6 provenance: 1-indexed turn counter within the current session.
	// Incremented at the start of every `before_agent_start` (one per user
	// input). Reset on session_start. Used to populate `source_turn_id` when
	// a memory is created so the agent can later cite "session X, turn Y".
	// Stays 0 outside a session (e.g., during the brief window between
	// extension load and the first session_start) — memories created in that
	// window get turn=0, which is fine: it's a valid reference value.
	let currentTurnCounter: number = 0;

	// Batch tracking: consecutive `dream_memory_add` calls within BATCH_WINDOW_MS
	// share a batchId. Used for atomic batch-revert via `dream_memory_rollback --batch_id`.
	let currentBatchId: string | null = null;
	let lastAddTime: number = 0;
	let currentDreamSession: {
		globalOutputBankId: string;
		projectOutputBankId: string | null;
		projectId: string | null;
	} | null = null;

	// Helper: format bytes for display
	// (formatBytes is imported from utils/format.js — extracted for testability)

	// Best-effort extraction of an error message from a tool result block.
	// Pi tool results are typically { content: [{type: "text", text: "..."}] }.
	// We only return the first 200 chars (matching store.trackToolUsage's
	// error_preview limit). Returns undefined if no readable text is found.
	function extractErrorPreview(result: any): string | undefined {
		try {
			if (!result) return undefined;
			// Direct text field
			if (typeof result === "string") return result.slice(0, 200);
			// Content block array
			if (Array.isArray(result.content)) {
				const text = result.content
					.filter((b: any) => b && typeof b === "object" && typeof b.text === "string")
					.map((b: any) => b.text)
					.join("\n")
					.trim();
				return text ? text.slice(0, 200) : undefined;
			}
			// Single text field
			if (typeof result.text === "string") return result.text.slice(0, 200);
			return undefined;
		} catch (err: any) {
			// Best-effort: a malformed tool result shape is a Pi/runtime issue,
			// not a dream-memory bug. Log under DREAM_DEBUG so the user can
			// diagnose without spamming prod logs. Without this, the swallow
			// silently hid failures of the error_preview capture path.
			if (process.env.DREAM_DEBUG) {
				console.warn(`[dream] extractErrorPreview failed: ${err.message}`);
			}
			return undefined;
		}
	}

	// Helper: should auto-dream trigger now?
	// Conditions (from Anthropic Auto Dream):
	//   1. intervalDays have passed since last run
	//   2. ≥5 sessions have occurred since last run
	//   3. project is old enough (minProjectAgeDays)
	function shouldAutoDream(
		meta: { lastRunAt: number | null; sessionsSince: number; createdAt: number; toolCallsSinceLastDream?: number },
		dreamCfg: { intervalDays: number; minProjectAgeDays: number; toolCallThreshold?: number },
	): { trigger: boolean; reason: string } {
		const projectAgeDays = (Date.now() - meta.createdAt) / (1000 * 60 * 60 * 24);
		if (projectAgeDays < dreamCfg.minProjectAgeDays) {
			return { trigger: false, reason: `project too young (${projectAgeDays.toFixed(1)}d < ${dreamCfg.minProjectAgeDays}d)` };
		}

		const elapsedSinceLast = meta.lastRunAt
			? (Date.now() - meta.lastRunAt) / (1000 * 60 * 60 * 24)
			: Infinity;
		if (elapsedSinceLast < dreamCfg.intervalDays) {
			return { trigger: false, reason: `last run ${elapsedSinceLast.toFixed(1)}d ago (need ${dreamCfg.intervalDays}d)` };
		}

		if (meta.sessionsSince < 5) {
			return { trigger: false, reason: `only ${meta.sessionsSince} sessions since last dream (need 5)` };
		}

		// Tool-call threshold: trigger if enough tool calls accumulated since last dream.
		// This catches heavy work sessions where many tools are used but few sessions pass.
		if (dreamCfg.toolCallThreshold && dreamCfg.toolCallThreshold > 0) {
			const toolCalls = meta.toolCallsSinceLastDream ?? 0;
			if (toolCalls >= dreamCfg.toolCallThreshold) {
				return { trigger: true, reason: `${toolCalls} tool calls since last dream (threshold: ${dreamCfg.toolCallThreshold})` };
			}
		}

		return { trigger: true, reason: "all conditions met" };
	}

	// ── Session Lifecycle ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		// Reset turn counter: every new session starts at turn 0, and the
		// first before_agent_start will bump it to 1. This matches the
		// "1-indexed turn" contract documented on currentTurnCounter.
		currentTurnCounter = 0;
		const { global, project } = getStores(ctx.cwd);

		// Enforce TTL on both stores
		if (config.ttl.enabled) {
			const expiredGlobal = global.deleteExpiredMemories();
			let expiredProject = 0;
			if (project) {
				expiredProject = project.deleteExpiredMemories();
			}
			const totalExpired = expiredGlobal + expiredProject;
			if (totalExpired > 0) {
				ctx.ui.notify(`Dream Memory: ${totalExpired} expired memories removed`, "info");
			}
		}

		// Prune accumulated data (addresses 30GB DB bloat bug)
		// session_messages: toolResult avg 3.3KB, accumulates from every indexed session
		// tool_usage: every tool call writes a row, never cleaned up
		// memory_versions: every mutation creates a version, never pruned
		try {
			const prunedSessions = global.pruneSessionMessages(30);
			const prunedTools = global.pruneToolUsage(30);
			const prunedVersions = global.pruneOldVersions(10);
			let projectPrunedSessions = 0;
			let projectPrunedTools = 0;
			if (project) {
				projectPrunedSessions = project.pruneSessionMessages(30);
				projectPrunedTools = project.pruneToolUsage(30);
			}
			const totalPruned = prunedSessions + prunedTools + prunedVersions + projectPrunedSessions + projectPrunedTools;
			if (totalPruned > 0) {
				const parts: string[] = [];
				if (prunedSessions + projectPrunedSessions > 0) parts.push(`${prunedSessions + projectPrunedSessions} session messages`);
				if (prunedTools + projectPrunedTools > 0) parts.push(`${prunedTools + projectPrunedTools} tool usage`);
				if (prunedVersions > 0) parts.push(`${prunedVersions} old versions`);
				ctx.ui.notify(`Dream Memory: pruned ${parts.join(", ")}`, "info");
			}
		} catch (err: any) {
			// Pruning is best-effort — never block session_start
			console.warn("[dream-memory] pruning failed:", err.message);
		}

		// Migrate memories that ended up in the wrong store due to bugs
		// fixed in the Phase 1 audit (saveSignal hardcoding global, synthesis
		// hardcoding scope=global). Idempotent — safe to run on every boot.
		// Skips the current project to avoid touching live data.
		try {
			const migration = bankManager.migratePollutedMemories(ctx.cwd);
			const totalFixed = migration.movedToGlobal + migration.convertedToGlobal;
			if (totalFixed > 0) {
				ctx.ui.notify(
					`Dream Memory: migration fixed ${migration.movedToGlobal} misplaced + ${migration.convertedToGlobal} downgraded`,
					"info",
				);
			}
			if (migration.errors.length > 0) {
				console.warn("[dream-memory] migration errors:", migration.errors);
			}
		} catch (err: any) {
			// Migration is best-effort — never block session_start on it
			console.warn("[dream-memory] migration failed:", err.message);
		}

		// Auto-cleanup old files (archived backups, pending output stores, orphaned WAL/SHM).
		// Silent unless something was actually deleted. The user can run /dream-cleanup
		// for an interactive preview at any time.
		if (config.cleanup.enabled) {
			const cleanupResult = autoCleanupFiles(
				bankManager.getBasePath(),
				{ maxAgeMs: config.cleanup.maxAgeMs },
				project ? bankManager.resolveProjectId(ctx.cwd) : null,
				currentDreamSession,
			);
			if (cleanupResult.deleted > 0) {
				ctx.ui.notify(
					`Dream Memory: cleanup removed ${cleanupResult.deleted} old file(s) (${formatBytes(cleanupResult.bytesReclaimed)})`,
					"info",
				);
			}
		}

		// Phase 1: session_start snapshot. One-time read of top user-target
		// memories (preferences, conventions, system specs). Opt-in via
		// config.recall.snapshotEnabled. Logged via UI notify so the user
		// knows the snapshot fired; not injected into context (that would
		// require cross-cutting changes to the recall injection path).
		if (config.recall.snapshotEnabled !== false) {
			const snapshot = getSessionSnapshot({ global, project });
			if (snapshot) {
				ctx.ui.notify(
					`Dream Memory snapshot: ${snapshot.results.length} memories loaded (${snapshot.counts.preferences} pref, ${snapshot.counts.conventions} conv)`,
					"info",
				);
			}
		}

		// Auto-dream: increment sessions counter and check trigger conditions
		// Disabled by setting `dream.autoEnabled: false` in config
		const autoEnabled = (config.dream as any).autoEnabled !== false;
		if (autoEnabled) {
			const sessionsSince = global.incrementSessionsSinceDream();
			const meta = global.getDreamMeta();
			const toolCalls = global.getToolCallsSinceLastDream();
			const decision = shouldAutoDream({ ...meta, toolCallsSinceLastDream: toolCalls }, config.dream);

			if (decision.trigger) {
				// Don't trigger if another dream is already running (concurrent protection)
				if (isDreamRunning(bankManager.getBasePath())) {
					ctx.ui.notify("Dream Memory: auto-dream skipped (another dream is running)", "info");
				} else {
					ctx.ui.notify(
						`Dream Memory: auto-dream triggered (${meta.sessionsSince} sessions, ${meta.lastRunAt ? ((Date.now() - meta.lastRunAt) / 86400000).toFixed(1) + 'd' : 'no previous run'})`,
						"info",
					);
					// Fire-and-forget. The previous implementation `await`ed runDream
					// here, which blocked session_start (and the user-facing UI) for
					// as long as the dream took — usually several seconds, occasionally
					// much longer if the project has a lot of memories. The user sees
					// Pi hang at session open and blames the extension. The fix:
					// schedule the dream on a microtask so session_start returns
					// immediately, and the dream runs in the background while the
					// user starts their first turn. Errors are still surfaced via
					// notify (caught inside runDream and re-thrown, OR propagated via
					// the .catch handler below).
					void runDream({
						type: "auto",
						args: "",
						ctx,
						requireConfirm: false,
						skipPreviews: true,
						mode: "delta", // F4: auto-dream always uses delta to stay cheap
					}).catch((err: any) => {
						ctx.ui.notify(`Dream Memory: auto-dream failed: ${err.message}`, "warning");
					});
				}
			}
		}

		// Background session indexing: index JSONL session files for FTS5 search.
		// Fire-and-forget to avoid blocking session_start.
		try {
			const { global } = getStores(ctx.cwd);
			const db = (global as any).db;
			void indexSessions(db).then(result => {
				if (result.filesProcessed > 0) {
					console.log(`[dream-memory] indexed ${result.filesProcessed} session file(s) (${result.messagesIndexed} messages)`);
				}
			}).catch(err => {
				if (process.env.DREAM_DEBUG) {
					console.error("[dream-memory] session index error:", err.message);
				}
			});
		} catch {
			// Non-critical: session indexing is best-effort
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Get stores for the shutdown cleanup. The `global` and `project` are
		// used below to delete session-scoped memories.
		const { global, project } = getStores(ctx.cwd);

		// Reset module-level state to prevent leakage across sessions.
		// Without this, the next session inherits:
		//  - toolArgsMap: stale toolCallId entries (memory leak)
		//  - currentDreamSession: a dream session whose output DB may have been
		//    cleaned up, causing /dream-accept to fail or target wrong files
		//  - currentBatchId: new adds join a "finished" batch
		//  - lastRecallContent: stale injection from prior session
		//  - lastAddTime: spurious batch window matching
		// clearAllToolArgs already clears both toolArgsMap and toolArgsTimers,
		// so the explicit toolArgsMap.clear() above was redundant. Keep the
		// one call site for clarity.
		clearAllToolArgs();
		currentDreamSession = null;
		currentBatchId = null;
		lastAddTime = 0;
		lastRecallContent = null;

		// Capture the session id BEFORE nulling — the cleanup loop below uses it
		// to find this session's memories. The previous order (null first, then
		// compare against `currentSessionId`) made the cleanup a silent no-op:
		// every `mem.scope_id === currentSessionId` check evaluated `mem.scope_id === null`
		// and never matched. Session-scoped memories leaked until TTL (1d) expired.
		const sessionIdToClean = currentSessionId;
		currentSessionId = null;

		// Phase 2: session_shutdown breadcrumb (opt-in). Saves a
		// session-scoped memory with surfaced-ids metadata. Useful as
		// audit trail ("what did the agent know during this session?").
		// Off by default; enabled via config.recall.saveBreadcrumbs.
		if (sessionIdToClean) {
			const breadcrumbId = saveSessionBreadcrumb(
				global,
				sessionIdToClean,
				lastRecalledMemoryIds,
				config.recall.saveBreadcrumbs === true,
			);
			if (breadcrumbId) {
				ctx.ui.notify(
					`Dream Memory: saved session breadcrumb (${lastRecalledMemoryIds.length} memories surfaced)`,
					"info",
				);
			}
		}

		// Clean up session-scoped memories for THIS session only
		// (they shouldn't persist beyond their own session)
		let totalCleaned = 0;

		// Clean global store
		const globalSessionMems = global.listMemories({
			scope: "session",
			limit: 1000,
		});
		for (const mem of globalSessionMems) {
			if (mem.scope_id === sessionIdToClean) {
				global.deleteMemory(mem.id);
				totalCleaned++;
			}
		}

		// Clean project store (if exists)
		if (project) {
			const projectSessionMems = project.listMemories({
				scope: "session",
				limit: 1000,
			});
			for (const mem of projectSessionMems) {
				if (mem.scope_id === sessionIdToClean) {
					project.deleteMemory(mem.id);
					totalCleaned++;
				}
			}
		}

		if (totalCleaned > 0) {
			ctx.ui.notify(`Dream Memory: cleaned ${totalCleaned} session-scoped memories`, "info");
		}
	});

	// ── Recall: Inject per turn ──────────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		const userInput = event.prompt;
		if (!userInput) return;

		// --- Correction detection ---
		// Check if user is correcting the agent. Only strong patterns auto-save;
		// weak patterns are logged but not persisted to avoid noise.
		if (typeof userInput === "string") {
			const correction = detectCorrectionPattern(userInput);
			if (correction && correction.strength === "strong") {
				const stores = getStores(ctx.cwd);
				try {
					stores.global.createMemory({
						content: correction.suggestedContent,
						scope: "global",
						target: "user",
						category: "correction",
						tier: "operational",
						ttl_days: 90,
						confidence: "inferred",
						// v2.0: auto-captured corrections get lowest trust
						trust_level: 0,
						memory_kind: "episodic",
						metadata: {
							source: "auto-capture:correction",
							sourceType: "conversation",
							strength: correction.strength,
							matchedPattern: correction.matchedPattern,
							context: {
								lastTool: lastAgentToolName,
								lastToolSuccess: lastAgentToolSuccess,
							},
						},
					});
				} catch {
					// Non-critical: don't break the session if save fails
				}
			}
		}

		// Bump turn counter BEFORE any recall/add work so the value is
		// stable for the rest of this turn. The first turn of a session
		// is turn 1, second is turn 2, etc. Sync code can read it without
		// race conditions.
		currentTurnCounter += 1;

		// Type guard: deriveRecallQuery requires a string. Multimodal Pi events
		// can pass arrays/objects as `event.prompt`; without this guard, the
		// async handler would throw and silently break every recall turn.
		if (typeof userInput !== "string") return;

		// Derive recall query
		const query = deriveRecallQuery(userInput);
		if (!query) return;

		// Pre-recall on verbatim (un-cleaned) user input. The cleaned
		// `query` above runs through deriveRecallQuery which strips markdown,
		// removes URLs, expands synonyms, and lowercases — useful for
		// semantic matches but destructive for literal precision. A user
		// typing "Error 0x4A2 in Lumio Hub v2 firmware 3.2.1" needs the
		// raw form to find that exact fact in the index.
		//
		// We cap verbatim at topK=3 because the goal is rescue for literal
		// matches, not the main recall pipeline. R1 dedup below will
		// remove verbatim/cleaned overlaps, R3 stale flag still applies,
		// R6 cap still bounds the final output.
		const stores = getStores(ctx.cwd);
		const { global, project } = stores;
		const verbatim = userInput.trim();
		let verbatimResults: SearchResult[] = [];
		if (verbatim && verbatim.length >= 5) {
			verbatimResults = scopedSearch(stores, verbatim, { topK: 3 });
		}

		// Pre-warm the query embedding for semantic re-rank. Non-blocking:
		// primeQueryEmbedding fires an async embed and stores the result in
		// a module-level cache. The first turn with a new query runs BM25
		// only; subsequent turns with the same query (or a query sharing
		// exact-text overlap, since we cache by exact normalized text) get
		// the semantic layer for free. This keeps the hot path at ~0ms
		// added latency while building up the cache organically.
		primeQueryEmbedding(query);

		// Skip meta-memory queries (prevent feedback loop)
		if (isMetaMemoryQuery(query)) return;

		// Search memories in both global and project stores
		const startTime = Date.now();

		let results = scopedSearch(stores, query, {
			// No topK: adaptive retrieval classifies query complexity
			// and sets depth dynamically (3 for simple, 15 for complex).
		});

		const latencyMs = Date.now() - startTime;

		// Merge verbatim hits with cleaned-query hits. Verbatim goes
		// first (literal match wins); cleaned follows (semantic recall).
		// R1 dedup downstream removes duplicates. R3 stale flag still
		// applies. R6 cap still bounds the final output.
		if (verbatimResults.length > 0) {
			const seen = new Set<string>(results.map((r) => r.memory.id));
			results = [
				...verbatimResults.filter((r) => {
					if (seen.has(r.memory.id)) return false;
					seen.add(r.memory.id);
					return true;
				}),
				...results,
			];
		}

		// Record metrics
		observability.recordRecall({
			query,
			resultCount: results.length,
			latencyMs,
			success: results.length > 0,
		});
		observability.recordSearchLatency(latencyMs);

		if (results.length === 0) return;

		// Track access in the store that actually holds the memory.
		// resolveStoreForScope maps global/agent/session -> global.db and
		// project -> project store. The previous ternary only handled
		// scope === "global" explicitly, so agent/session memories in a
		// cwd-without-project were silently skipped (trackAccess never
		// called) — their access_count never incremented and decay degraded
		// them out of recall.
		for (const r of results) {
			const target = r.memory.scope === "project" && project ? project : global;
			target.trackAccess(r.memory.id);
		}

		// Load always_inject memories (system specs, hard preferences) and
		// prepend to the results. These bypass BM25 and the score floor so
		// the agent always has critical context. Dedupe against `results`
		// to avoid injecting the same memory twice if it also matched the
		// search query — duplicates waste tokens and confuse the model.
		//
		// The score=100 + decay*1 puts them at the top of any sort. The
		// formatRecallForInjection budget is shared; in practice the
		// always_inject list is short and curated (1-3 memories), so they
		// get rendered before the BM25 results and stay within the cap.
		const alwaysInject = [
			...global.findAlwaysInject(),
			...(project ? project.findAlwaysInject() : []),
		];
		const seenIds = new Set(results.map((r) => r.memory.id));
		const pinnedResults = alwaysInject
			.filter((m) => !seenIds.has(m.id))
			.map((m) => ({
				memory: m,
				// score above any realistic BM25 value. Combined with decay
				// ~0.95 (fresh memory), this puts pinned results firmly at
				// the top of the result list after formatRecallForInjection's
				// sort. MIN_SCORE filter (0.1) is bypassed naturally because
				// the score is way above the floor.
				score: 100,
				snippet: m.content,
				anchorToken: undefined,
				isAlwaysInject: true,
			}));
		if (pinnedResults.length > 0) {
			results = [...pinnedResults, ...results];
		}

		// Format for injection
		const recallContent = formatRecallForInjection(results, {
			maxTokens: config.recall.maxTokens,
			format: "xml",
			// R6: per-category cap (opt-in via config.recall.categoryCaps).
			categoryCaps: config.recall.categoryCaps,
			// Gap #1: opt-in relevance gate. Detects intent from the user
			// query and re-ranks memories of the matching category. Heuristic
			// only — no LLM, no latency, no behavior change if not provided.
			query: userInput,
		});

		// If search returned rows but injection returned an empty string,
		// the score/decay filter inside formatRecallForInjection dropped
		// them all. Common with tiny corpora (< 10 memories) where BM25
		// returns 0 scores — a debugging signal that the heuristic
		// is firing but the filter is too strict for this corpus size.
		if (!recallContent) {
			if (results.length > 0 && process.env.DREAM_DEBUG) {
				console.warn(
					`[dream] recall dropped ${results.length} result(s) — score/decay filter below threshold. ` +
						`Try lowering config.recall.maxTokens threshold or add more memories.`,
				);
			}
			return;
		}

		lastRecallContent = recallContent;
		// F3: capture which memories were injected so the next tool call
		// can apply a positive utility boost. We snapshot the IDs here
		// (not in tool_execution_end) so the boost is bound to the recall
		// that immediately preceded the tool call, not any earlier recall.
		lastRecalledMemoryIds = results.map((r) => r.memory.id);

		return {
			message: {
				customType: "dream-recall",
				content: recallContent,
				display: false, // Don't show in TUI
			},
		};
	});

	// ── Strip recall before next turn ────────────────────────────────────

	pi.on("context", async (event, ctx) => {
		if (!config.recall.stripOnNextTurn) return;

		// Strip OLD recall from messages (recall is injected as customType "dream-recall").
		// The current turn's recall must NOT be stripped — Pi's `context` event fires
		// AFTER `before_agent_start` (where we inject recall) but BEFORE the LLM call.
		// Stripping unconditionally would remove the recall before the model ever sees it,
		// silently breaking the entire auto-recall feature. We identify the current
		// turn's recall by content match against `lastRecallContent` (set when we
		// inject). Edge case: if the same query produces identical recall content in
		// consecutive turns, we'd skip both — but content includes timestamps/scores
		// that make exact repeats vanishingly rare, and skipping a true repeat is
		// harmless (same effect as the LLM seeing it once).
		if (event.messages) {
			for (const msg of event.messages) {
				if (msg.role === "custom" && (msg as any).customType === "dream-recall") {
					if (isCurrentTurnRecall(msg, lastRecallContent)) {
						// This is the recall we just injected this turn — leave it intact
						// so the LLM can read it.
						continue;
					}
					if (typeof msg.content === "string") {
						msg.content = stripRecallFromContent(msg.content);
					} else if (Array.isArray(msg.content)) {
						// Recurse into each text block; preserve non-text blocks (images, etc.)
						// The `in` narrowing handles Pi's TextContent | ImageContent union
						// (ImageContent has no `text` field, so the guard skips it).
						for (const block of msg.content) {
							if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
								block.text = stripRecallFromContent(block.text);
							}
						}
					}
				}
			}
		}
	});

	// ── Tool Tracking ────────────────────────────────────────────────────

	// Compute batchId for the current add (auto-batches consecutive adds within BATCH_WINDOW_MS)
	function getOrCreateBatchId(explicitBatchId?: string): string {
		if (explicitBatchId) {
			// Explicit override: use it and reset the auto-batching state
			currentBatchId = explicitBatchId;
			lastAddTime = Date.now();
			return explicitBatchId;
		}

		const now = Date.now();
		if (currentBatchId && (now - lastAddTime) < BATCH_WINDOW_MS) {
			// Reuse current batch
			lastAddTime = now;
			return currentBatchId;
		}

		// Start new batch
		currentBatchId = randomUUID();
		lastAddTime = now;
		return currentBatchId;
	}

	// Map to store tool args by toolCallId (since args are only available in start event).
	// Includes a per-entry TTL reaper so that if a START is received without a matching
	// END (tool killed, upstream timeout, pi skipped the END event), the entry is
	// released after TOOL_ARGS_TTL_MS. This prevents unbounded growth across long
	// sessions and over many sessions without explicit cleanup.
	const toolArgsMap = new Map<string, any>();
	const toolArgsTimers = new Map<string, NodeJS.Timeout>();
	const TOOL_ARGS_TTL_MS = 60_000; // 60s — most tools finish in seconds

	function setToolArgs(toolCallId: string, args: any): void {
		toolArgsMap.set(toolCallId, args);
		// Cancel any previous timer for this id (defensive)
		const prev = toolArgsTimers.get(toolCallId);
		if (prev) clearTimeout(prev);
		// Schedule reap
		const timer = setTimeout(() => {
			toolArgsMap.delete(toolCallId);
			toolArgsTimers.delete(toolCallId);
		}, TOOL_ARGS_TTL_MS);
		// Don't keep the event loop alive just for the reap
		if (typeof timer.unref === "function") timer.unref();
		toolArgsTimers.set(toolCallId, timer);
	}

	function clearToolArgs(toolCallId: string): void {
		const timer = toolArgsTimers.get(toolCallId);
		if (timer) {
			clearTimeout(timer);
			toolArgsTimers.delete(toolCallId);
		}
		toolArgsMap.delete(toolCallId);
	}

	function clearAllToolArgs(): void {
		for (const t of toolArgsTimers.values()) clearTimeout(t);
		toolArgsTimers.clear();
		toolArgsMap.clear();
	}

	pi.on("tool_execution_start", async (event, _ctx) => {
		// Capture args at start (only available here)
		setToolArgs(event.toolCallId, event.args || {});
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		// Track tool usage for distill (always in global store)
		const { global } = getStores(ctx.cwd);
		const args = toolArgsMap.get(event.toolCallId) || {};
		clearToolArgs(event.toolCallId); // Clean up (cancels TTL reaper)

		// Type guard for isError: `!event.isError` treats undefined as success.
		// Track with explicit boolean: false=failed, true=succeeded, null=unknown.
		// Auto-capture only consumes records with boolean success.
		const success: boolean | null =
			typeof event.isError === "boolean"
				? !event.isError
				: null;

		// Capture an error preview if the tool failed. We pass it through
		// `trackToolCall` so the tool_usage.error_preview column is populated
		// for failure-pattern detection. We only have the error message when
		// the tool result includes it — for pi, that's typically on the
		// `tool_execution_end` event as a `result` field with a content array.
		const errorPreview = event.isError
			? extractErrorPreview((event as any).result) ?? `${event.toolName} failed`
			: undefined;

		trackToolCall(global, {
			tool: event.toolName,
			args,
			success,
			sessionId: currentSessionId || undefined,
			errorPreview,
		});

		// Track last agent activity for correction detection
		lastAgentToolName = event.toolName;
		lastAgentToolSuccess = success;

		// F3: positive utility feedback. If the tool call succeeded and
		// there were recalled memories, boost each by +0.05 — implicit
		// signal that the agent's recall-influenced advice was useful
		// enough to act on. Cap at utility=1.0 (enforced by adjustUtility).
		// We only boost on success because a failed tool call may indicate
		// the recalled advice was wrong or stale.
		//
		// Snapshot for Gap #3 active forgetting: capture the IDs that
		// went through F3 BEFORE they're cleared, so the active-forgetting
		// block below can track miss counts.
		const f3TargetIds = [...lastRecalledMemoryIds];
		if (success === true && f3TargetIds.length > 0) {
			for (const memId of f3TargetIds) {
				try {
					// The memory could be in global OR project store. Probe
					// both — using `global` only would miss project-scoped
					// pinned memories.
					const probe = global.getMemory(memId) ||
						(getStores(ctx.cwd).project?.getMemory(memId) ?? null);
					const store = probe ? (
						probe.scope === "project" && getStores(ctx.cwd).project
							? getStores(ctx.cwd).project!
							: global
					) : global;
					store.adjustUtility(memId, 0.05);
				} catch {
					// Memory was deleted between recall and now — ignore.
				}
			}
			// Clear so the same recall doesn't double-boost if multiple
			// tool calls happen in the same turn (e.g., parallel agents).
			lastRecalledMemoryIds = [];
		} else if (success === false && f3TargetIds.length > 0) {
			// Soft penalty on failure: -0.02. Stronger penalty would over-
			// punish — a single failed tool call often has nothing to do
			// with the recalled memories (e.g., user typo, network blip).
			// The -0.10 penalty is reserved for explicit contradictions
			// (see dream_memory_add discard path).
			for (const memId of f3TargetIds) {
				try {
					const probe = global.getMemory(memId) ||
						(getStores(ctx.cwd).project?.getMemory(memId) ?? null);
					const store = probe ? (
						probe.scope === "project" && getStores(ctx.cwd).project
							? getStores(ctx.cwd).project!
							: global
					) : global;
					store.adjustUtility(memId, -0.02);
				} catch {
					// ignore
				}
			}
			lastRecalledMemoryIds = [];
		}

		// Gap #3 active forgetting: track per-memory consecutive tool
		// failures. F3 already penalizes each failure by -0.02; this
		// catches the "chronic" case where a memory keeps being in recall
		// during failing tool calls. After ACTIVE_FORGETTING_THRESHOLD
		// consecutive failures, an extra ACTIVE_FORGETTING_PENALTY is
		// applied (default -0.05), and the counter resets. F3 success
		// resets the counter to 0.
		//
		// Extracted into a top-level function for testability.
		applyActiveForgetting(
			f3TargetIds,
			success === true,
			recallMissCount,
			{ global, project: getStores(ctx.cwd).project },
			{ threshold: ACTIVE_FORGETTING_THRESHOLD, penalty: ACTIVE_FORGETTING_PENALTY },
		);

		// Auto-capture: detect repeated tool patterns and save as memory (no user prompt)
		// Inspired by Anthropic Auto Memory — the agent learns workflow patterns organically
		const captureCfg = (config as any).autoCapture ?? DEFAULT_CAPTURE_CONFIG;
		if (captureCfg.enabled) {
			try {
				// Compute args hash matching trackToolCall logic. Use canonical JSON
				// (sorted keys) so that semantically identical args produce the same hash
				// regardless of key insertion order. Without this, {a:1,b:2} and
				// {b:2,a:1} get different hashes, the anti-spam check fails, and the
				// agent creates a new "Tool `bash` used 3 times" memory on every cycle.
				const argsStr = canonicalJsonStringify(args);
				const argsHash = global.computeArgsHash(argsStr);
				{
					const signal = detectToolSignals(
						global,
						event.toolName,
						argsHash,
						argsStr.slice(0, 200),
						event.isError,
						ctx.cwd,
						captureCfg,
					);

					if (signal && signal.confidence >= captureCfg.minConfidence) {
						// Route the capture to the store matching `signal.scope` (set by
						// detectScope, which already accounts for cwd project detection).
						// The previous code wrote everything to `global`, so a signal with
						// scope="project" (cwd inside a real project) ended up with
						// scope=project + scope_id=null in global.db — breaking the
						// "scope=X lives in store X" invariant. resolveStoreForScope
						// also handles the project→global downgrade when no project is
						// detected (so we never write scope=project to global.db).
						const targetStore = bankManager.resolveStoreForScope(signal.scope, ctx.cwd).store;

						// Dedup is now pattern-type-aware: saveSignal's internal
						// findCaptureCollision distinguishes same-pattern (refresh the
						// existing memory's frequency) from cross-pattern (create a new
						// memory of the OTHER target/category). The previous binary
						// `hasExistingCapture` blocked any second signal for the same
						// tool, which silently dropped failure patterns when a success
						// pattern already existed.
						//
						// tool_usage rows always live in global.db (trackToolCall writes
						// there unconditionally), so pass the global store explicitly as
						// the toolUsageStore — otherwise scope=project signals would mark
						// rows in the project store, which has no tool_usage table, leaving
						// the global rows uncaptured.
						const result = saveSignal(targetStore, signal, global);
						if (result.created) {
							observability.recordAdd({
								content: signal.suggestedContent,
								target: signal.target,
							});
							ctx.ui.notify(
								`Dream Memory: auto-captured ${signal.type} (${event.toolName}, ${signal.frequency}x, conf ${(signal.confidence * 100).toFixed(0)}%)`,
								"info",
							);
						} else if (result.updated) {
							// Refreshed an existing same-pattern capture (e.g.,
							// frequency grew from 3 → 7). Notify so the user can see
							// the pattern is alive; a different message keeps it
							// visually distinct from the initial capture.
							observability.recordAdd({
								content: signal.suggestedContent,
								target: signal.target,
							});
							ctx.ui.notify(
								`Dream Memory: auto-capture refreshed (${event.toolName}, now ${signal.frequency}x)`,
								"info",
							);
						}
					}
				}
			} catch (err: any) {
				// Auto-capture must never break tool execution
				// Silently swallow (log to stderr for debugging)
				if (process.env.DREAM_DEBUG) {
					console.error("[dream] auto-capture error:", err.message);
				}
			}
		}
	});

	// ── Tool Result Helper ───────────────────────────────────────────────

	/**
	 * Wrap a plain text result in the `AgentToolResult<unknown>` shape that
	 * `pi.registerTool` expects. The required `details` field carries
	 * arbitrary structured data (the agent may inspect it for follow-up
	 * reasoning); we pass `undefined` since our tools don't surface any.
	 *
	 * Why this helper exists: the `AgentToolResult` interface from
	 * `pi-coding-agent` requires `details: T`, but every tool result in
	 * this file is a plain `{ content: [...] }` literal. TS rejects the
	 * implicit cast with a "Two different types with this name exist"
	 * error because `pi-coding-agent` re-exports `AgentToolResult` from
	 * `pi-agent-core` and TS sees the literal as a different (incomplete)
	 * type. The helper centralizes the explicit cast and gives us one
	 * place to add `details` if a tool needs it later.
	 */
	function toolResult(text: string): AgentToolResult<unknown> {
		return { content: [{ type: "text", text }] } as AgentToolResult<unknown>;
	}

	// ── Tools ────────────────────────────────────────────────────────────

	// Precompute the schema block once at extension load — it's static
	// (derived from constants) and gets embedded into tool promptSnippets.
	// ~500 tokens, rendered into the system prompt on every turn.
	const SCHEMA_BLOCK = renderSchemaBlock();

	// memory_add
	pi.registerTool({
		name: "dream_memory_add",
		label: "Dream Memory Add",
		description: "Add a durable memory with auto-TTL and contradiction detection",
		promptSnippet: `Use dream_memory_add when this turn contains durable information worth remembering long-term. If the memory is a NEW CONNECTION derived from a dream_memory_search result, set source_type='query-synthesis' and source='query-synthesis: <brief description of derivation>'.\n\n${SCHEMA_BLOCK}`,
		parameters: Type.Object({
			content: Type.String({ description: "The memory content to store" }),
			target: StringEnum(MEMORY_TARGETS, { description: "Memory target type" }),
			category: Type.Optional(
				StringEnum(MEMORY_CATEGORIES, { description: "Memory category" }),
			),
			scope: Type.Optional(StringEnum(MEMORY_SCOPES, { description: "Memory scope" })),
			ttl: Type.Optional(StringEnum(["permanent", "long", "medium", "short", "session"] as const, { description: "TTL class" })),
			status: Type.Optional(StringEnum(MEMORY_STATUSES, { description: "Memory status (default: active)" })),
			source: Type.Optional(Type.String({ description: "Where this memory came from (URL, file path, conversation turn id, etc.)" })),
			source_type: Type.Optional(StringEnum(MEMORY_SOURCE_TYPES, { description: "Type of source" })),
			batch_id: Type.Optional(Type.String({ description: "Batch ID to group this add with others (auto-batched if not provided)" })),
			reason: Type.Optional(Type.String({ description: "Why this memory should be remembered — the actionable implication for future tasks" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// 1. Sanitize content (remove credentials)
			const { sanitized: credSanitized, redacted } = sanitizeCredentials(params.content);

			// 1.3. Resolve coreferences (ele→Alice, he→Bob)
			// Inspired by SimpleMem: "resolve all pronouns into explicit entity names"
			// so each memory unit is self-contained.
			const coref = resolveCoreferences(credSanitized);

			// 1.5. Normalize temporal references (yesterday → 2026-06-13)
			// Inspired by Anthropic Auto Dream Phase 3: convert relative dates to absolute
			// so memories remain interpretable as they age
			const temporal = normalizeTemporalReferences(coref.resolved);
			const sanitized = temporal.normalized;

			// F13: Auto-detect source type when not explicitly provided
			const detected = params.source_type ? null : detectSourceType(sanitized);
			const effectiveSourceType = params.source_type || detected?.sourceType || "user";
			const effectiveSourceFormat = detected?.sourceFormat;

			// F19: Extract entities (technologies, paths) as tags
			const autoTags = extractEntities(sanitized);

			// 2. Resolve scope and get correct store
			const scope = resolveScope({
				cwd: ctx.cwd,
				sessionId: currentSessionId || "unknown",
				scopeOverride: params.scope as any,
			});
			const store = getStoreForScope(scope.scope, ctx.cwd);
			const { global, project } = getStores(ctx.cwd);

			// Compute tier once — same for both paths
			const tier: "factual" | "operational" =
				params.ttl === "permanent" ? "factual" : "operational";

			// 3. Detect contradictions in BOTH stores.
			// searchByQuery uses Unicode-aware FTS5 tokenization. The previous
			// searchBM25 path stripped diacritics from queries like "operações" →
			// "opera es", so FTS5 failed to find near-duplicates in pt-BR content.
			// (searchBM25 was removed in the Phase 2 audit; only searchByQuery
			// remains.)
			const globalResults = global.searchByQuery(sanitized, { limit: 20 });
			const projectResults = project ? project.searchByQuery(sanitized, { limit: 20 }) : [];
			const globalMemories = globalResults.map((r) => r.memory);
			const projectMemories = projectResults.map((r) => r.memory);
			const allMemories = [...globalMemories, ...projectMemories];
			const contradictions = detectContradictions(sanitized, params.target, allMemories);

			// 4. Resolve contradictions
			let created = true;
			let newMemoryCreated = false;
			for (const c of contradictions) {
				// Determine which store the existing memory lives in.
				// For project-scoped memories, c.existing.scope_id IS the project
				// ID (= the .db filename). This is the source for the move.
				const fromStoreId =
					c.existing.scope === "global" ? "global" : c.existing.scope_id || "global";
				const existingStore =
					fromStoreId === "global" ? global : bankManager.getStoreById(fromStoreId);
				// The new store is wherever the new memory should live. `store`
				// (resolved at step 2) is already the correct target.
				const toStoreId = scope.scope === "global" ? "global" : scope.scopeId || "global";

				const resolution = await resolveContradiction(c, sanitized, {
					select: ctx.ui.select.bind(ctx.ui),
				});

				// Short-circuit discard before building any new-memory metadata.
				// The previous code built newMemoryParams (with a fresh batchId)
				// before the resolution check, which meant a discarded contradiction
				// still consumed a batch slot — and `lastAddTime` was bumped,
				// keeping the auto-batch window open past the user-visible action.
				if (resolution.action === "discard") {
					created = false;
					observability.recordContradiction({
						detected: true,
						action: "discard",
					});
					// F3: penalize the discarded existing memory. The user
					// rejected this memory in favor of the new content —
					// the existing one is wrong or outdated. -0.10 brings
					// a memory that was useful down to 0 within ~5 discards
					// (or, in the worst case, fast-tracks it for replacement
					// by new content via the utility multiplier in decay).
					// Best-effort: memory may have been deleted concurrently.
					try {
						existingStore.adjustUtility(c.existing.id, -0.10);
					} catch {
						// ignore
					}
					break;
				}

				// The classification block — reused below for the cross-store
				// move and for the "no contradiction" create path. Built once
				// here so the applyResolution path and the create-fallback
				// path stay in sync (same scope, ttl, metadata). Built only
				// after we know we'll actually create (or move) a row.
				const newMemoryParams = {
					content: sanitized,
					scope: scope.scope,
					scope_id: scope.scopeId,
					target: params.target,
					category: params.category,
					status: params.status as any,
					tier,
					ttl_days: inferTTL({
						target: params.target as any,
						category: params.category as any,
						scope: scope.scope,
						tier,
					}),
					metadata: {
						batchId: getOrCreateBatchId(params.batch_id),
						...(params.source ? { source: params.source } : {}),
						sourceType: effectiveSourceType,
						...(effectiveSourceFormat ? { sourceFormat: effectiveSourceFormat } : {}),
						// F2: rootMemoryId for version chains. The root is the
						// original memory in the chain (or the existing memory's root).
						rootMemoryId: (c.existing.metadata as any)?.rootMemoryId || c.existing.id,
					},
				};

				const result = applyResolution(
					resolution.action,
					c.existing,
					sanitized,
					{
						// Same-file replace (in-place). Bound to the store where
						// the existing memory lives. The cross-store detection
						// inside applyResolution picks moveAcrossStores instead
						// when fromStoreId !== toStoreId.
						updateInPlace: (id, params) => existingStore.updateMemory(id, params),
						// Cross-file replace. Goes through BankManager so it can
						// route via ATTACH + transaction; the source is the
						// existing store, the target is `store` (the new store).
						moveAcrossStores: (id, params) =>
							bankManager.moveMemory(
								id,
								fromStoreId,
								toStoreId,
								params.scope,
								params.scope_id ?? null,
								{
									target: params.target,
									category: params.category,
									tier: params.tier,
									ttl_days: params.ttl_days,
								},
							),
						// keep-both fallback: create a fresh memory in the new
						// store. The new memory gets a new id; the existing
						// one is left alone.
						createInNewStore: (params) => store.createMemory(params),
					},
					newMemoryParams,
				);

				// Track if a new memory was created (replace or keep-both).
				// Cross-store replace also counts (the move wrote a new row
				// in the destination, with version history audit trail).
				if (resolution.action === "keep-both" || resolution.action === "replace") {
					newMemoryCreated = true;
				}

				// F2: For replace, ensure rootMemoryId is set on the updated memory.
				// The metadata isn't passed through applyResolution's updateInPlace,
				// so we set it explicitly here.
				if (resolution.action === "replace") {
					const existingMeta = (c.existing.metadata as Record<string, any>) || {};
					if (!existingMeta.rootMemoryId) {
						existingStore.updateMemory(c.existing.id, {
							metadata: { ...existingMeta, rootMemoryId: c.existing.id },
						});
					}
				}

				// F5 + F6: When keep-both, mark the OLD memory with forgetReason
				// and a causal TTL (7d). The old memory stays active during the
				// grace period but expires automatically if not re-accessed.
				if (resolution.action === "keep-both") {
					const CAUSAL_TTL_DAYS = 7;
					const existingMeta = (c.existing.metadata as Record<string, any>) || {};
					// Don't extend an already-shorter TTL
					const causalTtl = Math.min(c.existing.ttl_days ?? Infinity, CAUSAL_TTL_DAYS);
					existingStore.updateMemory(c.existing.id, {
						metadata: {
							...existingMeta,
							forgetReason: "contradicted-by-new",
							forgetReasonContent: sanitized.slice(0, 200),
							forgottenAt: Date.now(),
						},
						ttl_days: causalTtl,
					});
				}

				// Record the actual contradiction action
				observability.recordContradiction({
					detected: true,
					action: resolution.action,
				});
			}

			if (!created) {
				return toolResult("Memory discarded (redundant or contradicted)");
			}

			// 5. Create memory if not already created by contradiction resolver
			if (contradictions.length === 0 || (contradictions.length > 0 && !newMemoryCreated)) {
				// Honor explicit TTL class from the tool param. Previous code derived
				// TTL via `inferTTL({tier})`, which collapses any non-"permanent" tier
				// to 7 days — so `ttl: "long"` silently became 7d. Map explicit classes
				// first, fall back to heuristic when no class is provided.
				//
				// The TTL day values come from TTL_CLASSES in ttl/manager.ts (single
				// source of truth). Keeping the values inline here would let the two
				// definitions drift — which is exactly what the Phase 1 audit found.
				//
				// Coerce null → undefined: `createMemory`/`updateMemory` accept
				// `number | undefined` (null is treated as "no change" in update,
				// but for create we want explicit "permanent" semantics, which
				// `undefined` already gives). The union type was `number | null`
				// only because the TTL map can return null for "permanent".
				const ttlDays = params.ttl
					? (TTL_CLASSES[params.ttl] ?? undefined)
					: inferTTL({
							target: params.target as any,
							category: params.category as any,
							scope: scope.scope,
							tier,
						}) ?? undefined;

				// Build metadata from source params + batchId
				const batchId = getOrCreateBatchId(params.batch_id);
				const sourceMetadata: Record<string, any> = { batchId };
				if (params.source) sourceMetadata.source = params.source;
				sourceMetadata.sourceType = effectiveSourceType;
				if (effectiveSourceFormat) sourceMetadata.sourceFormat = effectiveSourceFormat;
			if (params.reason) sourceMetadata.reason = params.reason;
			if (coref.changed) {
				sourceMetadata.coreferenceResolved = true;
				sourceMetadata.coreferenceResolutions = coref.resolutions;
			}
				if (temporal.changed) {
					// Audit trail: which temporal references were normalized
					sourceMetadata.temporalNormalized = true;
					sourceMetadata.temporalRefs = temporal.references.map((r) => ({
						original: r.original,
						absolute: r.absolute,
					}));
				}

				// Formation Pipeline: evaluate memory quality before storage
				const evaluation = evaluateMemory(sanitized, params.category as any, params.target as any, allMemories);
				
				// Override tier based on evaluation
				const effectiveTier: "factual" | "operational" = evaluation.classification === "contextual"
					? "operational"
					: "factual"; // both core and ephemeral stay factual
				
				// Adjust TTL based on classification
				const effectiveTtlDays = evaluation.classification === "ephemeral"
					? Math.min(ttlDays ?? 30, 7) // cap ephemeral at 7 days
					: ttlDays;

				// v2.3: Topic Key — generate stable key for upsert
				const topicKey = generateTopicKey(params.category as any, autoTags);

				// Check for existing memory with same topic_key (upsert)
				const existingByTopic = store.findByTopicKey(topicKey, scope.scope, scope.scopeId);
				if (existingByTopic) {
					// Update existing memory instead of creating new one
					const updatedContent = existingByTopic.content + "\n\n" + sanitized;
					store.updateMemory(existingByTopic.id, {
						content: updatedContent,
					});
					store.trackReinforcement(existingByTopic.id);

					observability.recordAdd({ content: sanitized, target: params.target });
					return toolResult(`Memory updated (topic key: ${topicKey}). Reinforced existing memory.`);
				}

				const newMemory = store.createMemory({
					content: sanitized,
					scope: scope.scope,
					scope_id: scope.scopeId,
					target: params.target as any,
					category: params.category as any,
					status: params.status as any,
					tier: effectiveTier,
					ttl_days: effectiveTtlDays,
					metadata: sourceMetadata,
					confidence: "explicit",
					// v2.0: user-stated memories get highest trust (user_stated)
					trust_level: 3,
					// v1.6 provenance: tag this memory with the session and
					// turn where it was learned. Both null when no session is
					// active (e.g., during extension boot). The recall output
					// shows these as a `provenance="session:turn"` attribute.
					source_session_id: currentSessionId ?? undefined,
					source_turn_id: currentTurnCounter || undefined,
					// v1.7: episodic vs semantic. User-facing add paths
					// (user/file/web/tool-result/conversation/query-synthesis)
					// are always semantic — they're already abstracted. Auto-
					// captured tool-quirks go through capture/signals.ts and
					// are tagged episodic there.
					memory_kind: "semantic",
					// F19: auto-extracted entity tags (technologies, paths)
					tags: autoTags.length > 0 ? autoTags : undefined,
					// v2.3: stable topic key for dedup
					topic_key: topicKey,
				});

				// Background embed: schedule an async embedding for the new
				// memory. Fire-and-forget via setImmediate so the tool call
				// returns without waiting for the model. embed() returns null
				// on any failure (model not installed, ONNX error, etc) and
				// the .then() is skipped — the memory stays BM25-searchable,
				// no error is thrown. This means the feature degrades to
				// status quo when the optional dep is missing.
				//
				// Captures store by closure: store is the resolved store
				// (global or project) where the memory was created. Passing
				// it explicitly is cleaner than re-resolving in the callback
				// (which would race with scope changes between turns).
				const storeForEmbed = store;
				const memoryIdForEmbed = newMemory.id;
				setImmediate(() => {
					embedText(newMemory.content).then((vec) => {
						if (vec) {
							storeForEmbed.updateEmbedding(memoryIdForEmbed, vectorToBytes(vec));
						}
					});
				});

				// Auto-link: find memories with similar content and record
				// relationships in metadata.linked_to. Enables graph expansion
				// in search (Phase 7D) so searching for A can surface B if A
				// is linked to B. Unidirectional for v1 (A → B, not B → A) —
				// simpler writes, agent can follow links via dream_memory_get.
				//
				// Skip when:
				//   - target is "failure" (failure patterns are isolated
				//     and don't need links)
				//   - metadata says auto-capture (those are operational, not
				//     knowledge-graph material)
				//   - content is too short to be meaningfully related
				if (params.target !== "failure" && !sourceMetadata.sourceType?.includes("auto-capture")) {
					try {
						const related = store.findRelatedMemories(sanitized, {
							excludeId: newMemory.id,
							target: params.target,
							topK: 3,
							// minScore=0: rely on FTS5 ranking + top-K to filter.
							// In small personal corpora, BM25 scores are tiny
							// (high DF for common terms like "user", "prefers").
							// A non-zero threshold would over-filter.
							minScore: 0.0,
							// relativeRatio=0.5: link quality gate (Akshay Pachaar:
							// don't link everything to everything). Only link
							// candidates whose BM25 score is at least half the
							// top match's score. Corpus-adaptive: same ratio
							// works on small (50) and large (5000) corpora,
							// unlike an absolute minScore. A previous run of this
							// code linked too aggressively (BM25 minScore=0,
							// no ratio), polluting the graph with keyword-overlap
							// links that didn't reflect real semantic relation.
							relativeRatio: 0.5,
						});
						if (related.length > 0) {
							store.updateLinkedTo(
								newMemory.id,
								related.map((m) => ({ id: m.id, relation: "related_to" })),
							);
						}
					} catch (err) {
						// Linking is best-effort — don't fail the add if it breaks.
						console.warn(`[dream] auto-link failed for ${newMemory.id}:`, err);
					}
				}

				// Auto-relations: entity-tag-based edge creation
				// When new memory shares entity tags with existing memories AND
				// their categories have a defined edge type in EDGE_TYPE_RULES,
				// create a typed edge (e.g., "corrects", "explains", "caused_by").
				try {
					if (autoTags.length > 0 && params.category) {
						const tagQuery = autoTags.join(" ");
						const relatedByTag = store.findRelatedMemories(tagQuery, {
							excludeId: newMemory.id,
							topK: 5,
							minScore: 0.0,
							relativeRatio: 0.0, // no BM25 gate — we only care about tag overlap
						});

						for (const related of relatedByTag) {
							// Check if both memories have overlapping tags
							const relatedTags = related.tags ?? [];
							const overlap = autoTags.filter((t: string) => relatedTags.includes(t));
							if (overlap.length === 0) continue;

							// Check EDGE_TYPE_RULES for valid edge type
							const edgeKey = `${params.category}::${related.category ?? ""}`;
							const reverseKey = `${related.category ?? ""}::${params.category}`;
							const edgeTypes = EDGE_TYPE_RULES[edgeKey] ?? EDGE_TYPE_RULES[reverseKey];
							if (!edgeTypes || edgeTypes.length === 0) continue;

							// Create the typed edge
							store.updateLinkedTo(newMemory.id, [{
								id: related.id,
								relation: edgeTypes[0], // use preferred edge type
							}]);
						}
					}
				} catch (err) {
					// Auto-relations is best-effort
					console.warn(`[dream] auto-relations failed for ${newMemory.id}:`, err);
				}
			}

			// F17: invalidate recall cache after any memory mutation
			invalidateRecallCache();

			// Record metrics
			observability.recordAdd({ content: sanitized, target: params.target });
			// Contradiction metrics are now recorded inside the resolution loop
			// with the actual resolution action (replace/keep-both/discard)

			const parts = ["Memory added"];
			if (redacted) parts.push("credentials redacted");
			if (coref.changed) parts.push(`${coref.resolutions.length} coreference(s) resolved`);
			if (temporal.changed) parts.push(`${temporal.references.length} temporal ref(s) normalized`);
			const msg = parts.join(" (").concat(")");
			return toolResult(msg);
		},
	});

	// memory_search
	pi.registerTool({
		name: "dream_memory_search",
		label: "Dream Memory Search",
		description: "Hybrid search (BM25 + IDF + RRF) with TTL",
		promptSnippet: `Use dream_memory_search to find relevant memories. After search results are returned, if you discover a NEW CONNECTION or SYNTHESIS between 2+ results that wasn't obvious before, save it as a new memory using dream_memory_add with category='insight' and source_type='query-synthesis'. This is 'knowledge compounding' — building derived understanding on top of existing memories.\n\nFilter hints — use target/category params when you know what you want:\n${SCHEMA_BLOCK}`,
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			topK: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
			scope: Type.Optional(StringEnum(MEMORY_SCOPES)),
			target: Type.Optional(StringEnum(MEMORY_TARGETS)),
			category: Type.Optional(StringEnum(MEMORY_CATEGORIES)),
			status: Type.Optional(StringEnum(MEMORY_STATUSES, { description: "Filter by status (default: any)" })),
			summaryMode: Type.Optional(Type.Boolean({ description: "Return compact results (id + first 80 chars) for progressive disclosure" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const stores = getStores(ctx.cwd);
			const { global, project } = stores;

			// Search both stores using scopedSearch
			// When no topK provided, adaptive retrieval classifies query complexity
			const results = scopedSearch(stores, params.query, {
				...(params.topK ? { topK: params.topK } : {}),
				scope: params.scope,
				target: params.target as any,
				category: params.category,
				status: params.status,
				summaryMode: params.summaryMode,
			});

			if (results.length === 0) {
				return toolResult("No memories found");
			}

			// Track access in the store that actually holds the memory.
			// resolveStoreForScope maps global/agent/session -> global.db and
			// project -> project store. The previous ternary only handled
			// scope === "global" explicitly, so agent/session memories in a
			// cwd-without-project were silently skipped.
			for (const r of results) {
				const target = r.memory.scope === "project" && project ? project : global;
				target.trackAccess(r.memory.id);
			}

			const formatted = results
				.map((r, i) => {
					const decay = calculateDecay(r.memory);
					const age = formatRelativeAge(r.memory.created_at);
					const anchor = r.anchorToken ? ` ★anchor:${r.anchorToken}` : "";
					return `${i + 1}. [${r.memory.target}${r.memory.category ? ":" + r.memory.category : ""}] ${r.memory.content} (score: ${r.score.toFixed(2)}, decay: ${decay.toFixed(2)}, age: ${age}${anchor}${(r.memory.metadata as any)?.reason ? `, reason: ${(r.memory.metadata as any).reason}` : ""})`;
				})
				.join("\n");

			return toolResult(formatted);
		},
	});

	// memory_get — Fetch a single memory by ID, including its linked_to list.
	// Use this to follow links surfaced by dream_memory_search (a search result
	// may show linked_to: ["id1", "id2"]; call this tool with each id to fetch
	// the linked memory's content). Without this tool, links are visible but
	// not navigable.
	pi.registerTool({
		name: "dream_memory_get",
		label: "Dream Memory Get",
		description: "Fetch a single memory by ID, including its linked_to list and the linked memories' content",
		promptSnippet: "Use dream_memory_get to fetch a specific memory by ID, or to follow links surfaced by dream_memory_search. When a search result shows linked_to: [\"id1\", \"id2\"], call this tool to fetch each linked memory and connect the dots.",
		parameters: Type.Object({
			id: Type.String({ description: "Memory ID to fetch" }),
			includeLinked: Type.Optional(Type.Boolean({ description: "If true (default), also fetch and include linked memories' content. If false, only return the requested memory with its linked_to IDs.", default: true })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { global, project } = getStores(ctx.cwd);
			const includeLinked = params.includeLinked !== false;

			// Search both stores — the ID could be in either
			const mem = global.getMemory(params.id) || (project?.getMemory(params.id) ?? null);
			if (!mem) {
				return toolResult(`Memory ${params.id} not found`);
			}

			// Determine the store the memory actually lives in. A polluted
			// memory (scope=project but physically in global.db, or
			// scope=agent/session physically in global.db) won't be found
			// if we naively pick the store by scope. Search both: the
			// getMemory lookup above already confirmed one of them has it.
			const store = global.getMemory(params.id) ? global : (project || global);
			const linkedIds: string[] = (mem.metadata as any)?.linked_to || [];
			const parts: string[] = [
				`[${mem.target}${mem.category ? ":" + mem.category : ""}] ${mem.content}`,
				`  ID: ${mem.id}`,
				`  Scope: ${mem.scope}${mem.scope_id ? `:${mem.scope_id}` : ""}`,
				`  Updated: ${new Date(mem.updated_at).toISOString()}`,
			];
			if (linkedIds.length > 0) {
				parts.push(`  Linked to: ${linkedIds.length} memory(ies) [${linkedIds.join(", ")}]`);
				if (includeLinked) {
					const linked = store.getLinkedMemories(mem.id);
					if (linked.length > 0) {
						parts.push("");
						parts.push("  --- Linked memories ---");
						for (const lm of linked) {
							parts.push(`  [${lm.target}${lm.category ? ":" + lm.category : ""}] ${lm.content} (id: ${lm.id})`);
						}
					} else {
						parts.push("  (Linked memories are stale/deleted — no content to show)");
					}
				}
			}
			return toolResult(parts.join("\n"));
		},
	});

	// memory_update — edit a memory's content or classification
	pi.registerTool({
		name: "dream_memory_update",
		label: "Dream Memory Update",
		description: "Edit an existing memory's content, category, status, or tier. Cannot change scope (use rollback for that).",
		promptSnippet: "Use dream_memory_update to fix a typo, refine a preference, or change the category/status of a memory. This is the right tool for content edits — use dream_memory_rollback to revert to a previous version, and dream_memory_add to create a NEW memory (which will trigger contradiction detection).",
		parameters: Type.Object({
			id: Type.String({ description: "Memory ID to update" }),
			content: Type.Optional(Type.String({ description: "New content. Will be sanitized and temporal-normalized like a fresh add." })),
			category: Type.Optional(StringEnum(MEMORY_CATEGORIES, { description: "New category" })),
			status: Type.Optional(StringEnum(MEMORY_STATUSES, { description: "New status (active/resolved/superseded)" })),
			tier: Type.Optional(StringEnum(["factual", "operational"] as const, { description: "New tier. 'factual' = permanent TTL; 'operational' = short TTL." })),
			ttl: Type.Optional(StringEnum(["permanent", "long", "medium", "short", "session"] as const, { description: "TTL class override. Translates to days: permanent=null, long=365, medium=30, short=7, session=1." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Find the memory in either store
			const { global, project } = getStores(ctx.cwd);
			const mem = global.getMemory(params.id) || (project?.getMemory(params.id) ?? null);
			if (!mem) {
				return toolResult(`Memory ${params.id} not found`);
			}
			// Pick the store the memory physically lives in. Using `scope`
			// alone fails for polluted memories (scope=project living in
			// global.db from the legacy saveSignal bug); the getMemory probe
			// above already confirmed which store has it, so we mirror that.
			const store = global.getMemory(params.id) ? global : (project || global);

			// Sanitize + temporal-normalize new content (same pipeline as add)
			let normalizedContent: string | undefined;
			if (params.content !== undefined) {
				const { sanitized: credSanitized } = sanitizeCredentials(params.content);
				const temporal = normalizeTemporalReferences(credSanitized);
				normalizedContent = temporal.normalized;
			}

			// Translate ttl class to days. Coerce null → undefined to satisfy
			// `updateMemory`'s `number | undefined` signature.
			let ttlDays: number | undefined;
			if (params.ttl !== undefined) {
				ttlDays = inferTTL({
					target: mem.target,
					category: mem.category,
					scope: mem.scope,
					tier: params.tier ?? mem.tier,
				}) ?? undefined;
			}

			const updated = store.updateMemory(params.id, {
				content: normalizedContent,
				category: params.category,
				status: params.status,
				tier: params.tier,
				ttl_days: ttlDays,
			});

			if (!updated) {
				return toolResult(`Failed to update memory ${params.id}`);
			}

			invalidateRecallCache();

			const parts = ["Memory updated"];
			if (params.content !== undefined) parts.push("content changed");
			if (params.category) parts.push(`category: ${params.category}`);
			if (params.status) parts.push(`status: ${params.status}`);
			if (params.tier) parts.push(`tier: ${params.tier}`);
			if (params.ttl) parts.push(`ttl: ${params.ttl}`);
			return toolResult(`${parts.join(" | ")}. ID: ${updated.id}`);
		},
	});

	// memory_dismiss — User agency: mark a memory as no longer relevant.
	// Sets status="resolved" so it stops appearing in recall. Optional
	// reason is saved in metadata for audit ("why was this dismissed?").
	//
	// Two modes:
	//   - by id: explicit dismissal of a known memory
	//   - by query: search for the memory, dismiss the top hit
	//
	// Resolved memories are NOT deleted. They can be reactivated via
	// dream_memory_update --status=active if the dismissal was a mistake.
	// This matches the "active forgetting" principle (Cognee/MemOS): the
	// system forgets by hiding, not by destroying. The audit trail
	// (memory_versions) preserves the dismissal history.
	pi.registerTool({
		name: "dream_memory_dismiss",
		label: "Dream Memory Dismiss",
		description: "Mark a memory as no longer relevant (status=resolved). Use to remove noise from recall without deleting the memory.",
		promptSnippet: `Use dream_memory_dismiss when a memory is no longer relevant to recall — outdated preference, wrong assumption, stale pattern. Set status=resolved (not deleted) so the memory can be reactivated later if the dismissal was a mistake. Pass either --id (for a known memory) or --query (searches and dismisses the top hit). Optional --reason saves the dismissal rationale in metadata for audit.\n\nWhen to use:\n  - Memory is irrelevant or wrong\n  - Memory is duplicated by a better one\n  - Memory was auto-captured for a tool pattern that no longer applies\n  - User explicitly says "stop recalling X" or "forget that"`,
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Memory ID to dismiss (mutually exclusive with query)" })),
			query: Type.Optional(Type.String({ description: "Search query; top hit will be dismissed (mutually exclusive with id)" })),
			reason: Type.Optional(Type.String({ description: "Why this memory is no longer relevant. Saved in metadata.dismissedReason for audit." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Validation: exactly one of id or query required
			if (!params.id && !params.query) {
				return toolResult("Error: provide either --id or --query");
			}
			if (params.id && params.query) {
				return toolResult("Error: --id and --query are mutually exclusive");
			}

			const { global, project } = getStores(ctx.cwd);
			let memId: string | null = null;
			let resolvedVia: "id" | "query" = "id";
			let resolvedSnippet = "";

			if (params.id) {
				const mem = global.getMemory(params.id) || (project?.getMemory(params.id) ?? null);
				if (!mem) {
					return toolResult(`Memory ${params.id} not found`);
				}
				memId = mem.id;
				resolvedSnippet = mem.content.slice(0, 80);
			} else {
				// Query mode: scopedSearch across both stores
				const results = scopedSearch(
					{ global, project, projectId: ctx.cwd },
					params.query!,
					{ topK: 1, status: "active" },
				);
				if (results.length === 0) {
					return toolResult(`No active memories match query: ${params.query}`);
				}
				memId = results[0].memory.id;
				resolvedVia = "query";
				resolvedSnippet = results[0].memory.content.slice(0, 80);
			}

			// Find the store that physically holds the memory
			const store = global.getMemory(memId) ? global : (project || global);
			const mem = store.getMemory(memId)!;
			const meta = (mem.metadata as Record<string, any>) || {};

			// Build new metadata preserving existing fields, adding dismiss info
			const newMetadata: Record<string, any> = {
				...meta,
				dismissedAt: Date.now(),
				dismissedReason: params.reason || "(no reason provided)",
				dismissedVia: resolvedVia,
			};
			// Track dismissal count: useful for "/dream-status" / debug
			newMetadata.dismissCount = (meta.dismissCount || 0) + 1;

			const updated = store.updateMemory(memId, {
				status: "resolved",
				metadata: newMetadata,
			});
			if (!updated) {
				return toolResult(`Failed to dismiss memory ${memId}`);
			}

			invalidateRecallCache();

			const reasonSnippet = params.reason ? ` — ${params.reason}` : "";
			return toolResult(
				`Dismissed (${resolvedVia}): "${resolvedSnippet}..."${reasonSnippet}\nID: ${updated.id}\nStatus: resolved (memory preserved, no longer in recall). Re-activate with dream_memory_update --id=${updated.id} --status=active.`,
			);
		},
	});

	// memory_stats
	pi.registerTool({
		name: "dream_memory_stats",
		label: "Dream Memory Stats",
		description: "Show memory system statistics",
		promptSnippet: "Use dream_memory_stats to check memory system health",
		parameters: Type.Object({}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { global, project } = getStores(ctx.cwd);
			const globalStats = global.getStats();
			const projectStats = project ? project.getStats() : null;

			const formatted = [
				`Global memories: ${globalStats.total}`,
				`  By target: ${JSON.stringify(globalStats.byTarget)}`,
				`  By status: ${JSON.stringify(globalStats.byStatus)}`,
				`  Expired: ${globalStats.expired}`,
				...projectStats ? [
					`Project memories: ${projectStats.total}`,
					`  By target: ${JSON.stringify(projectStats.byTarget)}`,
					`  By status: ${JSON.stringify(projectStats.byStatus)}`,
					`  Expired: ${projectStats.expired}`,
				] : [],
				`Total: ${globalStats.total + (projectStats?.total || 0)}`,
			].join("\n");

			return toolResult(formatted);
		},
	});

	// memory_list
	pi.registerTool({
		name: "dream_memory_list",
		label: "Dream Memory List",
		description: "List active memories with optional filters. Pass status='all' (or 'superseded'/'resolved') to see archived memories.",
		promptSnippet: "Use dream_memory_list to see all stored memories. The default filters out superseded (archived) memories — they're consolidated into synthesis memories and would otherwise clutter the list with duplicates. Pass status='all' to see everything including the archive.",
		parameters: Type.Object({
			scope: Type.Optional(StringEnum(MEMORY_SCOPES, { description: "Filter by scope" })),
			target: Type.Optional(StringEnum(MEMORY_TARGETS, { description: "Filter by target" })),
			category: Type.Optional(StringEnum(MEMORY_CATEGORIES, { description: "Filter by category" })),
			status: Type.Optional(StringEnum([...MEMORY_STATUSES, "all"] as const, { description: "Filter by status. Default: 'active' (excludes archived). Pass 'all' to see everything." })),
			source: Type.Optional(Type.String({ description: "Filter by source substring (matches metadata.source)" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { global, project } = getStores(ctx.cwd);
			const limit = params.limit || 50;

			// Default to `active` so superseded (consolidated/archived) memories
			// don't clutter the list. Synthesis consolidates duplicates into a
			// single memory marked status=active; the originals get status=
			// superseded. Showing both makes the list look like it has 50
			// duplicates when really only 10 are live. Override with status=
			// 'all' or an explicit status to see everything.
			const statusFilter = params.status === "all" ? undefined : (params.status ?? "active");

			// List from both stores
			const globalMemories = global.listMemories({
				scope: params.scope as any,
				target: params.target as any,
				category: params.category as any,
				status: statusFilter as any,
				limit,
			});

			let projectMemories: typeof globalMemories = [];
			if (project) {
				projectMemories = project.listMemories({
					scope: params.scope as any,
					target: params.target as any,
					category: params.category as any,
					status: statusFilter as any,
					limit,
				});
			}

			// Merge, deduplicate by id, and sort by updated_at.
			// Dedupe by id (not content) so legitimate scope variants of similar
			// memories — e.g., a global insight plus a project-specific copy
			// with the same words — are all visible. This matches the
			// `scopedSearch` dedup behavior in search/hybrid.ts.
			let allMemories = [...globalMemories, ...projectMemories];

			// Source filter (substring match on metadata.source)
			if (params.source) {
				const pattern = params.source.toLowerCase();
				allMemories = allMemories.filter(m => {
					const source = m.metadata?.source;
					return typeof source === "string" && source.toLowerCase().includes(pattern);
				});
			}

			const seenIds = new Set<string>();
			const dedupedMemories = allMemories.filter((m) => {
				if (seenIds.has(m.id)) return false;
				seenIds.add(m.id);
				return true;
			});
			const memories = dedupedMemories
				.sort((a, b) => b.updated_at - a.updated_at)
				.slice(0, limit);

			if (memories.length === 0) {
				return toolResult("No memories found");
			}

			const formatted = memories
				.map((m, i) => {
					const ttl = m.ttl_days ? `${m.ttl_days}d` : "permanent";
					const date = new Date(m.created_at).toISOString().split("T")[0];
					const age = formatRelativeAge(m.created_at);
					const category = m.category ? `:${m.category}` : "";
					const status = m.status !== "active" ? `, status=${m.status}` : "";
					const content = truncateForPreview(m.content);
					return `${i + 1}. [${m.target}${category}] ${content}\n   scope=${m.scope}, ttl=${ttl}, created=${date} (${age})${status}`;
				})
				.join("\n\n");

			return toolResult(`${memories.length} memories found:\n\n${formatted}`);
		},
	});

	// memory_history
	pi.registerTool({
		name: "dream_memory_history",
		label: "Dream Memory History",
		description: "Show version history of a memory (audit trail)",
		promptSnippet: "Use dream_memory_history to see all changes to a memory",
		parameters: Type.Object({
			memory_id: Type.String({ description: "Memory ID to show history for" }),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { global, project } = getStores(ctx.cwd);

			// Search for memory in both stores
			let versions = global.getVersions(params.memory_id);
			if (versions.length === 0 && project) {
				versions = project.getVersions(params.memory_id);
			}

			if (versions.length === 0) {
				return toolResult("No version history found");
			}

			const formatted = versions
				.map((v, i) => {
					const date = new Date(v.created_at).toISOString();
					return `${i + 1}. [${v.action}] ${date}\n   ${v.content.slice(0, 100)}${v.content.length > 100 ? "..." : ""}`;
				})
				.join("\n\n");

			return toolResult(`Version history (${versions.length} versions):\n\n${formatted}`);
		},
	});

	// memory_rollback
	pi.registerTool({
		name: "dream_memory_rollback",
		label: "Dream Memory Rollback",
		description: "Rollback a memory to a specific version, or revert an entire batch",
		promptSnippet: "Use dream_memory_rollback to restore a memory to a previous state, or revert all memories from a batch (use batch_id to undo recent adds). Cross-store batch rollback is best-effort: if a batch moved a memory between stores, the destination memory is deleted and the source memory is restored independently. Re-running the same batch is a no-op on the second pass.",
		parameters: Type.Object({
			version_id: Type.Optional(Type.String({ description: "Version ID to rollback to (mutually exclusive with batch_id)" })),
			batch_id: Type.Optional(Type.String({ description: "Batch ID to revert (reverts all memories created/updated in this batch)" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Validate: exactly one of version_id or batch_id
			if (!params.version_id && !params.batch_id) {
				throw new Error("Must provide either version_id or batch_id");
			}
			if (params.version_id && params.batch_id) {
				throw new Error("Provide only one of version_id or batch_id, not both");
			}

			const { global, project } = getStores(ctx.cwd);
			const stores = project ? [global, project] : [global];

			// ── Batch rollback path ──
			if (params.batch_id) {
				const reverted: string[] = [];
				const deleted: string[] = [];
				const notFound: string[] = [];
				const edgeCases: { memoryId: string; store: "global" | "project" }[] = [];

				// Pre-scan: collect memory IDs that have a "delete" version
				// in some store for this batch. We use this to detect
				// cross-store moves: if memory X has a "create" version in
				// store A and a "delete" version in store B within the same
				// batch, the move is being processed independently in each
				// store (A deletes, B restores). The end state is correct
				// (memory lives in source only after rollback), but worth
				// recording as a telemetry edge case so the user can audit
				// moves that happened during the batch.
				const deletedMemoryIds = new Set<string>();
				for (const store of stores) {
					const bv = store.findVersionsByBatchId(params.batch_id);
					for (const v of bv) {
						if (v.action === "delete") deletedMemoryIds.add(v.memory_id);
					}
				}

				for (const store of stores) {
					// Find all versions in this batch
					const batchVersions = store.findVersionsByBatchId(params.batch_id);
					if (batchVersions.length === 0) continue;

					// Group by memory_id
					const byMemory = new Map<string, typeof batchVersions>();
					for (const v of batchVersions) {
						if (!byMemory.has(v.memory_id)) byMemory.set(v.memory_id, []);
						byMemory.get(v.memory_id)!.push(v);
					}

					// Process each memory
					for (const [memoryId, memVersions] of byMemory) {
						// Sort by version_number ASC
						memVersions.sort((a, b) => a.version_number - b.version_number);
						const firstInBatch = memVersions[0];

						// Distinguish the three cases the batch can have:
						//   - "create" with v#=1: memory was first-ever created in this
						//     store by the batch (e.g., a fresh add). Rollback = delete.
						//   - "create" with v#>1: memory was re-created here by the batch
						//     (e.g., a move from another store). Rollback is a cross-store
						//     problem — see the moves handling below. For now we delete
						//     here, which loses the move; the source's "delete" version
						//     in the batch is what would tell us the move happened.
						//   - "update": memory was updated by the batch. Rollback = restore
						//     pre-batch state in place.
						//   - "delete": memory was deleted by the batch. Rollback = re-create
						//     from the pre-delete content. The previous code confused
						//     this with "memory vanished, nothing to do" and silently
						//     failed to restore.
						if (firstInBatch.action === "delete") {
							// Memory was DELETED in the batch. Re-create from the version
							// that was active just before the delete. findPreBatchVersion
							// returns the latest version whose batch_id is NOT this batch
							// (or null/undefined), which is exactly the pre-delete state.
							const preDelete = store.findPreBatchVersion(memoryId, params.batch_id);
							if (preDelete) {
								store.restoreMemory(preDelete as any);
								reverted.push(memoryId);
							} else {
								// Created AND deleted in the same batch — the memory was
								// never visible to anyone. The delete is a no-op since
								// the row is already gone. Record for accounting.
								deleted.push(memoryId);
							}
						} else if (firstInBatch.version_number === 1) {
							// Memory was CREATED in the batch. Delete it.
							// Edge case: this could also be the destination side of a
							// cross-store move (a "create" with v#=1 in this store that
							// has a corresponding "delete" in another store, also tagged
							// with this batch). We don't currently cross-reference stores
							// to detect moves, so the worst case is the user re-runs the
							// batch rollback: the second pass finds no versions (already
							// deleted) and is a no-op. The memory is gone from the
							// destination but still in the source (which is what we want).
							//
							// Record the edge case for telemetry. The rollback action
							// stays the same (delete from destination); the cross-store
							// move's source-side "delete" version is handled in the
							// OTHER store's pass below as a restore. End state: memory
							// lives in source only.
							if (deletedMemoryIds.has(memoryId)) {
								const storeName: "global" | "project" =
									store === global ? "global" : "project";
								edgeCases.push({ memoryId, store: storeName });
								observability.recordRollbackEdgeCase({
									memoryId,
									store: storeName,
									batchId: params.batch_id,
								});
							}
							store.deleteMemory(memoryId);
							deleted.push(memoryId);
						} else {
							// Memory was UPDATED in the batch - restore pre-batch state
							const preBatch = store.findPreBatchVersion(memoryId, params.batch_id);
							if (preBatch) {
								// Clean batchId from restored metadata
								const restoredMetadata = { ...(preBatch.metadata || {}) };
								delete restoredMetadata.batchId;

								store.updateMemory(memoryId, {
									content: preBatch.content,
									scope: preBatch.scope as any,
									scope_id: preBatch.scope_id,
									target: preBatch.target as any,
									category: preBatch.category as any,
									status: preBatch.status as any,
									tier: preBatch.tier as any,
									ttl_days: preBatch.ttl_days,
									metadata: restoredMetadata,
								});
								reverted.push(memoryId);
							} else {
								// No pre-batch version (shouldn't happen if version_number > 1)
								// Fall back to deleting the row rather than leaving it
								// in a state we can't reason about.
								store.deleteMemory(memoryId);
								deleted.push(memoryId);
							}
						}
					}
				}

				if (reverted.length === 0 && deleted.length === 0) {
					throw new Error(`No memories found for batch_id: ${params.batch_id}`);
				}

				// Clear current batch state if rolling back current batch
				if (currentBatchId === params.batch_id) {
					currentBatchId = null;
					lastAddTime = 0;
				}

				const summary = [
					`Batch ${params.batch_id} reverted:`,
					`  ${reverted.length} memory(ies) restored to pre-batch state (includes re-creations of deleted memories)`,
					`  ${deleted.length} memory(ies) deleted (created in batch)`,
				];
				if (edgeCases.length > 0) {
					summary.push(
						`  ${edgeCases.length} cross-store move(s) detected — each was processed independently in source/destination stores`,
					);
				}
				return toolResult(summary.join("\n"));
			}

			// ── Version rollback path (existing behavior) ──
			try {
				// Try rollback in global store first
				let restored = global.rollbackToVersion(params.version_id!);
				let store = global;

				// If not found, try project store
				if (!restored && project) {
					restored = project.rollbackToVersion(params.version_id!);
					store = project;
				}

				if (!restored) {
					throw new Error("Version not found");
				}

				return toolResult(`Rolled back to version. Memory ID: ${restored.id}`);
			} catch (err: any) {
				throw new Error(`Rollback failed: ${err.message}`);
			}
		},
	});

	// memory_audit
	pi.registerTool({
		name: "dream_memory_audit",
		label: "Dream Memory Audit",
		description: "Quality audit of the memory store — detects orphans, entity concentration, retention candidates, and distribution stats",
		promptSnippet: "Use dream_memory_audit to check memory store health. Run periodically or when memory quality seems degraded.",
		parameters: Type.Object({}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const stores = getStores(ctx.cwd);
			const { global, project } = stores;

			const globalAudit = global.audit();
			const projectAudit = project?.audit() ?? null;

			const lines: string[] = [];
			lines.push(`## Memory Audit Report`);
			lines.push(`### Global Store (${globalAudit.totalMemories} memories)`);
			lines.push("");
			lines.push("**Category Distribution:**");
			for (const [cat, count] of Object.entries(globalAudit.categoryDistribution)) {
				lines.push(`- ${cat}: ${count}`);
			}
			lines.push("");
			lines.push("**Status Distribution:**");
			for (const [status, count] of Object.entries(globalAudit.statusDistribution)) {
				lines.push(`- ${status}: ${count}`);
			}

			if (globalAudit.entityConcentration.length > 0) {
				lines.push("");
				lines.push("**High-Concentration Entities (>5 memories):**");
				for (const e of globalAudit.entityConcentration) {
					lines.push(`- \`${e.entity}\`: ${e.count} memories`);
				}
			}

			if (globalAudit.orphanMemories.length > 0) {
				lines.push("");
				lines.push(`**Orphan Candidates (${globalAudit.orphanMemories.length}):** (no tags, no links, short content)`);
				for (const o of globalAudit.orphanMemories.slice(0, 10)) {
					lines.push(`- [${o.category}] ${o.content}`);
				}
			}

			if (globalAudit.retentionCandidates.length > 0) {
				lines.push("");
				lines.push(`**Retention Candidates (${globalAudit.retentionCandidates.length}):** (>90 days old)`);
				for (const r of globalAudit.retentionCandidates.slice(0, 10)) {
					lines.push(`- [${r.age_days}d] ${r.content}`);
				}
			}

			if (projectAudit) {
				lines.push("");
				lines.push(`### Project Store (${projectAudit.totalMemories} memories)`);
				lines.push("**Category Distribution:**");
				for (const [cat, count] of Object.entries(projectAudit.categoryDistribution)) {
					lines.push(`- ${cat}: ${count}`);
				}
				if (projectAudit.entityConcentration.length > 0) {
					lines.push("");
					lines.push("**High-Concentration Entities:**");
					for (const e of projectAudit.entityConcentration) {
						lines.push(`- \`${e.entity}\`: ${e.count} memories`);
					}
				}
			}

			return toolResult(lines.join("\n"));
		},
	});

	// memory_expand
	pi.registerTool({
		name: "dream_memory_expand",
		label: "Dream Memory Expand",
		description: "Get full content of a memory by ID (for progressive disclosure — use after dream_memory_search with summaryMode)",
		promptSnippet: "Use dream_memory_expand to get the full content of a specific memory after seeing it in summary search results.",
		parameters: Type.Object({
			id: Type.String({ description: "Memory ID to expand" }),
			includeLinks: Type.Optional(Type.Boolean({ description: "Also return linked memories' summaries (default: false)" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const stores = getStores(ctx.cwd);
			const { global, project } = stores;

			const memory = global.getMemory(params.id) ?? project?.getMemory(params.id);
			if (!memory) {
				return toolResult(`Memory not found: ${params.id}`);
			}

			const lines: string[] = [];
			lines.push(`<memory id="${memory.id}" target="${memory.target}" category="${memory.category ?? "none"}" trust="${TRUST_LEVEL_NAMES[memory.trust_level ?? 2]}" kind="${memory.memory_kind ?? "semantic"}">`);
			lines.push(memory.content);
			lines.push("</memory>");

			if (memory.tags && memory.tags.length > 0) {
				lines.push(`Tags: ${memory.tags.join(", ")}`);
			}
			if (memory.metadata?.reason) {
				lines.push(`Reason: ${memory.metadata.reason}`);
			}
			if (memory.valid_from || memory.valid_until) {
				const from = memory.valid_from ? new Date(memory.valid_from).toISOString().split("T")[0] : "?";
				const to = memory.valid_until ? new Date(memory.valid_until).toISOString().split("T")[0] : "now";
				lines.push(`Valid: ${from} → ${to}`);
			}

			// Linked memories (optional)
			if (params.includeLinks && memory.metadata?.linked_to?.length > 0) {
				lines.push("");
				lines.push("**Linked memories:**");
				for (const link of memory.metadata.linked_to.slice(0, 5)) {
					const linked = global.getMemory(link.id) ?? project?.getMemory(link.id);
					if (linked) {
						const preview = linked.content.length > 60 ? linked.content.slice(0, 60) + "…" : linked.content;
						lines.push(`- [${link.relation}] ${preview} (${linked.id})`);
					}
				}
			}

			return toolResult(lines.join("\n"));
		},
	});

	// ── Session History Search ──
	// Search across past conversation sessions (JSONL files indexed into FTS5).
	// This is separate from memory_search which only searches stored memories.

	pi.registerTool({
		name: "dream_memory_session_search",
		label: "Dream Memory Session Search",
		description: "FTS5 search across past conversation sessions (not just stored memories). Returns matching user/assistant messages with snippets.",
		promptSnippet: "Use dream_memory_session_search to find what was discussed in past sessions — e.g. 'what did we discuss about auth?' or 'when did we fix the build?'. This searches raw conversation history, not just stored memories.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query (FTS5 syntax supported: AND, OR, phrases)" }),
			topK: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
			role: Type.Optional(StringEnum(["user", "assistant", "toolResult"], { description: "Filter by message role" })),
			since: Type.Optional(Type.Number({ description: "Timestamp ms lower bound" })),
			sessionId: Type.Optional(Type.String({ description: "Filter by session ID" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { global } = getStores(ctx.cwd);
			const db = (global as any).db;

			const results = searchSessionMessages(db, params.query, {
				topK: params.topK,
				role: params.role,
				since: params.since,
				sessionId: params.sessionId,
			});

			if (results.length === 0) {
				return toolResult("No session messages found");
			}

			const formatted = results.map((r, i) => {
				const date = new Date(r.timestamp).toISOString().split("T")[0];
				const age = formatRelativeAge(r.timestamp);
				return `${i + 1}. [${r.role}] ${r.snippet}\n   session=${r.sessionId.slice(0, 8)}, date=${date} (${age})`;
			}).join("\n\n");

			return toolResult(`${results.length} results:\n\n${formatted}`);
		},
	});

	pi.registerTool({
		name: "dream_memory_session_stats",
		label: "Dream Memory Session Stats",
		description: "Show statistics about indexed session messages",
		promptSnippet: "Use dream_memory_session_stats to see how many sessions and messages have been indexed for search.",
		parameters: Type.Object({}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { global } = getStores(ctx.cwd);
			const db = (global as any).db;
			const stats = getSessionIndexStats(db);
			return toolResult(
				`Session index stats:\n` +
				`  Total messages: ${stats.totalMessages}\n` +
				`  Total sessions: ${stats.totalSessions}\n` +
				`  Indexed files: ${stats.indexedFiles}`
			);
		},
	});

	// ── Commands ─────────────────────────────────────────────────────────

	// ── runDream: shared core for manual /dream and auto-dream ────────────

	interface RunDreamOptions {
		type: "manual" | "auto";
		args: string;
		ctx: any;
		requireConfirm: boolean;  // false = auto, skip user prompts
		skipPreviews: boolean;    // true = auto, don't show preview blocks
		/**
		 * F4 (dream delta): "full" re-clusters the entire corpus; "delta"
		 * only considers memories updated since the last dream run. Auto-dream
		 * always uses delta (cheap enough to run more often). Manual /dream
		 * defaults to delta but the user can pass `--full` to override.
		 */
		mode?: "full" | "delta";
	}

	interface RunDreamResult {
		ok: boolean;
		reason?: string;
		stats?: { input: number; output: number; expired: number; synth: number };
		dreamStores?: any;
	}

	async function runDream(opts: RunDreamOptions): Promise<RunDreamResult> {
		const { type, args, ctx, requireConfirm, skipPreviews, mode } = opts;
		const basePath = bankManager.getBasePath();

		// Resolve the global DreamStore. Without this, the bare identifier
		// `global` below would resolve to Node's `global` object (no
		// getDreamMeta method), and `/dream` would crash with
		// "global.getDreamMeta is not a function". This was a latent
		// bug — the call site relied on `global` being in scope from
		// a destructuring assignment, but runDream is a separate
		// function with its own scope. Pre-existing since b83b3b2.
		const { global } = getStores(ctx.cwd);

		// F4 (dream delta): compute the since timestamp once at the top
		// of runDream. The expired-memory sweep and synthesis both use
		// the same value so the sweep doesn't delete delta-only memories
		// that pre-date the last run. Auto-dream forces delta; manual
		// defaults to delta but `--full` overrides.
		const effectiveMode: "full" | "delta" =
			mode ?? (type === "auto" ? "delta" : "delta");
		// For delta mode we still process the full corpus for expired
		// memories (cleanup is global) but only synthesize new clusters
		// from post-since memories. The since cutoff is the previous
		// dream's lastRunAt, or 0 (full corpus) on the first run.
		const lastRunAt = global.getDreamMeta().lastRunAt ?? 0;
		const sinceCutoff = effectiveMode === "delta" ? lastRunAt : 0;

		// 1. Acquire lock (concurrency protection across instances)
		const lockResult = acquireLock(basePath, type);
		if (!lockResult.acquired) {
			const status = getLockStatus(basePath);
			const age = status.lock
				? Math.round((Date.now() - status.lock.startedAt) / 60000)
				: 0;
			ctx.ui.notify(
				`Dream: skipped (another ${status.lock?.type ?? "dream"} is running, ${age}m old)`,
				"warning",
			);
			return { ok: false, reason: "lock-held" };
		}

		try {
			const { global, project } = getStores(ctx.cwd);

			const globalStats = global.getStats();
			const projectStats = project ? project.getStats() : null;
			const totalMemories = globalStats.total + (projectStats?.total || 0);

			if (totalMemories === 0) {
				ctx.ui.notify("Dream: nothing to consolidate (0 memories)", "info");
				return { ok: true, reason: "empty" };
			}

			ctx.ui.notify(`Dream (${type}): ${totalMemories} memories to consolidate`, "info");

			// Clone both stores
			const dreamStores = bankManager.cloneStores({ cwd: ctx.cwd });

			// Track dream session
			currentDreamSession = {
				globalOutputBankId: dreamStores.globalOutputBankId,
				projectOutputBankId: dreamStores.projectOutputBankId,
				projectId: dreamStores.projectId,
			};

			ctx.ui.notify(`Dream: created output stores`, "info");

			// Parse instructions
			const instructions = parseInstructions(args || "");
			if (instructions.focus.length > 0) {
				ctx.ui.notify(`Dream: focusing on ${instructions.focus.join(", ")}`, "info");
			}
			if (instructions.ignore.length > 0) {
				ctx.ui.notify(`Dream: ignoring ${instructions.ignore.join(", ")}`, "info");
			}

			// Get output stores
			const { globalStore: globalOutput, projectStore: projectOutput } = bankManager.getDreamOutputStores(
				dreamStores.globalOutputBankId,
				dreamStores.projectOutputBankId
			);

			// Find expired memories in both stores
			const expiredGlobal = globalOutput.getExpiredMemories();
			const expiredProject = projectOutput ? projectOutput.getExpiredMemories() : [];
			const allExpired = [...expiredGlobal, ...expiredProject];

			if (allExpired.length > 0) {
				if (requireConfirm && !skipPreviews) {
					// Manual: show preview + ask confirmation
					const preview = allExpired
						.slice(0, 10)
						.map((m, i) => {
							const content = m.content.length > 60 ? m.content.slice(0, 60) + "..." : m.content;
							const ttl = m.ttl_days ? `${m.ttl_days}d` : "perm";
							return `  ${i + 1}. [${m.scope}:${m.target}] ${content} (${ttl})`;
						})
						.join("\n");

					const extra = allExpired.length > 10 ? `\n  ... and ${allExpired.length - 10} more` : "";

					const confirm = await ctx.ui.confirm(
						"Dream: Memories to remove",
						`${allExpired.length} expired memories will be removed:\n\n${preview}${extra}\n\nContinue?`
					);

					if (!confirm) {
						bankManager.discardDream(dreamStores);
						currentDreamSession = null;
						ctx.ui.notify("Dream: canceled", "info");
						return { ok: false, reason: "canceled" };
					}
				}

				// Auto: just log what will be removed (no preview spam)
				if (type === "auto") {
					ctx.ui.notify(`Dream (auto): removing ${allExpired.length} expired memories`, "info");
				}

				globalOutput.deleteExpiredMemories();
				if (projectOutput) projectOutput.deleteExpiredMemories();
				if (type === "manual") {
					ctx.ui.notify(`Dream: removed ${allExpired.length} expired memories`, "info");
				}
			} else if (requireConfirm && !skipPreviews) {
				// No expired memories, manual mode → still confirm
				const confirm = await ctx.ui.confirm(
					"Dream: Consolidate memory",
					`No expired memories found.\n\nInput: ${totalMemories} memories\n\nContinue with consolidation?`
				);

				if (!confirm) {
					bankManager.discardDream(dreamStores);
					currentDreamSession = null;
					ctx.ui.notify("Dream: canceled", "info");
					return { ok: false, reason: "canceled" };
				}
			}

			// === Synthesis step: detect patterns and create synthesis memories ===
			// Pass focusTerms through so candidates matching the user's
			// `/dream focus on X` directive get a confidence boost and bubble
			// to the top of the list before the maxResults cap trims it.
			// Ignore is still applied post-hoc (see filterByInstructions below)
			// because filtering out a candidate is a stronger action than
			// reordering.
			const synthesisGlobal = await findSynthesisCandidates(globalOutput, {
				minClusterSize: 3,
				focusTerms: instructions.focus,
				since: sinceCutoff,
			});
			const synthesisProject = projectOutput
				? await findSynthesisCandidates(projectOutput, {
						minClusterSize: 3,
						focusTerms: instructions.focus,
						since: sinceCutoff,
					})
				: [];
			// Apply user-supplied ignore instructions: drop any candidate
			// whose synthesized content matches an ignore term.
			const filterByInstructions = (candidates: typeof synthesisGlobal) => {
				if (instructions.ignore.length === 0) return candidates;
				return candidates.filter((c) => {
					const haystack = (c.synthesizedContent + " " + c.pattern).toLowerCase();
					return !instructions.ignore.some((term) => haystack.includes(term.toLowerCase()));
				});
			};
			const allSynthesis = [
				...filterByInstructions(synthesisGlobal),
				...filterByInstructions(synthesisProject),
			];

			if (allSynthesis.length > 0) {
				if (requireConfirm && !skipPreviews) {
					// Manual: show preview + ask
					const synthPreview = allSynthesis
						.slice(0, 5)
						.map((c, i) => {
							const content = c.synthesizedContent.length > 80
								? c.synthesizedContent.slice(0, 80) + "..."
								: c.synthesizedContent;
							return `  ${i + 1}. [${c.target}:${c.category}] ${content}\n     Pattern: ${c.pattern} (${c.sourceIds.length} sources, confidence: ${(c.confidence * 100).toFixed(0)}%)`;
						})
						.join("\n");

					const extra = allSynthesis.length > 5 ? `\n  ... and ${allSynthesis.length - 5} more` : "";

					const confirmSynth = await ctx.ui.confirm(
						"Dream: Synthesis patterns detected",
						`${allSynthesis.length} patterns detected. ${allSynthesis.length} synthesis memories will be created:\n\n${synthPreview}${extra}\n\nCreate syntheses?`
					);

					if (confirmSynth) {
						// Pass scope info explicitly so synthesis memories land in the
						// correct store. globalOutput syntheses get scope=global,
						// projectOutput syntheses get scope=project + scope_id=projectId.
						const synthResultGlobal = applySynthesis(globalOutput, synthesisGlobal, { scope: "global", scopeId: null });
						const synthResultProject = projectOutput
							? applySynthesis(projectOutput, synthesisProject, { scope: "project", scopeId: dreamStores.projectId })
							: { created: [], markedConsolidated: [] };
						const totalCreated = synthResultGlobal.created.length + synthResultProject.created.length;
						ctx.ui.notify(`Dream: created ${totalCreated} synthesis memories from patterns`, "info");
					}
				} else {
					// Auto: apply synthesis without prompting
					const synthResultGlobal = applySynthesis(globalOutput, synthesisGlobal, { scope: "global", scopeId: null });
					const synthResultProject = projectOutput
						? applySynthesis(projectOutput, synthesisProject, { scope: "project", scopeId: dreamStores.projectId })
						: { created: [], markedConsolidated: [] };
					const totalCreated = synthResultGlobal.created.length + synthResultProject.created.length;
					if (totalCreated > 0) {
						ctx.ui.notify(`Dream (auto): created ${totalCreated} synthesis memories`, "info");
					}
				}
			}

			// R4 v3: re-cluster stale syntheses. Runs after main synthesis so
			// newly-created syntheses don't immediately get reclustered (they
			// were just created; no new siblings exist yet). Uses the LIVE
			// stores (where existing syntheses live) — output stores are
			// clones for the main synthesis's create+mark operations.
			// Best-effort: failures here don't fail the whole dream run.
			//
			// CRITICAL: re-fetch stores here. `cloneStores` was called above
			// and may have closed the captured `global` / `project`
			// variables (open handles transferred to output clones). Using
			// the captured reference would throw "The database connection is
			// not open" — same trap that affected `recordDreamRun` below.
			const liveStoresForR4 = getStores(ctx.cwd);
			try {
				const reclusterGlobal = reclusterStaleSyntheses(liveStoresForR4.global, {
					minNewSiblings: 2,
					minDaysSinceUpdate: 1,
				});
				const reclusterProject = liveStoresForR4.project
					? reclusterStaleSyntheses(liveStoresForR4.project, { minNewSiblings: 2, minDaysSinceUpdate: 1 })
					: { reclustered: 0, checked: 0, skipped: 0, updated: [] };
				const totalReclustered = reclusterGlobal.reclustered + reclusterProject.reclustered;
				if (totalReclustered > 0) {
					ctx.ui.notify(
						`Dream (R4): reclustered ${totalReclustered} stale synthesis memor${totalReclustered === 1 ? "y" : "ies"}`,
						"info",
					);
				}
			} catch (e: any) {
				// Don't fail the dream run on recluster errors — logging via
				// the observability module is enough; the user will see
				// "Dream: N created" without the R4 line.
				console.error("[dream] R4 recluster failed:", e.message);
			}

			// Gap #5: GC stale memories. Runs after R4 so newly-superseded
			// memories from synthesis don't get re-evaluated as candidates.
			// Best-effort: errors here don't fail the whole dream run.
			// Re-fetch stores again (defensive: any code between R4 and GC
			// that touches stores could also affect handle validity).
			const liveStoresForGC = getStores(ctx.cwd);
			try {
				const gcGlobal = garbageCollectStaleMemories(liveStoresForGC.global);
				const gcProject = liveStoresForGC.project
					? garbageCollectStaleMemories(liveStoresForGC.project)
					: { checked: 0, gcCount: 0, skipped: 0, ids: [], details: [] };
				const totalGc = gcGlobal.gcCount + gcProject.gcCount;
				if (totalGc > 0) {
					ctx.ui.notify(
						`Dream (GC): superseded ${totalGc} stale memor${totalGc === 1 ? "y" : "ies"}`,
						"info",
					);
				}
			} catch (e: any) {
				console.error("[dream] GC failed:", e.message);
			}

			// Vacuum output stores
			globalOutput.vacuum();
			if (projectOutput) projectOutput.vacuum();

			const globalOutputStats = globalOutput.getStats();
			const projectOutputStats = projectOutput ? projectOutput.getStats() : null;

			// Record dream run in stats (used by auto-dream scheduler)
			const stats = {
				input: totalMemories,
				output: globalOutputStats.total + (projectOutputStats?.total || 0),
				expired: allExpired.length,
				synth: allSynthesis.length,
			};
			// Re-fetch the live global reference: `cloneStores` may have closed
			// and reopened the underlying connection, leaving the captured `global`
			// Re-fetch the live global reference: `cloneStores` may have closed
			// and reopened the underlying connection, leaving the captured `global`
			// variable pointing to a stale, closed instance. Using it here would
			// throw "The database connection is not open" and abort the dream.
			//
			// recordDreamRun is best-effort telemetry for the auto-dream
			// scheduler. If the write fails (DB locked, file system error),
			// log and continue — the dream itself succeeded and we should
			// not abort the auto-accept path over a metadata side-effect.
			// The previous code propagated the exception, which caused auto
			// dreams to silently skip the accept step while still reporting
			// "complete" via the try/finally path.
			const liveStores = getStores(ctx.cwd);
			try {
				liveStores.global.recordDreamRun(type, stats);
			} catch (err: any) {
				console.warn(`[dream] recordDreamRun failed (non-fatal): ${err.message}`);
			}

			if (type === "manual") {
				// Manual: leave dreamStores pending for /dream-accept or /dream-discard
				ctx.ui.notify(
					`Dream complete!\n` +
					`Global: ${globalStats.total} → ${globalOutputStats.total} memories\n` +
					(projectStats ? `Project: ${projectStats.total} → ${projectOutputStats?.total || 0} memories\n` : "") +
					`\nUse /dream-accept to replace input with output\n` +
					`Use /dream-discard to discard output`,
					"info"
				);
				return { ok: true, stats, dreamStores };
			} else {
				// Auto: auto-accept (the whole point of auto-dream is no user interaction)
				bankManager.acceptDream(currentDreamSession!);
				currentDreamSession = null;
				ctx.ui.notify(
					`Dream (auto) complete: ${globalStats.total} → ${globalOutputStats.total + (projectOutputStats?.total || 0)} memories (auto-accepted)`,
					"info",
				);
				return { ok: true, stats };
			}
		} finally {
			// Always release lock, even on error
			releaseLock(basePath);
		}
	}

	// /dream — Consolidate memory (creates output stores)
	pi.registerCommand("dream", {
		description: "Consolidate memory (delta by default; --full forces re-cluster of entire corpus; --preview shows what would be created without applying). Usage: /dream [--full|--preview] [instructions]",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			// Parse flags. --full and --preview are mutually exclusive.
			const parts = (args || "").split(/\s+/).filter(Boolean);
			const fullIdx = parts.indexOf("--full");
			const previewIdx = parts.indexOf("--preview");
			const mode: "full" | "delta" = fullIdx >= 0 ? "full" : "delta";
			const preview = previewIdx >= 0;
			const filteredArgs = (fullIdx >= 0 || previewIdx >= 0)
				? parts.filter((_, i) => i !== fullIdx && i !== previewIdx).join(" ")
				: args || "";

			// Gap #7: /dream --preview shows what synthesis candidates
			// would be created WITHOUT applying. Dry-run for the dream
			// command. User reviews the preview and runs /dream without
			// --preview to actually create the memories.
			if (preview) {
				const { global, project } = getStores(ctx.cwd);
				const parseResult = filteredArgs.trim()
					? parseInstructions(filteredArgs)
					: { focus: [] as string[], preserve: [], ignore: [], merge: true, outputFormat: "flat" as const, raw: "" };
				const focusTerms = parseResult.focus || [];

				const globalCandidates = await findSynthesisCandidates(global, {
					minClusterSize: 3,
					...((focusTerms.length > 0) ? { focusTerms } : {}),
				});
				const projectCandidates = project
					? await findSynthesisCandidates(project, {
							minClusterSize: 3,
							...((focusTerms.length > 0) ? { focusTerms } : {}),
						})
					: [];

				const total = globalCandidates.length + projectCandidates.length;
				if (total === 0) {
					ctx.ui.notify("[preview] /dream: no synthesis candidates found. Nothing would be created.", "info");
					return;
				}

				const lines: string[] = [`[preview] /dream: would create ${total} synthesis memor${total === 1 ? "y" : "ies"}:`];
				for (const c of [...globalCandidates, ...projectCandidates]) {
					const confidencePct = Math.round(c.confidence * 100);
					const previewText = c.synthesizedContent.slice(0, 80).replace(/\n/g, " ");
					lines.push(`  [${c.target}:${c.category}] (${c.sourceIds.length} sources, ${confidencePct}%) "${previewText}..."`);
				}
				lines.push(`\nRun /dream (without --preview) to create these.`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			await runDream({
				type: "manual",
				args: filteredArgs,
				ctx,
				requireConfirm: true,
				skipPreviews: false,
				mode,
			});
		},
	});

	// /dream-accept — Replace input stores with dream output
	pi.registerCommand("dream-accept", {
		description: "Accept dream output: replaces input stores with output stores",
		handler: async (args, ctx) => {
			if (!currentDreamSession) {
				ctx.ui.notify("No active dream session. Run /dream first.", "warning");
				return;
			}

			bankManager.acceptDream(currentDreamSession);

			ctx.ui.notify(
				`Dream accepted! Input stores replaced with output.\n` +
				`Old input stores archived.`,
				"info"
			);

			currentDreamSession = null;
		},
	});

	// /dream-discard — Discard dream output
	pi.registerCommand("dream-discard", {
		description: "Discard dream output: deletes output stores, keeps input unchanged",
		handler: async (args, ctx) => {
			if (!currentDreamSession) {
				ctx.ui.notify("No active dream session. Run /dream first.", "warning");
				return;
			}

			bankManager.discardDream(currentDreamSession);

			ctx.ui.notify("Dream output discarded. Input stores unchanged.", "info");
			currentDreamSession = null;
		},
	});

	// /dream-upgrade — One-shot backfill: re-synthesize existing syntheses
	// with the current template (e.g., upgrade old "Facts:" format to the
	// R2 v3 "Approach:" format). Use after deploying a new synthesis
	// template. Idempotent by default: syntheses already in the current
	// format are skipped (Gate 4: content unchanged).
	//
	// Flags:
	//   --dry-run    compute what would change but don't write
	//   --verbose    show per-synthesis diff (old + new content snippet,
	//                and the reason for any skip)
	//   --force      also bypass Gate 4 (content-unchanged); always write
	//                even if re-synthesize produces the same content.
	//                Useful for forcing a re-templating / date-stamp update.
	pi.registerCommand("dream-upgrade", {
		description: "Backfill: re-synthesize all active syntheses with the current template",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const { global, project } = getStores(ctx.cwd);

			const dryRun = args.includes("--dry-run");
			const verbose = args.includes("--verbose");
			const forceWrite = args.includes("--force");
			const opts = { force: true, dryRun, bypassContentCheck: forceWrite };

			const resultGlobal = reclusterStaleSyntheses(global, opts);
			const resultProject = project
				? reclusterStaleSyntheses(project, opts)
				: { checked: 0, reclustered: 0, skipped: 0, updated: [], details: [] };
			const allDetails = [...resultGlobal.details, ...resultProject.details];
			const totalChecked = resultGlobal.checked + resultProject.checked;
			const totalReclustered = resultGlobal.reclustered + resultProject.reclustered;
			const totalSkipped = resultGlobal.skipped + resultProject.skipped;

			const prefix = dryRun ? "[dry-run] " : "";
			if (totalReclustered === 0 && totalSkipped === 0) {
				ctx.ui.notify(`${prefix}/dream-upgrade: no active syntheses`, "info");
			} else {
				const skipWord = forceWrite ? "skipped (other gates)" : "already current";
				ctx.ui.notify(
					`${prefix}/dream-upgrade: ${totalReclustered} upgraded, ${totalSkipped} ${skipWord} (of ${totalChecked} total)`,
					"info",
				);
			}

			// Verbose: per-synthesis breakdown with content snippets and
			// skip reasons. Helps debug "is this thing upgrading or not?"
			if (verbose && allDetails.length > 0) {
				const lines: string[] = [];
				for (const d of allDetails) {
					if (d.action === "reclustered") {
						const oldPreview = (d.oldContent ?? "").slice(0, 60).replace(/\n/g, " ");
						const newPreview = (d.newContent ?? "").slice(0, 60).replace(/\n/g, " ");
						lines.push(`  [${d.id.slice(0, 8)}] reclustered (${d.reason}): "${oldPreview}..." → "${newPreview}..."`);
					} else {
						lines.push(`  [${d.id.slice(0, 8)}] skipped: ${d.reason}`);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});

	// /distill — Extract patterns and generate skills
	pi.registerCommand("distill", {
		description: "Extract patterns from tool usage and generate skills. Shows preview first.",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const { global, project } = getStores(ctx.cwd);

			const patterns = getUsagePatterns(global, config.distill.minPatternFrequency);
			const analyzed = analyzePatterns(patterns, config.distill.minConfidence);

			const candidates = analyzed.filter((p) => p.shouldDistill);

			if (candidates.length === 0) {
				ctx.ui.notify("Distill: no patterns found with sufficient confidence", "info");
				return;
			}

			const skillsDir = join(ctx.cwd, ".pi", "skills");

			// Filter out existing skills
			const newCandidates = candidates.filter((p) => !skillExists(p, skillsDir));

			if (newCandidates.length === 0) {
				ctx.ui.notify("Distill: all patterns already have skills", "info");
				return;
			}

			// Show preview
			const preview = newCandidates
				.map((p, i) => {
					const name = `auto-${p.tool}-${p.argsHash.slice(0, 8)}`;
					return `${i + 1}. ${name} (${p.frequency} uses, confidence: ${(p.confidence * 100).toFixed(0)}%)\n   Pattern: ${p.argsPreview.slice(0, 80)}`;
				})
				.join("\n\n");

			const confirm = await ctx.ui.confirm(
				"Distill: Skills to create",
				`${newCandidates.length} patterns found:\n\n${preview}\n\nCreate these skills?`
			);

			if (!confirm) {
				ctx.ui.notify("Distill: canceled", "info");
				return;
			}

			// Create skills
			let generated = 0;
			for (const pattern of newCandidates) {
				saveSkill(pattern, skillsDir);
				generated++;
			}

			observability.recordDistill({ patterns: newCandidates.length, generated });
			ctx.ui.notify(`Distill: ${generated} skills created`, "info");
		},
	});

	// /dream-doctor — Diagnose memory system
	pi.registerCommand("dream-doctor", {
		description: "Diagnose memory system health",
		handler: async (args, ctx) => {
			const { global, project } = getStores(ctx.cwd);
			const globalStats = global.getStats();
			const projectStats = project ? project.getStats() : null;

			// Read the last eval score from global.db's stats table. Cached
			// by /dream-eval so we don't re-run on every doctor call.
			const { loadEvalScore, formatEvalScoreForDoctor } = await import("./evals/runner.js");
			const evalLine = formatEvalScoreForDoctor(loadEvalScore(global));

			// F5: gather top-accessed memories, stale inferred, last
			// contradiction, disk usage, and consolidation suggestions.
			// Each is a best-effort section — if any throws, the doctor
			// still shows the rest (defense in depth: the report itself
			// should never fail the user).
			const sections: string[] = ["Dream Memory Health", "==================="];

			sections.push("");
			sections.push("Corpus:");
			sections.push(`  Global: ${globalStats.total} memories`);
			sections.push(`  Project: ${projectStats ? projectStats.total : 0} memories`);
			sections.push(`  Expired pending cleanup: ${globalStats.expired + (projectStats?.expired || 0)}`);

			// Top accessed (across both stores)
			try {
				const allMems = [
					...global.listMemories({ status: "active", limit: 1000 }),
					...(project ? project.listMemories({ status: "active", limit: 1000 }) : []),
				];
				const top = allMems
					.filter((m) => m.access_count > 0)
					.sort((a, b) => b.access_count - a.access_count)
					.slice(0, 5);
				if (top.length > 0) {
					sections.push("");
					sections.push("Top 5 by access count:");
					for (const m of top) {
						const preview = m.content.length > 50 ? m.content.slice(0, 47) + "..." : m.content;
						sections.push(`  ${m.access_count}x [${m.target}${m.category ? ":" + m.category : ""}] ${preview}`);
					}
				}
			} catch (err: any) {
				sections.push(`  (top accessed unavailable: ${err.message})`);
			}

			// Stale inferred (auto-captures never accessed in 30d, candidate
			// for /dream-purge or auto-cleanup)
			try {
				const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
				const cutoff = Date.now() - THIRTY_DAYS;
				const stale = [
					...global.listMemories({ status: "active", limit: 5000 }),
					...(project ? project.listMemories({ status: "active", limit: 5000 }) : []),
				].filter((m) =>
					m.confidence === "inferred" &&
					m.access_count === 0 &&
					!m.last_accessed_at &&
					m.created_at < cutoff,
				);
				if (stale.length > 0) {
					sections.push("");
					sections.push(`Stale inferred (auto-captures unused for 30d+): ${stale.length}`);
					sections.push(`  /dream-purge to remove`);
				}
			} catch (err: any) {
				sections.push(`  (stale check unavailable: ${err.message})`);
			}

			// Last contradiction action
			try {
				const lastContradiction = observability.getMetrics().contradictions;
				if (lastContradiction.detected > 0) {
					const summary = `Detected: ${lastContradiction.detected} | Auto: ${lastContradiction.autoResolved} | Kept: ${lastContradiction.keptBoth} | Discarded: ${lastContradiction.discarded}`;
					sections.push("");
					sections.push(`Contradictions: ${summary}`);
				}
			} catch (err: any) {
				// observability is best-effort
			}

			// Consolidation suggestions
			try {
				const unconsolidated = [
					...global.getUnconsolidatedMemories({ limit: 5000 }),
					...(project ? project.getUnconsolidatedMemories({ limit: 5000 }) : []),
				];
				// Heuristic: if 5+ memories share a (target, category), suggest
				// /dream to consolidate them. A precise count requires
				// running findSynthesisCandidates which is the same cost
				// as /dream itself; the heuristic is a cheap upper bound.
				const grouped = new Map<string, number>();
				for (const m of unconsolidated) {
					const k = `${m.target}:${m.category || "uncategorized"}`;
					grouped.set(k, (grouped.get(k) || 0) + 1);
				}
				const clusterable = Array.from(grouped.entries()).filter(([, n]) => n >= 5);
				if (clusterable.length > 0) {
					sections.push("");
					sections.push("Possible consolidation clusters (5+ same target/category):");
					for (const [k, n] of clusterable.slice(0, 3)) {
						sections.push(`  ${k} → ${n} memories — try /dream focus on ${k.split(":")[0]}`);
					}
				}
			} catch (err: any) {
				// best-effort
			}

			// Disk usage
			try {
				const basePath = bankManager.getBasePath();
				const fs = await import("node:fs");
				if (fs.existsSync(basePath)) {
					let totalBytes = 0;
					let fileCount = 0;
					for (const f of fs.readdirSync(basePath)) {
						try {
							const stat = fs.statSync(`${basePath}/${f}`);
							if (stat.isFile()) {
								totalBytes += stat.size;
								fileCount++;
							}
						} catch {
							// file vanished
						}
					}
					sections.push("");
					sections.push(`Disk: ${fileCount} files, ${formatBytes(totalBytes)}`);
				}
			} catch (err: any) {
				// best-effort
			}

			sections.push("");
			sections.push(evalLine);

			ctx.ui.notify(sections.join("\n"), "info");
		},
	});

	// /dream-status — Show metrics
	pi.registerCommand("dream-status", {
		description: "Show memory system metrics",
		handler: async (args, ctx) => {
			const { global, project } = getStores(ctx.cwd);
			const globalStats = global.getStats();
			const projectStats = project ? project.getStats() : null;

			// Compose a 2-line widget with the most actionable info: totals +
			// health (expired pending cleanup). Kept short so it fits in the
			// TUI status bar without truncation.
			const total = globalStats.total + (projectStats?.total || 0);
			const expiredPending = globalStats.expired + (projectStats?.expired || 0);
			const projectId = bankManager.resolveProjectId(ctx.cwd);

			const widget = [
				`Memory: ${total} (G:${globalStats.total} P:${projectStats?.total || 0}) | Expired: ${expiredPending}`,
				`Project: ${projectId ?? "none"} | Scope: ${currentSessionId ? "active session" : "no session"}`,
			];

			ctx.ui.setWidget("dream-memory", widget);
		},
	});

	// /dream-popup — Show last recall
	pi.registerCommand("dream-popup", {
		description: "Show last recalled memories",
		handler: async (args, ctx) => {
			if (!lastRecallContent) {
				ctx.ui.notify("No memories recalled yet", "info");
				return;
			}

			ctx.ui.notify(lastRecallContent, "info");
		},
	});

	// /dream-metrics — Show observability report
	pi.registerCommand("dream-metrics", {
		description: "Show detailed observability metrics",
		handler: async (args, ctx) => {
			const report = observability.getFormattedReport();
			ctx.ui.notify(report, "info");
		},
	});

	// /dream-list — List memories with filters
	// Usage:
	//   /dream-list                    → active memories (default, hides archived)
	//   /dream-list --all              → all memories including superseded
	//   /dream-list --full             → show full content (no 115-char truncation)
	//   /dream-list project user preference → active project/user preference
	//   /dream-list --all resolved     → only resolved memories
	// Flags can be combined: `/dream-list --all --full` shows full content of
	// all memories including archived ones.
	pi.registerCommand("dream-list", {
		description: "List memories (active by default). Usage: /dream-list [--all] [--full] [scope] [target] [category] [status]",
		handler: async (args, ctx) => {
			const { global, project } = getStores(ctx.cwd);

			// Parse args: /dream-list [--all] [--full] [scope] [target] [category] [status]
			const parts = (args || "").split(/\s+/).filter(Boolean);
			let showAll = false;
			let showFull = false;
			let statusFilter: string | undefined = "active";  // default
			const filterParts: (string | undefined)[] = [];
			for (const p of parts) {
				if (p === "--all" || p === "all") {
					showAll = true;
					statusFilter = undefined;
				} else if (p === "--full" || p === "full") {
					showFull = true;
				} else if (["active", "resolved", "superseded"].includes(p)) {
					statusFilter = p;
				} else {
					filterParts.push(p);
				}
			}
			const scopeFilter = filterParts[0] as Memory["scope"] | undefined;
			const targetFilter = filterParts[1] as Memory["target"] | undefined;
			const categoryFilter = filterParts[2] as Memory["category"] | undefined;

			// List from both stores
			const globalMemories = global.listMemories({
				scope: scopeFilter,
				target: targetFilter,
				category: categoryFilter,
				status: statusFilter as any,
				limit: 50,
			});

			let projectMemories: typeof globalMemories = [];
			if (project) {
				projectMemories = project.listMemories({
					scope: scopeFilter,
					target: targetFilter,
					category: categoryFilter,
					status: statusFilter as any,
					limit: 50,
				});
			}

			// Merge and sort by updated_at
			const memories = [...globalMemories, ...projectMemories]
				.sort((a, b) => b.updated_at - a.updated_at)
				.slice(0, 50);

			if (memories.length === 0) {
				ctx.ui.notify("No memories found", "info");
				return;
			}

			const lines = memories.map((m, i) => {
				const ttl = m.ttl_days ? `${m.ttl_days}d` : "perm";
				const date = new Date(m.created_at).toISOString().split("T")[0];
				const age = formatRelativeAge(m.created_at);
				const category = m.category ? `:${m.category}` : "";
				// --full bypasses the 115-char cap so the user can read
				// the full memory in the TUI without piping through
				// /dream-get. Default caps to one TUI line.
				const content = showFull ? m.content : truncateForPreview(m.content);
				return `${i + 1}. [${m.target}${category}] ${content} (${ttl}, ${date}, ${age})`;
			});

			const header = scopeFilter || targetFilter || categoryFilter
				? `Filters: ${scopeFilter || "*"} / ${targetFilter || "*"} / ${categoryFilter || "*"} (status: ${statusFilter ?? "all"})`
				: (statusFilter
					? `${statusFilter[0].toUpperCase() + statusFilter.slice(1)} memories (${memories.length}) — pass --all to see archived, --full for no truncation`
					: `All memories (${memories.length}) — pass --full for no truncation`);

			ctx.ui.notify(`${header}:

${lines.join("\n")}`, "info");
		},
	});

	// /dream-cleanup — Interactive cleanup with preview
	// (Auto-cleanup runs on session_start; this command is for manual preview/confirmation
	//  and bypasses the age threshold so the user can force-clean regardless of file age.)
	pi.registerCommand("dream-cleanup", {
		description: "Preview and remove old/pending files. Auto-runs on session_start.",
		handler: async (args, ctx) => {
			const basePath = bankManager.getBasePath();
			const currentProjectId = bankManager.resolveProjectId(ctx.cwd);

			// Force-evaluate regardless of age for the manual command.
			// dryRun:true so files are NOT actually deleted before the user
			// confirms — previous code called without dryRun, which made
			// the confirm dialog cosmetic (deletion already happened).
			const preview = autoCleanupFiles(
				basePath,
				{ maxAgeMs: 0, dryRun: true },
				currentProjectId,
				currentDreamSession,
			);

			if (preview.deleted === 0) {
				ctx.ui.notify("Cleanup: nothing to clean", "info");
				return;
			}

			// Show preview and confirm
			const fileList = preview.deletedFiles.join("\n  - ");
			const confirm = await ctx.ui.confirm(
				`Cleanup: ${preview.deleted} file(s) (${formatBytes(preview.bytesReclaimed)})`,
				`Files to delete:\n  - ${fileList}\n\nDelete?`,
			);

			if (!confirm) {
				ctx.ui.notify("Cleanup: canceled", "info");
				return;
			}

			// Actually run cleanup with the configured age threshold.
			// Same params as the preview (maxAgeMs:0) so we delete exactly
			// the files the user just confirmed — not a different set filtered
			// by age. The age threshold is enforced by auto-cleanup on
			// session_start, not here.
			const result = autoCleanupFiles(
				basePath,
				{ maxAgeMs: 0 },
				currentProjectId,
				currentDreamSession,
			);
			ctx.ui.notify(
				`Cleanup: deleted ${result.deleted} file(s) (${formatBytes(result.bytesReclaimed)})`,
				"info",
			);
		},
	});

	// /dream-purge — Remove all non-permanent memories
	pi.registerCommand("dream-purge", {
		description: "Remove all temporary (non-permanent) memories. Shows preview first.",
		handler: async (args, ctx) => {
			const { global, project } = getStores(ctx.cwd);

			// Find non-permanent memories in both stores
			const allMemories = [
				...global.listMemories({ limit: 10000 }),
				...project ? project.listMemories({ limit: 10000 }) : [],
			];

			const temporary = allMemories.filter((m) => m.ttl_days !== null && m.ttl_days !== undefined);

			if (temporary.length === 0) {
				ctx.ui.notify("Purge: no temporary memories found", "info");
				return;
			}

			// Show preview (first 10)
			const preview = temporary
				.slice(0, 10)
				.map((m, i) => {
					const content = m.content.length > 60 ? m.content.slice(0, 60) + "..." : m.content;
					return `  ${i + 1}. [${m.scope}:${m.target}] ${content} (${m.ttl_days}d)`;
				})
				.join("\n");

			const extra = temporary.length > 10 ? `\n  ... and ${temporary.length - 10} more` : "";

			const confirm = await ctx.ui.confirm(
				"Purge: Temporary memories",
				`${temporary.length} temporary memories will be deleted:\n\n${preview}${extra}\n\nDelete all?`
			);

			if (!confirm) {
				ctx.ui.notify("Purge: canceled", "info");
				return;
			}

			// Delete from the store that actually holds the memory. Per
			// resolveStoreForScope (store/bank.ts), scope maps to:
			//   - global, agent, session -> global.db
			//   - project -> project.db (with global.db fallback if no project)
			// The previous code assumed agent/session lived in the project
			// store (wrong), and tried to delete scope=global from project.db
			// (also wrong — always returned false). Both paths were dead.
			let deleted = 0;
			for (const mem of temporary) {
				let ok = false;
				if (mem.scope === "project" && project) {
					ok = project.deleteMemory(mem.id);
				}
				// Fallback: project memory in a cwd without a project store
				// (e.g., memories were saved with scope:project into global.db
				// from the legacy saveSignal bug). Without this, those rows
				// are silently skipped → "deleted 0" even after the user
				// confirmed the deletion.
				if (!ok) {
					ok = global.deleteMemory(mem.id);
				}
				if (ok) deleted++;
			}

			// Undo auto-capture state for purged memories: clear the captured_at
			// timestamp on the corresponding tool_usage rows so the auto-capture
			// pipeline can detect the same pattern again (if the user keeps using
			// the tool many times, a fresh memory may be created). Previous code
			// called markToolUsageCaptured (the opposite) which permanently
			// disabled auto-capture for that (tool, argsHash) tuple.
			//
			// tool_usage always lives in global.db (trackToolCall writes there
			// unconditionally in tool_execution_end), so we always reset via the
			// global store — regardless of the memory's scope.
			let resetRows = 0;
			for (const mem of temporary) {
				const meta = mem.metadata as any;
				if (meta?.sourceType !== "auto-capture" || !meta?.tool || !meta?.argsHash) continue;
				resetRows += global.markToolUsageUncaptured({
					tool: meta.tool,
					argsHash: meta.argsHash,
					since: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30d lookback matches typical TTL
				});
			}

			const summary = resetRows > 0
				? `Purge: deleted ${deleted} temporary memories, uncaptured ${resetRows} tool_usage rows`
				: `Purge: deleted ${deleted} temporary memories`;
			ctx.ui.notify(summary, "info");
		},
	});

	// /dream-eval — Regression eval runner for the recall/scoring heuristics.
	// Loads evals/cases.json, runs each case against the current global.db,
	// and reports precision/recall metrics. Use this after changing
	// search/hybrid.ts, ttl/decay.ts, or scoring thresholds to catch
	// silent regressions in recall quality.
	pi.registerCommand("dream-eval", {
		description: "Run regression evals against the current recall heuristics. See evals/cases.json.",
		handler: async (args, ctx) => {
			// Lazy import to keep evals/ out of the critical load path.
			const { runEvals, formatEvalSummary, saveEvalScore } = await import("./evals/runner.js");
			const { readFileSync, existsSync } = await import("node:fs");
			const { join } = await import("node:path");
			const { fileURLToPath } = await import("node:url");
			const { dirname } = await import("node:path");

			// Resolve cases.json relative to this file (the extension's root).
			const __filename = fileURLToPath(import.meta.url);
			const __dirname = dirname(__filename);
			const casesPath = join(__dirname, "evals", "cases.json");
			if (!existsSync(casesPath)) {
				ctx.ui.notify(`dream-eval: cases.json not found at ${casesPath}`, "error");
				return;
			}

			let parsed: { cases: any[]; k?: number };
			try {
				parsed = JSON.parse(readFileSync(casesPath, "utf-8"));
			} catch (err: any) {
				ctx.ui.notify(`dream-eval: failed to parse cases.json: ${err.message}`, "error");
				return;
			}

			// Run against the current project's global store. We test against
			// the LIVE data — cases that fail here usually mean "this memory
			// is missing from the user's store", not "the heuristic broke".
			// For a controlled seed-and-test, the user can pipe a tmp store.
			// Note: this command handler is OUTSIDE the closure that holds
			// `global` (the DreamStore from getStores), so we resolve it here.
			// Without this, `global` is the Node globalThis and TS rejects the
			// call to runEvals/saveEvalScore.
			const { global: globalStore } = getStores(ctx.cwd);
			const topK = parsed.k ?? 5;
			const summary = runEvals(globalStore, {
				cases: parsed.cases,
				topK,
			});

			// Persist the score so /dream-doctor can show it without re-running.
			saveEvalScore(globalStore, summary);

			const formatted = formatEvalSummary(summary);
			// Use "warning" instead of "warn" — the Pi notification API
			// accepts "info" | "warning" | "error". The previous "warn" was
			// silently downgraded to "info" at runtime; the typecheck error
			// is what surfaced the bug.
			ctx.ui.notify(formatted, summary.failed > 0 ? "warning" : "info");
		},
	});
}
