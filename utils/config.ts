/**
 * dream-memory/utils/config.ts
 * Configuration management for dream-memory
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DreamMemoryConfig {
	enabled: boolean;
	storage: {
		path: string;
	};
	search: {
		defaultTopK: number;
		contextBudget: number;
		rrfK: number;
	};
	ttl: {
		enabled: boolean;
		enforceInterval: number;
	};
	contradiction: {
		enabled: boolean;
		similarityThreshold: number;
		arbitrationThreshold: number;
	};
	dream: {
		intervalDays: number;
		minProjectAgeDays: number;
	};
	distill: {
		intervalDays: number;
		minPatternFrequency: number;
		minConfidence: number;
	};
	sanitize: {
		enabled: boolean;
		patterns: string[];
	};
	recall: {
		ephemeral: boolean;
		stripOnNextTurn: boolean;
		maxTokens: number;
		/**
		 * Phase 1 (lifecycle hooks): session_start snapshot. When true,
		 * the extension injects a focused one-time snapshot of top
		 * user-target memories (preferences, conventions, system specs)
		 * at session open. Read-only, no LLM, cached per session. Opt-out
		 * via `recall.snapshotEnabled: false` if the snapshot is too noisy
		 * or if the user prefers per-turn recall only.
		 */
		snapshotEnabled?: boolean;
		/**
		 * Phase 2 (lifecycle hooks): session_shutdown breadcrumb. When
		 * true, a session-scoped memory is written at session end with
		 * metadata about which memories were surfaced (audit trail).
		 * Off by default — it adds 1 memory per session, which over time
		 * grows the DB. Enable when debugging recall or reviewing what
		 * the agent "knew" during a session. Scope=session so it's
		 * auto-cleaned at the next session_end.
		 */
		saveBreadcrumbs?: boolean;
		/**
		 * R6: per-category cap on injected memories. Maps category name
		 * (e.g. "preference", "convention", "failure") to the max
		 * number of memories from that category allowed in a single
		 * recall output. Lowest-scored excess is dropped (read-time,
		 * no DB write). Empty object (default) = no cap.
		 *
		 * Example: { "preference": 20, "convention": 10 } keeps at most
		 * 20 preferences and 10 conventions per recall, preventing one
		 * category from dominating the recall budget at scale.
		 */
		categoryCaps?: Record<string, number>;
	};
	cleanup: {
		/** Auto-cleanup old files on session_start. Default true. */
		enabled: boolean;
		/** Delete files older than this many milliseconds. Default 7 days. */
		maxAgeMs: number;
	};
}

const DEFAULT_CONFIG: DreamMemoryConfig = {
	enabled: true,
	storage: {
		path: join(homedir(), ".pi", "agent", "dream-memory.db"),
	},
	search: {
		defaultTopK: 10,
		contextBudget: 4000,
		rrfK: 60,
	},
	ttl: {
		enabled: true,
		enforceInterval: 86400000, // 24h
	},
	contradiction: {
		enabled: true,
		similarityThreshold: 0.85,
		arbitrationThreshold: 0.95,
	},
	dream: {
		intervalDays: 7,
		minProjectAgeDays: 3,
	},
	distill: {
		intervalDays: 30,
		minPatternFrequency: 5,
		minConfidence: 0.7,
	},
	sanitize: {
		enabled: true,
		patterns: [
			"sk-[A-Za-z0-9\\-]{20,}",
			"Bearer\\s+[A-Za-z0-9\\-._~+/]{20,}=",
			"(?:api[_-]?key|secret|token|password)\\s*[:=]\\s*['\"]?([^\\s'\"`,;}{]{8,})",
		],
	},
	recall: {
		ephemeral: true,
		stripOnNextTurn: true,
		maxTokens: 4000,
		categoryCaps: {}, // R6: empty = no cap (per-category cap is opt-in)
		snapshotEnabled: true, // Phase 1: on by default; opt-out via config
		saveBreadcrumbs: false, // Phase 2: off by default (audit trail, opt-in)
	},
	cleanup: {
		enabled: true,
		maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
	},
};

export function loadConfig(): DreamMemoryConfig {
	// Try loading from global config
	const globalConfigPath = join(homedir(), ".pi", "agent", "dream-memory.json");
	if (existsSync(globalConfigPath)) {
		try {
			const raw = readFileSync(globalConfigPath, "utf-8");
			const userConfig = JSON.parse(raw);
			return mergeConfig(DEFAULT_CONFIG, userConfig);
		} catch {
			// Fall back to defaults
		}
	}

	return { ...DEFAULT_CONFIG };
}

/**
 * Merge user config with defaults.
 *
 * Top-level fields are replaced if provided.
 * Nested section objects (search, ttl, decay, etc.) are merged shallowly —
 * the user's section keys override defaults, but unspecified keys keep defaults.
 * Arrays (like sanitize.patterns) are fully replaced when the user provides them.
 */
function mergeConfig(defaults: DreamMemoryConfig, user: Partial<DreamMemoryConfig>): DreamMemoryConfig {
	const result = { ...defaults };

	if (user.enabled !== undefined) result.enabled = user.enabled;
	if (user.storage) result.storage = { ...defaults.storage, ...user.storage };
	if (user.search) result.search = { ...defaults.search, ...user.search };
	if (user.ttl) result.ttl = { ...defaults.ttl, ...user.ttl };
	if (user.contradiction) result.contradiction = { ...defaults.contradiction, ...user.contradiction };
	if (user.dream) result.dream = { ...defaults.dream, ...user.dream };
	if (user.distill) result.distill = { ...defaults.distill, ...user.distill };
	if (user.sanitize) result.sanitize = { ...defaults.sanitize, ...user.sanitize };
	if (user.recall) result.recall = { ...defaults.recall, ...user.recall };
	if (user.cleanup) result.cleanup = { ...defaults.cleanup, ...user.cleanup };

	return result;
}
