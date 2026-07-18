/**
 * dream-memory/contradiction/resolver.ts
 * Contradiction resolution via user input or heuristic
 */

import type { Memory } from "../store/sqlite.js";
import type { ContradictionCandidate } from "./detector.js";
import { TRUST_PRIORITY } from "../utils/constants.js";

export type ResolutionAction = "replace" | "keep-both" | "discard";

export interface ResolutionResult {
	action: ResolutionAction;
	reason: string;
	autoResolved: boolean;
}

export interface UIContext {
	select: (title: string, options: string[]) => Promise<string | undefined>;
}

/**
 * Resolve contradiction automatically (high confidence) or ask user (ambiguous)
 */
export async function resolveContradiction(
	candidate: ContradictionCandidate,
	newContent: string,
	ui?: UIContext,
): Promise<ResolutionResult> {
	// High confidence (>arbitrationThreshold) = auto-replace
	if (!candidate.needsArbitration) {
		return {
			action: "replace",
			reason: "High similarity — auto-replacing with newer memory",
			autoResolved: true,
		};
	}

	// Ambiguous range = ask user
	if (ui) {
		const action = await askUser(candidate.existing.content, newContent, ui);
		return {
			action,
			reason: `User chose: ${action}`,
			autoResolved: false,
		};
	}

	// v2.0: Trust-aware arbitration when no UI available.
	// Higher trust wins by default. Equal trust = heuristic (temporal/specificity).
	if (candidate.newIsLowerTrust) {
		// New memory has LOWER trust than existing → keep existing
		return {
			action: "discard",
			reason: `New memory has lower trust (trust_level=${(candidate as any).newTrustLevel ?? 2}) than existing (trust_level=${candidate.existing.trust_level ?? 2})`,
			autoResolved: true,
		};
	}

	// Equal trust or new has higher trust → fall through to heuristic
	const action = heuristicArbitration(candidate.existing.content, newContent);
	return {
		action,
		reason: `Heuristic arbitration: ${action}`,
		autoResolved: false,
	};
}

/**
 * Ask user to resolve ambiguous contradiction
 */
async function askUser(existingContent: string, newContent: string, ui: UIContext): Promise<ResolutionAction> {
	const truncatedExisting = existingContent.length > 80 ? existingContent.slice(0, 80) + "..." : existingContent;
	const truncatedNew = newContent.length > 80 ? newContent.slice(0, 80) + "..." : newContent;

	const options = [
		`Substituir: "${truncatedExisting}" → "${truncatedNew}"`,
		`Manter ambas`,
		`Descartar nova: "${truncatedNew}"`,
	];

	const choice = await ui.select("⚠️ Contradição detectada", options);

	if (!choice) {
		// User cancelled or timed out = keep both (safe default)
		return "keep-both";
	}

	if (choice.includes("Substituir")) return "replace";
	if (choice.includes("Descartar")) return "discard";
	return "keep-both";
}

/**
 * Callbacks that close over the correct stores for a contradiction action.
 *
 * The caller (index.ts) wires these up after detecting which store the
 * existing memory lives in and which store the new memory should live in:
 *   - updateInPlace: bound to the existing memory's store. Used when
 *     the new scope lives in the same .db file (atomic, no cross-DB I/O).
 *   - moveAcrossStores: bound to the EXISTING memory's store, but moves
 *     the row to the NEW memory's store. Used when the new scope lives
 *     in a different .db file (ATTACH + transaction, atomic across both).
 *   - createInNewStore: bound to the new memory's store. Used for
 *     keep-both (creates a fresh memory alongside the existing one).
 *
 * Each callback returns the resulting Memory (or null if the operation
 * failed and the caller should fall back). The memory's id is preserved
 * in both replace paths, so external references in
 * `metadata.synthesizedFrom`, `metadata.superseded_by`, etc. remain valid.
 */
export interface ReplaceOperations {
	updateInPlace: (id: string, params: any) => Memory | null;
	moveAcrossStores: (id: string, params: any) => Memory | null;
	createInNewStore: (params: any) => Memory;
}

