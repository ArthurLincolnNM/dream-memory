/**
 * dream-memory/ttl/manager.ts
 * TTL management and enforcement
 */

import type { Memory } from "../store/sqlite.js";

export const TTL_CLASSES = {
	permanent: null, // Preferências do usuário
	long: 365, // Convenções de projeto
	medium: 30, // Contexto de projeto ativo
	short: 7, // Debugging atual
	session: 1, // O que tá fazer agora
} as const;

export type TTLClass = keyof typeof TTL_CLASSES;

/**
 * Infer TTL from memory properties.
 *
 * Priority order:
 * 1. tier === "factual" → permanent (user explicitly requested via ttl="permanent")
 * 2. user + preference → permanent (convention)
 * 3. project + convention → long (365d)
 * 4. scope === session → session (1d)
 * 5. tier === "operational" → short (7d)
 * 6. failure → medium (30d)
 * 7. default → medium (30d)
 */
export function inferTTL(params: {
	target: Memory["target"];
	category?: Memory["category"];
	scope: Memory["scope"];
	tier?: Memory["tier"];
}): number | null {
	// tier="factual" is the marker for permanent memory (set by the
	// `dream_memory_add` tool when the caller passes `ttl: "permanent"`).
	// Honor it as permanent regardless of the other classification fields.
	if (params.tier === "factual") {
		return TTL_CLASSES.permanent;
	}

	// User preferences are permanent (legacy rule, kept for backwards compat)
	if (params.target === "user" && params.category === "preference") {
		return TTL_CLASSES.permanent;
	}

	// Project conventions are long-lived
	if (params.target === "project" && params.category === "convention") {
		return TTL_CLASSES.long;
	}

	// Session-scoped memories are short
	if (params.scope === "session") {
		return TTL_CLASSES.session;
	}

	// Operational memories are short-lived
	if (params.tier === "operational") {
		return TTL_CLASSES.short;
	}

	// Failure/correction memories are medium
	if (params.target === "failure") {
		return TTL_CLASSES.medium;
	}

	// Default: medium
	return TTL_CLASSES.medium;
}

/**
 * Check if a memory is expired
 */
export function isExpired(memory: Memory): boolean {
	if (memory.ttl_days === null || memory.ttl_days === undefined) {
		return false; // Permanent
	}

	const now = Date.now();
	const expiryTime = memory.updated_at + memory.ttl_days * 24 * 60 * 60 * 1000;
	return now > expiryTime;
}

/**
 * Get remaining TTL in days
 */
export function getRemainingTTL(memory: Memory): number | null {
	if (memory.ttl_days === null || memory.ttl_days === undefined) {
		return null; // Permanent
	}

	const now = Date.now();
	const expiryTime = memory.updated_at + memory.ttl_days * 24 * 60 * 60 * 1000;
	const remaining = expiryTime - now;

	if (remaining <= 0) return 0;
	return Math.ceil(remaining / (24 * 60 * 60 * 1000));
}

/**
 * Extend TTL (e.g., on access)
 *
 * NOTE: unused. The recall pipeline calls `trackAccess` to bump
 * `access_count` and `last_accessed_at`, but no caller extends the TTL
 * window based on access frequency. If we want access to refresh the
 * expiration (so hot memories stay alive), this is the place to wire it.
 * For now: dead code, kept commented.
 */
// export function extendTTL(memory: Memory, extensionDays: number): number | null {
// 	if (memory.ttl_days === null || memory.ttl_days === undefined) {
// 		return null;
// 	}
// 	return memory.ttl_days + extensionDays;
// }
