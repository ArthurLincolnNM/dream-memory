/**
 * dream-memory/dream/lock.ts
 *
 * Lock file to prevent concurrent /dream or auto-dream runs across
 * multiple pi instances (or two panes in same instance) operating on
 * the same memory bank.
 *
 * Stored at: ~/.pi/agent/dream-memory/.dream.lock
 * Format: JSON { pid: number, startedAt: number, type: "manual"|"auto" }
 *
 * Stale threshold: 1 hour. If lock file is older than that (process
 * crashed, machine sleep, etc.) it is treated as stale and silently
 * overwritten.
 *
 * Concurrency: uses `O_EXCL` (`openSync` flag "wx") so the file is created
 * atomically. The previous read-then-write pattern had a TOCTOU race that
 * let two processes both pass the "not locked" check between their reads.
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 min (down from 1h, see header)

export type DreamRunType = "manual" | "auto";

export interface DreamLock {
	pid: number;
	ppid: number;
	hostname: string;
	startedAt: number;
	type: DreamRunType;
}

export interface LockStatus {
	locked: boolean;
	stale: boolean;
	lock: DreamLock | null;
}

export interface AcquireResult {
	acquired: boolean;
	reason?: "active" | "stale-overwritten" | "fresh";
}

/**
 * Read the current lock status without modifying it
 */
export function getLockStatus(basePath: string): LockStatus {
	const lockPath = join(basePath, ".dream.lock");
	if (!existsSync(lockPath)) {
		return { locked: false, stale: false, lock: null };
	}

	try {
		const raw = readFileSync(lockPath, "utf-8");
		const lock = JSON.parse(raw) as DreamLock;
		const ageMs = Date.now() - lock.startedAt;
		const stale = ageMs > STALE_THRESHOLD_MS;

		// Even if not stale by age, check if the PID is alive AND belongs to
		// a process consistent with the lock holder. Without the hostname +
		// ppid checks, a recycled PID (different process that happened to
		// reuse the holder's PID) could pass the existence check and hold a
		// phantom lock for the full STALE_THRESHOLD_MS.
		//
		// Acceptance requires ALL of:
		//   - PID is alive (process.kill 0 returns success)
		//   - hostname matches the local host
		//   - ppid matches the current parent (parent is typically the Pi
		//     runtime; if it died, parent is reparented to init/PID 1, which
		//     will not match the recorded ppid)
		if (!stale) {
			try {
				process.kill(lock.pid, 0); // signal 0 = existence check
			} catch {
				return { locked: false, stale: true, lock };
			}

			// Hostname mismatch = lock is from a different machine (e.g., NFS).
			// Treat as stale to be safe.
			if (lock.hostname && lock.hostname !== hostname()) {
				return { locked: false, stale: true, lock };
			}

			// PPID mismatch = original parent died and process was reparented
			// to init. The lock was written by a process whose parent is no
			// longer our parent, so it's stale.
			if (lock.ppid && lock.ppid !== process.ppid) {
				return { locked: false, stale: true, lock };
			}
		}

		return { locked: !stale, stale, lock };
	} catch {
		// Corrupt lock file → treat as stale
		return { locked: false, stale: true, lock: null };
	}
}

/**
 * Try to acquire the lock atomically. Returns acquired=true if we got it.
 *
 * If another process holds a fresh lock, returns acquired=false.
 * If the existing lock is stale (process dead or file corrupt), we overwrite it.
 *
 * Concurrency-safe: uses O_EXCL ("wx") so the create-or-fail is atomic at the OS level.
 * Two concurrent acquirers: exactly one succeeds.
 */
export function acquireLock(basePath: string, type: DreamRunType): AcquireResult {
	const lockPath = join(basePath, ".dream.lock");

	// Stamp the lock with pid, ppid, and hostname. The ppid + hostname
	// checks in getLockStatus detect recycled-PID phantom locks (see that
	// function's comment for the full threat model).
	const content = JSON.stringify(
		{
			pid: process.pid,
			ppid: process.ppid,
			hostname: hostname(),
			startedAt: Date.now(),
			type,
		} as DreamLock,
		null,
		2,
	);

	try {
		// O_EXCL: fail if file exists. This is the atomic guarantee.
		const fd = openSync(lockPath, "wx");
		try {
			writeSync(fd, content, 0, "utf-8");
		} finally {
			closeSync(fd);
		}
		return { acquired: true, reason: "fresh" };
	} catch (err: any) {
		// EEXIST: another process holds the lock. Check if it's stale.
		if (err.code === "EEXIST") {
			const status = getLockStatus(basePath);
			if (status.locked) {
				return { acquired: false, reason: "active" };
			}
			// Lock is stale (old age or dead PID) → atomically replace.
			// Use rename: write to .dream.lock.tmp, then rename over the original.
			const tmpPath = `${lockPath}.tmp.${process.pid}`;
			try {
				writeFileSync(tmpPath, content, "utf-8");
				// renameSync is atomic on POSIX; replace existing file.
				// Use the top-level `renameSync` import instead of a runtime
				// `require` — both work, but the import is more explicit and
				// avoids the (already-dead) "CommonJS-only" warning under
				// strict ESM resolutions.
				renameSync(tmpPath, lockPath);
				return { acquired: true, reason: "stale-overwritten" };
			} catch {
				try {
					unlinkSync(tmpPath);
				} catch {
					/* ignore */
				}
				return { acquired: false, reason: "active" };
			}
		}
		// Some other I/O error → treat as failed
		return { acquired: false, reason: "active" };
	}
}

/**
 * Release the lock. Only deletes if we own it (PID matches).
 * Safe to call multiple times — missing file is a no-op.
 */
export function releaseLock(basePath: string): void {
	const lockPath = join(basePath, ".dream.lock");
	if (!existsSync(lockPath)) return;

	try {
		const raw = readFileSync(lockPath, "utf-8");
		const lock = JSON.parse(raw) as DreamLock;
		if (lock.pid !== process.pid) {
			// Not our lock — leave it alone
			return;
		}
		unlinkSync(lockPath);
	} catch {
		// Corrupt or unreadable — best effort cleanup
		try {
			unlinkSync(lockPath);
		} catch {
			// ignore
		}
	}
}

/**
 * Check if a dream is currently running (for auto-dream trigger decision).
 * Returns true only if there's a FRESH active lock.
 */
export function isDreamRunning(basePath: string): boolean {
	return getLockStatus(basePath).locked;
}
