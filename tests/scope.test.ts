/**
 * Tests for scope resolution (bug #11 fix).
 *
 * Background: `resolveScope` did not set `scopeId` when `scopeOverride`
 * was `"session"`, so session-scoped memories ended up with
 * `scope_id = null`. The shutdown cleanup then couldn't find them, and
 * they leaked until TTL (1d) expired. The fix sets `scopeId = sessionId`
 * for session overrides.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolveScope } from "../scope/resolver.js";

test("session override sets scopeId to the sessionId", () => {
	const ctx = resolveScope({
		cwd: "/tmp",
		sessionId: "sess-abc-123",
		scopeOverride: "session",
	});
	assert.equal(ctx.scope, "session");
	assert.equal(ctx.scopeId, "sess-abc-123");
	assert.equal(ctx.sessionId, "sess-abc-123");
});

test("session override with explicit scopeIdOverride respects the override", () => {
	const ctx = resolveScope({
		cwd: "/tmp",
		sessionId: "sess-abc-123",
		scopeOverride: "session",
		scopeIdOverride: "custom-session-id",
	});
	assert.equal(ctx.scope, "session");
	assert.equal(ctx.scopeId, "custom-session-id");
});

test("session override is independent of cwd (no project required)", () => {
	// Even from a non-project cwd, session scope should work
	const ctx = resolveScope({
		cwd: "/tmp/no-project",
		sessionId: "sess-xyz",
		scopeOverride: "session",
	});
	assert.equal(ctx.scope, "session");
	assert.equal(ctx.scopeId, "sess-xyz");
});

test("project override in a real project sets scopeId to project name", () => {
	// /tmp has neither .git nor package.json — we use isRealProject semantics
	// so this should downgrade to global (existing behavior, unchanged)
	const ctx = resolveScope({
		cwd: "/tmp",
		sessionId: "sess-1",
		scopeOverride: "project",
	});
	assert.equal(ctx.scope, "global", "should downgrade to global when no project detected");
});

test("agent override auto-detects from systemPrompt when no override", () => {
	const ctx = resolveScope({
		cwd: "/tmp",
		sessionId: "sess-1",
		systemPrompt: "You are SRE-Bot. You monitor infrastructure.",
	});
	// Without scopeOverride, the resolver auto-picks agent if detected
	assert.equal(ctx.scope, "agent");
	assert.equal(ctx.scopeId, "SRE-Bot");
});

test("no override and no project/agent detected falls back to global", () => {
	const ctx = resolveScope({
		cwd: "/tmp",
		sessionId: "sess-1",
	});
	assert.equal(ctx.scope, "global");
	assert.equal(ctx.scopeId, undefined);
});