/**
 * Apply resolution action to store
 *
 * Atomicity:
 *   - `replace` (same file): uses updateInPlace, atomic at the SQL level.
 *     No window where the memory is missing. Preserves id, references,
 *     and version history.
 *   - `replace` (cross file): uses moveAcrossStores (ATTACH + transaction).
 *     Atomic across both .db files — partial failures roll back. Preserves
 *     id and audit trail.
 *   - `keep-both`: uses createInNewStore to insert a fresh memory. The
 *     existing memory is untouched.
 *   - `discard`: no-op. The new memory content is dropped.
 */
export function applyResolution(
	action: ResolutionAction,
	existingMemory: Memory,
	newContent: string,
	operations: ReplaceOperations,
	memoryParams: any,
): { created: boolean; deleted: boolean; moved: boolean } {
	switch (action) {
		case "replace": {
			// Detect cross-store: the new memory's scope lives in a different
			// .db file than the existing one. If we naively updated in place,
			// we'd rewrite scope/scope_id but the row would stay in the wrong
			// file, breaking the "scope=X lives in store X" invariant and
			// silently corrupting cleanup, search, and migration logic.
			const isCrossStore =
				(existingMemory.scope === "global" && memoryParams.scope !== "global") ||
				(existingMemory.scope !== "global" && memoryParams.scope === "global") ||
				(existingMemory.scope === "project" &&
					memoryParams.scope === "project" &&
					existingMemory.scope_id !== memoryParams.scope_id);

			if (isCrossStore) {
				// Cross-file move: ATTACH destination, move row, keep ID.
				// If the move fails (e.g., row vanished concurrently), we
				// throw — the caller can decide whether to fall back to a
				// fresh create in the new store.
				const moved = operations.moveAcrossStores(existingMemory.id, {
					content: newContent,
					scope: memoryParams.scope,
					scope_id: memoryParams.scope_id,
					target: memoryParams.target,
					category: memoryParams.category,
					tier: memoryParams.tier,
					ttl_days: memoryParams.ttl_days,
				});
				if (!moved) {
					throw new Error(
						`Cross-store move failed for memory ${existingMemory.id}: row not found in source store`,
					);
				}
				return { created: false, deleted: false, moved: true };
			}

			// Same file: in-place update preserves id, references, and version
			// history. We carry over classification fields from the new memory
			// params so the replacement reflects the user's intent. Metadata is
			// intentionally left alone — it may contain manual customizations
			// (batchId, source, etc.) that the user set and we shouldn't clobber.
			const updated = operations.updateInPlace(existingMemory.id, {
				content: newContent,
				status: "active",
				target: memoryParams.target,
				category: memoryParams.category,
				scope: memoryParams.scope,
				scope_id: memoryParams.scope_id,
				tier: memoryParams.tier,
				ttl_days: memoryParams.ttl_days,
			});
			if (!updated) {
				// Fallback: row vanished between detect and update. Create a
				// fresh memory in the destination store. Caller's memoryParams
				// already has the right scope/scope_id for the destination.
				operations.createInNewStore({ ...memoryParams, content: newContent });
				return { created: true, deleted: false, moved: false };
			}
			return { created: false, deleted: false, moved: false };
		}

		case "discard":
			return { created: false, deleted: false, moved: false };

		case "keep-both": {
			// Create a new memory in the new store (not the existing one).
			// The existing memory stays untouched.
			operations.createInNewStore({ ...memoryParams, content: newContent });
			return { created: true, deleted: false, moved: false };
		}
	}
}

/**
 * Heuristic-based arbitration for ambiguous contradictions
 */
function heuristicArbitration(existing: string, newMemory: string): "replace" | "keep-both" | "discard" {
	const existingLower = existing.toLowerCase();
	const newLower = newMemory.toLowerCase();

	// Check for temporal indicators
	const temporalPatterns = [
		/currently/i,
		/now using/i,
		/switched to/i,
		/migrated to/i,
		/changed to/i,
		/update:/i,
		/changed from/i,
	];

	const hasTemporal = temporalPatterns.some((p) => p.test(newMemory));

	if (hasTemporal) {
		// New memory has temporal indicator - likely an update
		return "replace";
	}

	// Check for specificity (more specific = keep)
	const existingWords = existing.split(/\s+/).length;
	const newWords = newMemory.split(/\s+/).length;

	if (newWords > existingWords * 1.5) {
		// New memory is significantly more detailed
		return "replace";
	}

	if (existingWords > newWords * 1.5) {
		// Existing memory is more detailed
		return "discard";
	}

	// Default: keep both
	return "keep-both";
}
