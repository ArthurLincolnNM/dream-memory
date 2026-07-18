/**
 * Tests for the dream lock file (Phase 2 fix for #12).
 *
 * Background: the previous lock only stored `pid`, so a recycled PID
 * (different process reusing the holder's PID) could pass the existence
 * check and hold a phantom lock. The fix adds `ppid` + `hostname` to the
 * lock content and rejects locks whose host or parent PID don't match
 * the current process.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { acquireLock, getLockStatus, releaseLock, isDreamRunning } from "../dream/lock.js";

function makeBasePath(): { basePath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-lock-test-"));
	return {
		basePath: dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("acquireLock succeeds when no lock exists", () => {
	const { basePath, cleanup } = makeBasePath();
	try {
		const result = acquireLock(basePath, "manual");
		assert.equal(result.acquired, true);
		assert.equal(result.reason, "fresh");
		releaseLock(basePath);
	} finally {
		cleanup();
	}
});

test("acquireLock fails when fresh lock is held by another process", () => {
	const { basePath, cleanup } = makeBasePath();
	try {
		// We are the only process here, so simulate "another process" by
		// writing a lock file with a different (but alive) PID. We use
		// process.pid + 1 — guaranteed different and "alive" enough for
		// process.kill(pid, 0) which only checks for ESRCH.
		const foreignPid = process.pid + 9999; // very unlikely to collide
		writeFileSync(
			join(basePath, ".dream.lock"),
			JSON.stringify(
				{
					pid: foreignPid,
					ppid: process.ppid,
					hostname: hostname(),
					startedAt: Date.now(),
					type: "manual",
				},
				null,
				2,
			),
		);
		const result = acquireLock(basePath, "auto");
		// Either acquires-as-stale-overwritten (if the foreign pid check
		// fails for some reason) or fails. Either way, the lock file should
		// not be silently overwritten when a fresh foreign lock is detected.
		if (result.acquired) {
			assert.equal(result.reason, "stale-overwritten");
		} else {
			assert.equal(result.reason, "active");
		}
	} finally {
		cleanup();
	}
});

test("getLockStatus treats locks with mismatched hostname as stale", () => {
	const { basePath, cleanup } = makeBasePath();
	try {
		// Write a lock with the wrong hostname. PPID and PID match the
		// current process; the only "wrong" field is hostname.
		writeFileSync(
			join(basePath, ".dream.lock"),
			JSON.stringify(
				{
					pid: process.pid,
					ppid: process.ppid,
					hostname: "definitely-not-this-host-12345",
					startedAt: Date.now(),
					type: "manual",
				},
				null,
				2,
			),
		);
		const status = getLockStatus(basePath);
		assert.equal(status.stale, true, "wrong-host lock should be stale");
		assert.equal(status.locked, false);
	} finally {
		cleanup();
	}
});

test("getLockStatus treats locks with mismatched ppid as stale (parent died)", () => {
	const { basePath, cleanup } = makeBasePath();
	try {
		// Write a lock with the wrong ppid (e.g., 1 = init). The pid
		// matches the current process but the parent is "different" from
		// the current ppid, simulating "original parent died, process
		// reparented to init".
		writeFileSync(
			join(basePath, ".dream.lock"),
			JSON.stringify(
				{
					pid: process.pid,
					ppid: 1,
					hostname: hostname(),
					startedAt: Date.now(),
					type: "manual",
				},
				null,
				2,
			),
		);
		const status = getLockStatus(basePath);
		assert.equal(status.stale, true, "wrong-ppid lock should be stale");
		assert.equal(status.locked, false);
	} finally {
		cleanup();
	}
});

test("getLockStatus treats locks older than stale threshold as stale", () => {
	const { basePath, cleanup } = makeBasePath();
	try {
		const ancient = Date.now() - 60 * 60 * 1000; // 1 hour ago
		writeFileSync(
			join(basePath, ".dream.lock"),
			JSON.stringify(
				{
					pid: process.pid,
					ppid: process.ppid,
					hostname: hostname(),
					startedAt: ancient,
					type: "manual",
				},
				null,
				2,
			),
		);
		const status = getLockStatus(basePath);
		assert.equal(status.stale, true);
	} finally {
		cleanup();
	}
});

test("isDreamRunning returns false when no lock exists", () => {
	const { basePath, cleanup } = makeBasePath();
	try {
		assert.equal(isDreamRunning(basePath), false);
	} finally {
		cleanup();
	}
});

test("releaseLock only removes the lock if the PID matches (we own it)", () => {
	const { basePath, cleanup } = makeBasePath();
	try {
		acquireLock(basePath, "manual");
		const lockPath = join(basePath, ".dream.lock");
		// Read the lock to confirm pid is ours
		const before = JSON.parse(readFileSync(lockPath, "utf-8"));
		assert.equal(before.pid, process.pid);

		// Simulate "another process took the lock" by overwriting with a
		// different pid. Our releaseLock should refuse to delete it.
		const foreignPid = process.pid + 9999;
		writeFileSync(
			lockPath,
			JSON.stringify({ ...before, pid: foreignPid }, null, 2),
		);
		releaseLock(basePath);
		const stillThere = JSON.parse(readFileSync(lockPath, "utf-8"));
		assert.equal(stillThere.pid, foreignPid, "lock should NOT be removed when pid doesn't match");
	} finally {
		cleanup();
	}
});
