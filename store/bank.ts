/**
 * dream-memory/store/bank.ts
 * Multi-store architecture: global.db + per-project databases
 *
 * Architecture:
 *   ~/.pi/agent/dream-memory/
 *   ├── global.db          ← ALL global/agent/session memories (visible everywhere)
 *   ├── projeto-a.db       ← ONLY project-scoped memories
 *   ├── projeto-b.db       ← ONLY project-scoped memories
 *   └── ...dream-*.db      ← Output stores from /dream (pending accept/discard)
 */

import { existsSync, mkdirSync, copyFileSync, renameSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { DreamStore, type Memory } from "./sqlite.js";
import { detectProject } from "../scope/resolver.js";

export type BankStrategy = "per-repo";

export interface BankConfig {
	strategy: BankStrategy;
	basePath: string; // Directory for all database files
}

const DEFAULT_BANK_CONFIG: BankConfig = {
	strategy: "per-repo",
	basePath: join(process.env.HOME || "~", ".pi", "agent", "dream-memory"),
};

export interface StorePair {
	global: DreamStore;
	projectId: string | null;
	project: DreamStore | null;
}

/**
 * Store reference for Dream sessions
 */
export interface DreamSessionStores {
	globalOutputBankId: string;
	projectOutputBankId: string | null;
	projectId: string | null;
}

export class BankManager {
	private config: BankConfig;
	private globalStore: DreamStore | null = null;
	private projectStores: Map<string, DreamStore> = new Map();

	constructor(config: Partial<BankConfig> = {}) {
		this.config = { ...DEFAULT_BANK_CONFIG, ...config };
		mkdirSync(this.config.basePath, { recursive: true });
	}

	/**
	 * Get or create the global store (always exists)
	 */
	getGlobalStore(): DreamStore {
		if (!this.globalStore) {
			const dbPath = join(this.config.basePath, "global.db");
			this.globalStore = new DreamStore(dbPath);
		}
		return this.globalStore;
	}

	/**
	 * Get store by ID (global or project)
	 */
	getStoreById(id: string): DreamStore {
		if (id === "global") {
			return this.getGlobalStore();
		}

		if (!this.projectStores.has(id)) {
			const dbPath = join(this.config.basePath, `${id}.db`);
			this.projectStores.set(id, new DreamStore(dbPath));
		}
		return this.projectStores.get(id)!;
	}

	/**
	 * Get project store for a given directory
	 * Returns null if not in a detectable project
	 */
	getProjectStore(cwd: string): DreamStore | null {
		const projectId = this.resolveProjectId(cwd);
		if (!projectId) return null;
		return this.getStoreById(projectId);
	}

	/**
	 * Get both global and project stores for a context
	 */
	getStores(context: { cwd: string }): StorePair {
		const global = this.getGlobalStore();
		const projectId = this.resolveProjectId(context.cwd);
		const project = projectId ? this.getStoreById(projectId) : null;
		return { global, projectId, project };
	}

	/**
	 * Resolve project name from cwd
	 */
	resolveProjectId(cwd: string): string | null {
		try {
			return detectProject(cwd) || null;
		} catch {
			return null;
		}
	}

	/**
	 * Determine which store a memory should be written to based on scope
	 */
	resolveStoreForScope(scope: string, cwd: string): { store: DreamStore; storeId: string; scopeId: string | null } {
		if (scope === "project") {
			const projectId = this.resolveProjectId(cwd);
			if (projectId) {
				return { store: this.getStoreById(projectId), storeId: projectId, scopeId: projectId };
			}
			// Fallback: no project detected, treat as global
			return { store: this.getGlobalStore(), storeId: "global", scopeId: null };
		}

		// global, agent, session → global store
		return { store: this.getGlobalStore(), storeId: "global", scopeId: null };
	}

	// ── Dream Operations ─────────────────────────────────────────────────

	/**
	 * Resolve the store ID for a context (for dream commands)
	 */
	resolveBankId(context: { cwd: string; sessionId: string }): string {
		return this.resolveProjectId(context.cwd) || "global";
	}

	/**
	 * Clone both stores for Dream consolidation
	 */
	cloneStores(context: { cwd: string }): DreamSessionStores {
		const { global, project, projectId } = this.getStores(context);
		const ts = Date.now();

		// Clone global store
		const globalOutputBankId = `global-dream-${ts}`;
		this.cloneBank("global", globalOutputBankId);

		// Clone project store (if exists)
		let projectOutputBankId: string | null = null;
		if (project && projectId) {
			projectOutputBankId = `${projectId}-dream-${ts}`;
			this.cloneBank(projectId, projectOutputBankId);
		}

		return {
			globalOutputBankId,
			projectOutputBankId,
			projectId,
		};
	}

	/**
	 * Clone a single bank (internal)
	 */
	cloneBank(sourceBankId: string, targetBankId: string): void {
		const sourcePath = join(this.config.basePath, `${sourceBankId}.db`);
		const targetPath = join(this.config.basePath, `${targetBankId}.db`);

		if (!existsSync(sourcePath)) {
			throw new Error(`Source bank ${sourceBankId} not found`);
		}

		// Force WAL checkpoint before closing to ensure data consistency
		if (sourceBankId === "global" && this.globalStore) {
			this.globalStore.checkpoint();
			this.globalStore.close();
			this.globalStore = null;
		} else if (this.projectStores.has(sourceBankId)) {
			const projectStore = this.projectStores.get(sourceBankId)!;
			projectStore.checkpoint();
			projectStore.close();
			this.projectStores.delete(sourceBankId);
		}

		// Copy database and WAL/SHM files
		copyFileSync(sourcePath, targetPath);
		for (const ext of ["-wal", "-shm"]) {
			const src = sourcePath + ext;
			if (existsSync(src)) copyFileSync(src, targetPath + ext);
		}

		// Reopen source store
		const sourceStore = new DreamStore(sourcePath);
		if (sourceBankId === "global") {
			this.globalStore = sourceStore;
		} else {
			this.projectStores.set(sourceBankId, sourceStore);
		}
	}

	/**
	 * Get Dream output stores
	 */
	getDreamOutputStores(globalOutputBankId: string, projectOutputBankId: string | null): { globalStore: DreamStore; projectStore: DreamStore | null } {
		const globalStore = this.getStoreById(globalOutputBankId);
		let projectStore: DreamStore | null = null;
		if (projectOutputBankId) {
			projectStore = this.getStoreById(projectOutputBankId);
		}
		return { globalStore, projectStore };
	}

	/**
	 * Replace input stores with Dream output stores
	 */
	acceptDream(session: DreamSessionStores): void {
		// Replace global store
		this.replaceStore("global", session.globalOutputBankId);

		// Replace project store (if dream had one)
		if (session.projectOutputBankId && session.projectId) {
			this.replaceStore(session.projectId, session.projectOutputBankId);
		}
	}

	/**
	 * Delete Dream output stores (discard)
	 */
	discardDream(session: DreamSessionStores): void {
		this.deleteStore(session.globalOutputBankId);
		if (session.projectOutputBankId) {
			this.deleteStore(session.projectOutputBankId);
		}
	}

	/**
	 * Move a memory from one store to another, preserving its ID.
	 *
	 * Used by contradiction resolution: when the user resolves a contradiction
	 * as "replace" and the replacement scope is in a different physical file
	 * (e.g., existing memory is in myproject.db but the new scope is global,
	 * which lives in global.db), we need to move the row across .db files
	 * while keeping the same id (so `synthesizedFrom`, `superseded_by`, and
	 * other references remain valid).
	 *
	 * Atomicity: delegates to DreamStore.moveMemoryOut, which uses ATTACH
	 * DATABASE + a single transaction spanning both files. If anything fails
	 * mid-move, both files roll back to pre-move state.
	 *
	 * No-op short-circuit: if fromStoreId === toStoreId (same physical file),
	 * we fall back to an in-place update. This is the "same-store replace"
	 * path — the cheaper, more common case.
	 *
	 * @param id  Memory id to move
	 * @param fromStoreId  "global" or a project id
	 * @param toStoreId  "global" or a project id
	 * @param newScope  The scope field to set in the destination
	 * @param newScopeId  The scope_id to set (null for global/agent/session)
	 * @param preservedFields  Classification fields from the new memory params
	 * @returns The moved Memory (as it lives in the destination) or null
	 *          if the source memory was not found.
	 */
	moveMemory(
		id: string,
		fromStoreId: string,
		toStoreId: string,
		newScope: "global" | "project" | "agent" | "session",
		newScopeId: string | null,
		preservedFields: {
			target: Memory["target"];
			category?: Memory["category"] | null;
			tier: Memory["tier"];
			ttl_days?: number | null;
		},
	): Memory | null {
		// Same physical file: in-place update is cheaper and avoids the
		// ATTACH dance. Resolves to the same scope_id invariant.
		if (fromStoreId === toStoreId) {
			const store = this.getStoreById(fromStoreId);
			return (
				store.updateMemory(id, {
					scope: newScope,
					scope_id: newScopeId ?? undefined,
					target: preservedFields.target,
					category: preservedFields.category ?? undefined,
					tier: preservedFields.tier,
					// preservedFields.ttl_days is `number | null | undefined`; the
					// updateMemory signature accepts `number | undefined` (it
					// treats `null` as "fall back to the existing value"). Coerce
					// null to undefined so we don't pass through the wrong type.
					ttl_days: preservedFields.ttl_days ?? undefined,
				}) ?? null
			);
		}

		// Cross-file move.
		const fromStore = this.getStoreById(fromStoreId);
		const toStore = this.getStoreById(toStoreId);
		const targetPath = join(this.config.basePath, `${toStoreId}.db`);

		const moved = fromStore.moveMemoryOut(
			id,
			targetPath,
			newScope,
			newScopeId,
			preservedFields,
		);

		if (moved) {
			// The destination store's IDF cache is now stale (it gained a row
			// with new tokens). The fromStore already invalidates its own
			// cache inside moveMemoryOut.
			toStore.invalidateIdfCachePublic();
		}

		return moved;
	}

	/**
	 * Replace a single store with another (archive old)
	 */
	private replaceStore(targetBankId: string, sourceBankId: string): void {
		const sourcePath = join(this.config.basePath, `${sourceBankId}.db`);
		const targetPath = join(this.config.basePath, `${targetBankId}.db`);

		if (!existsSync(sourcePath)) {
			throw new Error(`Source bank ${sourceBankId} not found`);
		}

		// Close target if open
		if (targetBankId === "global" && this.globalStore) {
			this.globalStore.close();
			this.globalStore = null;
		} else if (this.projectStores.has(targetBankId)) {
			this.projectStores.get(targetBankId)!.close();
			this.projectStores.delete(targetBankId);
		}

		// Checkpoint the SOURCE first so all data lives in source.db (not the WAL).
		// Without this, copyFileSync below would copy a stale main file and leave
		// uncommitted rows stranded in source.db-wal — corrupting the target's
		// indexes on next open (verified: 49 missing index entries on global.db
		// before this fix). The source store may not be in the cache (e.g. a dream
		// output store), so we use a transient connection for the checkpoint.
		if (existsSync(sourcePath)) {
			try {
				const tmp = new DreamStore(sourcePath);
				try {
					tmp.checkpoint();
				} finally {
					tmp.close();
				}
			} catch {
				// Best-effort: if checkpoint fails (file locked, etc.), the .db-wal
				// copy below still gives us a chance at consistency.
			}
		}

		// Archive target (rename .db AND its WAL/SHM siblings together so the
		// archive is a complete, replayable snapshot).
		if (existsSync(targetPath)) {
			const archivedPath = `${targetPath}.archived-${Date.now()}`;
			renameSync(targetPath, archivedPath);
			for (const ext of ["-wal", "-shm"]) {
				const sib = targetPath + ext;
				if (existsSync(sib)) {
					try {
						renameSync(sib, archivedPath + ext);
					} catch {
						/* best-effort */
					}
				}
			}
		}

		// Copy source → target (.db + WAL/SHM). Copying WAL after a successful
		// checkpoint is a no-op (file doesn't exist or is empty), but is safe
		// either way and matches the symmetry of cloneBank.
		copyFileSync(sourcePath, targetPath);
		for (const ext of ["-wal", "-shm"]) {
			const src = sourcePath + ext;
			if (existsSync(src)) {
				try {
					copyFileSync(src, targetPath + ext);
				} catch {
					/* best-effort */
				}
			}
		}

		// Reopen
		const store = new DreamStore(targetPath);
		if (targetBankId === "global") {
			this.globalStore = store;
		} else {
			this.projectStores.set(targetBankId, store);
		}
	}

	/**
	 * Delete a store (for cleanup)
	 */
	deleteStore(bankId: string): boolean {
		const dbPath = join(this.config.basePath, `${bankId}.db`);

		if (!existsSync(dbPath)) return false;

		// Close if open
		if (bankId === "global" && this.globalStore) {
			this.globalStore.close();
			this.globalStore = null;
		} else if (this.projectStores.has(bankId)) {
			this.projectStores.get(bankId)!.close();
			this.projectStores.delete(bankId);
		}

		// Delete files
		let deletedCount = 0;
		for (const ext of ["", "-wal", "-shm"]) {
			const f = dbPath + ext;
			if (!existsSync(f)) continue;
			try {
				unlinkSync(f);
				deletedCount++;
			} catch (err: any) {
				// Log but don't throw — best-effort cleanup
				console.warn(`Failed to delete ${f}: ${err.message}`);
			}
		}
		return deletedCount > 0;
	}

	/**
	 * Archive a single store
	 */
	archiveBank(bankId: string): boolean {
		const dbPath = join(this.config.basePath, `${bankId}.db`);
		const archivedPath = `${dbPath}.archived-${Date.now()}`;

		if (!existsSync(dbPath)) return false;

		// Close if open
		if (bankId === "global" && this.globalStore) {
			this.globalStore.close();
			this.globalStore = null;
		} else if (this.projectStores.has(bankId)) {
			this.projectStores.get(bankId)!.close();
			this.projectStores.delete(bankId);
		}

		// Rename .db + WAL/SHM siblings together so the archive is a complete,
		// replayable snapshot. Without renaming the siblings, they become orphans
		// (auto-cleanup catches them after 7d, but the .db on its own is incomplete).
		renameSync(dbPath, archivedPath);
		for (const ext of ["-wal", "-shm"]) {
			const sib = dbPath + ext;
			if (existsSync(sib)) {
				try {
					renameSync(sib, archivedPath + ext);
				} catch {
					/* best-effort */
				}
			}
		}
		return true;
	}

	/**
	 * Close all stores
	 */
	closeAll(): void {
		if (this.globalStore) {
			this.globalStore.close();
			this.globalStore = null;
		}
		for (const [id, store] of this.projectStores) {
			store.close();
		}
		this.projectStores.clear();
	}

	/**
	 * Get base path
	 */
	getBasePath(): string {
		return this.config.basePath;
	}

	/**
	 * Get list of all store files (for cleanup)
	 */
	getAllStoreFiles(): Array<{ name: string; size: number; type: "main" | "project" | "dream-output" | "archived" | "orphaned" }> {
		const files = readdirSync(this.config.basePath);
		const result: Array<{ name: string; size: number; type: "main" | "project" | "dream-output" | "archived" | "orphaned" }> = [];

		for (const file of files) {
			const filePath = join(this.config.basePath, file);
			const stat = statSync(filePath);
			if (!stat.isFile()) continue;

			const baseName = file.replace(/\.(db|db-wal|db-shm)$/, "");

			if (file === "global.db" || file === "global.db-wal" || file === "global.db-shm") {
				result.push({ name: file, size: stat.size, type: "main" });
			} else if (file.match(/\.archived-/)) {
				result.push({ name: file, size: stat.size, type: "archived" });
			} else if (file.includes("-dream-") && (file.endsWith(".db") || file.endsWith(".db-wal") || file.endsWith(".db-shm"))) {
				result.push({ name: file, size: stat.size, type: "dream-output" });
			} else if (file.endsWith(".db") && file !== "global.db") {
				result.push({ name: file, size: stat.size, type: "project" });
			} else if ((file.endsWith(".db-wal") || file.endsWith(".db-shm")) && !files.some(f => f === `${baseName}.db`)) {
				result.push({ name: file, size: stat.size, type: "orphaned" });
			}
		}

		return result;
	}

	// ── Migration ────────────────────────────────────────────────────────

	/**
	 * Fix memories that were created in the wrong store by the bugs fixed in
	 * the Phase 1 audit:
	 *
	 *   Bug #2: `saveSignal` hardcoded `global` as the target store, so signals
	 *           with `scope=project` landed in global.db with scope_id=null.
	 *   Bug #3: `applySynthesis` hardcoded `scope="global"` when running on
	 *           the project output store, polluting project.db with
	 *           global-scoped synthesized memories.
	 *
	 * The fix runs on `session_start` and is idempotent — a second run finds
	 * no candidates and is a no-op. It's also conservative:
	 *
	 *   - For #3: cross-store move to global.db (uses `moveMemory` so the id
	 *     is preserved and `synthesizedFrom` links remain valid).
	 *   - For #2: the memory's original `scope_id` was lost (always null), so
	 *     we can't recover the project. Best we can do is downgrade to
	 *     `scope="global"` so it's at least findable by global recall.
	 *     The user can re-categorize via /dream-list if needed.
	 *
	 * Migration is best-effort: a single failure doesn't abort the whole
	 * batch (the offending memory stays where it is, errors are returned).
	 * The user can re-run the migration from the next session.
	 *
	 * @param currentCwd  Used to identify the current project store; we skip
	 *                    it for the cross-store move to avoid moving the
	 *                    working set while the session is live.
	 * @returns summary of fixed memories and any errors encountered
	 */
	migratePollutedMemories(currentCwd?: string): {
		movedToGlobal: number;
		convertedToGlobal: number;
		skipped: number;
		errors: string[];
	} {
		const globalStore = this.getGlobalStore();
		const currentProjectId = currentCwd ? this.resolveProjectId(currentCwd) : null;
		const errors: string[] = [];
		let movedToGlobal = 0;
		let convertedToGlobal = 0;
		let skipped = 0;

		// Pass 1: project stores may contain scope=global memories (bug #3).
		// Move them to global.db. Skip the current project (it might be in
		// active use, and we don't want to invalidate open handles or move
		// working data while the user is mid-task).
		const files = readdirSync(this.config.basePath);
		for (const file of files) {
			if (!file.endsWith(".db")) continue;
			if (file === "global.db") continue;
			if (file.startsWith("global-dream-") || file.includes("dream-") || file.includes(".archived-")) continue;

			const projectId = file.replace(/\.db$/, "");
			if (projectId === currentProjectId) continue;

			const dbPath = join(this.config.basePath, file);
			let store: DreamStore | null = null;
			let openedFresh = false;
			try {
				const cached = this.projectStores.get(projectId);
				store = cached ?? (() => { openedFresh = true; return new DreamStore(dbPath); })();

				// Find memories that are tagged as global but live in a project DB
				const leaked = store.listMemories({ scope: "global" });

				for (const mem of leaked) {
					try {
						const moved = this.moveMemory(
							mem.id,
							projectId,
							"global",
							"global",
							null,
							{
								target: mem.target,
								category: mem.category,
								tier: mem.tier,
								ttl_days: mem.ttl_days,
							},
						);
						if (moved) {
							movedToGlobal++;
						} else {
							skipped++;
						}
					} catch (err: any) {
						errors.push(`move ${mem.id} from ${projectId} to global: ${err.message}`);
					}
				}
			} catch (err: any) {
				errors.push(`pass1 ${projectId}: ${err.message}`);
			} finally {
				if (store && openedFresh) {
					try { store.close(); } catch { /* ignore */ }
				}
			}
		}

		// Pass 2: global.db may contain scope=project memories with scope_id=null
		// (bug #2 — saveSignal always wrote to global). The project is lost, so
		// we downgrade to scope=global so at least the memory is findable.
		try {
			// listMemories doesn't expose a "scope_id is null" filter, so list
			// all scope=project and filter in JS. With sane data volumes this
			// is cheap; if it ever isn't, add an `IS NULL` filter to
			// `listMemories`.
			const allProject = globalStore.listMemories({ scope: "project" });
			for (const mem of allProject) {
				if (mem.scope_id) continue; // Has a project — leave it
				try {
					globalStore.updateMemory(mem.id, {
						scope: "global",
						scope_id: undefined,
					});
					convertedToGlobal++;
				} catch (err: any) {
					errors.push(`convert ${mem.id} to global: ${err.message}`);
				}
			}
		} catch (err: any) {
			errors.push(`pass2 global: ${err.message}`);
		}

		return { movedToGlobal, convertedToGlobal, skipped, errors };
	}
}

/**
 * Auto-cleanup: delete old archived backups, pending output stores, and orphaned
 * WAL/SHM files. Safe to run unattended — it only deletes FILES (no memory data),
 * and never touches the current project's DB.
 *
 * Runs automatically on `session_start` (configurable). The user can also invoke
 * the full preview via `/dream-cleanup` for explicit confirmation.
 *
 * @param basePath  Bank base directory (e.g., ~/.pi/agent/dream-memory/)
 * @param options
 *   - maxAgeMs: delete files older than this. Default 7 days.
 *   - dryRun: if true, return what would be deleted without deleting.
 * @returns summary of files removed (or that would be removed)
 */
export interface AutoCleanupOptions {
	maxAgeMs?: number;
	dryRun?: boolean;
}

export interface AutoCleanupResult {
	scanned: number;
	deleted: number;
	bytesReclaimed: number;
	deletedFiles: string[];
	skipped: number;
}

export function autoCleanupFiles(
	basePath: string,
	options: AutoCleanupOptions = {},
	currentProjectId?: string | null,
	// Use the full DreamSessionStores type here (includes projectId) so
	// callers can pass the session object directly without a type cast.
	// Only `globalOutputBankId` and `projectOutputBankId` are read below;
	// the extra `projectId` field is harmless.
	currentDreamSession?: DreamSessionStores | null,
): AutoCleanupResult {
	const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
	const now = Date.now();

	if (!existsSync(basePath)) {
		return { scanned: 0, deleted: 0, bytesReclaimed: 0, deletedFiles: [], skipped: 0 };
	}

	const files = readdirSync(basePath);
	const toDelete: Array<{ name: string; path: string; size: number; mtimeMs: number; reason: string }> = [];
	let scanned = 0;
	let skipped = 0;

	for (const file of files) {
		// Skip main database files: global.db, global.db-wal, global.db-shm,
		// and the current project's DB + WAL/SHM.
		if (file === "global.db" || file === "global.db-wal" || file === "global.db-shm") {
			skipped++;
			continue;
		}
		if (currentProjectId) {
			if (
				file === `${currentProjectId}.db` ||
				file === `${currentProjectId}.db-wal` ||
				file === `${currentProjectId}.db-shm`
			) {
				skipped++;
				continue;
			}
		}

		const filePath = join(basePath, file);
		let stat;
		try {
			stat = statSync(filePath);
		} catch {
			// File vanished between readdirSync and statSync (concurrent cleanup).
			skipped++;
			continue;
		}
		scanned++;

		const ageMs = now - stat.mtimeMs;
		if (ageMs < maxAgeMs) {
			// File is recent — keep it (the user might still be using it).
			skipped++;
			continue;
		}

		// Old archived backups
		if (file.includes(".archived-")) {
			toDelete.push({ name: file, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, reason: "old backup" });
			continue;
		}

		// Pending output stores (older than maxAgeMs and not the current dream session)
		if (file.includes("-dream-") && file.endsWith(".db")) {
			if (currentDreamSession) {
				if (file.includes(currentDreamSession.globalOutputBankId)) continue;
				if (currentDreamSession.projectOutputBankId && file.includes(currentDreamSession.projectOutputBankId)) continue;
			}
			toDelete.push({ name: file, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, reason: "pending output store" });
			continue;
		}

		// Orphaned WAL/SHM files: their parent .db is gone
		if ((file.endsWith(".db-wal") || file.endsWith(".db-shm")) && !files.includes(file.replace(/-(wal|shm)$/, ""))) {
			toDelete.push({ name: file, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, reason: "orphaned cache" });
			continue;
		}
	}

	if (options.dryRun) {
		return {
			scanned,
			deleted: toDelete.length,
			bytesReclaimed: toDelete.reduce((sum, f) => sum + f.size, 0),
			deletedFiles: toDelete.map((f) => f.name),
			skipped,
		};
	}

	const deletedFiles: string[] = [];
	let bytesReclaimed = 0;
	for (const f of toDelete) {
		try {
			unlinkSync(f.path);
			deletedFiles.push(f.name);
			bytesReclaimed += f.size;
		} catch {
			// Best-effort — log but don't throw
		}
	}

	return { scanned, deleted: deletedFiles.length, bytesReclaimed, deletedFiles, skipped };
}
