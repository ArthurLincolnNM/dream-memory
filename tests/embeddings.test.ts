/**
 * Tests for embeddings/embed.ts and the semantic re-rank in search/hybrid.ts.
 *
 * Strategy: avoid loading the actual ML model in tests (slow, requires
 * network for the one-time model download). Test the pure functions
 * directly, and inject vectors via `updateEmbedding` for the integration
 * tests. This gives us full coverage of the algorithm without CI flakiness.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DreamStore } from "../store/sqlite.js";
import { hybridSearch } from "../search/hybrid.js";
import {
	bytesToVector,
	cosineSim,
	embed,
	primeQueryEmbedding,
	getCachedQueryEmbedding,
	vectorToBytes,
	warmupEmbedder,
	_resetForTests,
	EMBEDDING_DIM,
} from "../embeddings/embed.js";

function makeStore(): { store: DreamStore; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-emb-test-"));
	const store = new DreamStore(join(dir, "test.db"));
	return {
		store,
		dir,
		cleanup: () => {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Build a synthetic L2-normalized Float32Array. */
function fakeVec(seed: number): Float32Array {
	const v = new Float32Array(EMBEDDING_DIM);
	let norm = 0;
	for (let i = 0; i < EMBEDDING_DIM; i++) {
		v[i] = Math.sin(seed + i * 0.1);
		norm += v[i] * v[i];
	}
	norm = Math.sqrt(norm);
	for (let i = 0; i < EMBEDDING_DIM; i++) v[i] /= norm;
	return v;
}

// ── Pure functions ─────────────────────────────────────────────────────

test("cosineSim: identical vectors = 1.0", () => {
	const v = fakeVec(1);
	assert.ok(Math.abs(cosineSim(v, v) - 1.0) < 1e-6);
});

test("cosineSim: orthogonal vectors = 0", () => {
	const a = new Float32Array([1, 0, 0, 0]);
	const b = new Float32Array([0, 1, 0, 0]);
	assert.equal(cosineSim(a, b), 0);
});

test("cosineSim: opposite vectors = -1", () => {
	const a = new Float32Array([1, 0]);
	const b = new Float32Array([-1, 0]);
	assert.equal(cosineSim(a, b), -1);
});

test("cosineSim: null inputs return 0 (graceful)", () => {
	assert.equal(cosineSim(null, fakeVec(1)), 0);
	assert.equal(cosineSim(fakeVec(1), null), 0);
	assert.equal(cosineSim(null, null), 0);
});

test("cosineSim: dimension mismatch returns 0", () => {
	const a = new Float32Array(EMBEDDING_DIM);
	const b = new Float32Array(EMBEDDING_DIM + 1);
	assert.equal(cosineSim(a, b), 0);
});

test("vectorToBytes + bytesToVector round-trip preserves data", () => {
	const v = fakeVec(42);
	const buf = vectorToBytes(v);
	const restored = bytesToVector(buf);
	assert.ok(restored, "round-trip should produce non-null vector");
	assert.equal(restored!.length, EMBEDDING_DIM);
	for (let i = 0; i < EMBEDDING_DIM; i++) {
		assert.ok(Math.abs(restored![i] - v[i]) < 1e-6);
	}
});

test("bytesToVector returns null for null input", () => {
	assert.equal(bytesToVector(null), null);
});

test("bytesToVector returns null for empty buffer", () => {
	assert.equal(bytesToVector(Buffer.alloc(0)), null);
});

test("bytesToVector returns null for wrong-dimension buffer", () => {
	// Simulate old embedding with a different dim (e.g., 1536 from a
	// prior version or a different model)
	const wrong = Buffer.alloc(1536 * 4);
	assert.equal(bytesToVector(wrong), null);
});

// ── embed() graceful fallback ──────────────────────────────────────────

test("embed() returns null on empty input", async () => {
	const result = await embed("");
	assert.equal(result, null);
});

test("embed() returns null on whitespace input", async () => {
	const result = await embed("   \n\t  ");
	assert.equal(result, null);
});

test("embed() returns null on non-string input", async () => {
	// @ts-expect-error - testing runtime safety
	const result = await embed(null);
	assert.equal(result, null);
});

// ── warmupEmbedder / model availability ────────────────────────────────

test("warmupEmbedder returns boolean (true if model loads, false if not installed)", async () => {
	_resetForTests();
	const ok = await warmupEmbedder();
	// We don't assert true/false — depends on whether the optional dep is
	// installed in the test env. The contract is: returns a boolean and
	// never throws.
	assert.equal(typeof ok, "boolean");
});

// ── Query embedding cache ──────────────────────────────────────────────

test("primeQueryEmbedding + getCachedQueryEmbedding: cache miss returns null", () => {
	_resetForTests();
	assert.equal(getCachedQueryEmbedding("never primed"), null);
});

test("primeQueryEmbedding: non-string input is a no-op", () => {
	_resetForTests();
	// @ts-expect-error - testing runtime safety
	primeQueryEmbedding(null);
	// @ts-expect-error - testing runtime safety
	primeQueryEmbedding(undefined);
	// @ts-expect-error - testing runtime safety
	primeQueryEmbedding(42);
	assert.equal(getCachedQueryEmbedding("anything"), null);
});

test("primeQueryEmbedding: empty string is a no-op", () => {
	_resetForTests();
	primeQueryEmbedding("");
	primeQueryEmbedding("   ");
	assert.equal(getCachedQueryEmbedding("anything"), null);
});

// ── Store integration: updateEmbedding ─────────────────────────────────

test("DreamStore.updateEmbedding stores and retrieves vector", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "Test memory",
			scope: "global",
			target: "user",
			category: "preference",
		});
		// Initially null
		assert.equal(mem.embedding, undefined);

		const v = fakeVec(7);
		const ok = store.updateEmbedding(mem.id, vectorToBytes(v));
		assert.equal(ok, true);

		// Read back
		const fetched = store.getMemory(mem.id);
		assert.ok(fetched);
		assert.ok(fetched!.embedding, "embedding should be present after update");
		assert.equal(fetched!.embedding!.byteLength, EMBEDDING_DIM * 4);
	} finally {
		cleanup();
	}
});

test("DreamStore.updateEmbedding: null clears the vector", () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "Test memory",
			scope: "global",
			target: "user",
		});
		store.updateEmbedding(mem.id, vectorToBytes(fakeVec(1)));
		const ok = store.updateEmbedding(mem.id, null);
		assert.equal(ok, true);
		const fetched = store.getMemory(mem.id);
		// parseRow converts SQL NULL to undefined (line 2067: row.embedding ?? undefined)
		assert.equal(fetched!.embedding, undefined);
	} finally {
		cleanup();
	}
});

test("DreamStore.updateEmbedding: unknown id returns false (no crash)", () => {
	const { store, cleanup } = makeStore();
	try {
		const ok = store.updateEmbedding("nonexistent-uuid", vectorToBytes(fakeVec(1)));
		assert.equal(ok, false);
	} finally {
		cleanup();
	}
});

test("DreamStore.updateEmbedding: does NOT bump updated_at (TTL preserved)", async () => {
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "Test memory",
			scope: "global",
			target: "user",
			ttl_days: 7,
		});
		const originalUpdatedAt = mem.updated_at;
		const originalExpiresAt = mem.expires_at;
		// Wait a tiny bit so Date.now() advances past the create timestamp
		await new Promise((r) => setTimeout(r, 10));
		store.updateEmbedding(mem.id, vectorToBytes(fakeVec(1)));
		const after = store.getMemory(mem.id);
		assert.equal(after!.updated_at, originalUpdatedAt, "updated_at should NOT change on embedding write");
		assert.equal(after!.expires_at, originalExpiresAt, "expires_at should NOT change on embedding write");
		// Sanity: a real update would bump updated_at
		store.updateMemory(mem.id, { content: "Updated content" });
		const afterRealUpdate = store.getMemory(mem.id);
		assert.ok(afterRealUpdate!.updated_at >= originalUpdatedAt, "real update should bump updated_at");
	} finally {
		cleanup();
	}
});

// ── Semantic re-rank in hybridSearch ───────────────────────────────────

test("hybridSearch: explicit semanticQuery with matching embedding boosts relevance", () => {
	const { store, cleanup } = makeStore();
	try {
		// Create two memories: A matches the query lexically AND semantically,
		// B only matches lexically (different topic, same keyword).
		const a = store.createMemory({
			content: "Keybinding Ctrl+P abre command palette no Zed",
			scope: "global",
			target: "user",
			category: "convention",
		});
		const b = store.createMemory({
			content: "Ctrl+P tambem funciona no VSCode",
			scope: "global",
			target: "user",
			category: "convention",
		});

		// Inject vectors: A's vector is "close" to query, B's is "far"
		const queryVec = fakeVec(100);
		// A's vector: similar to query (same seed+1)
		store.updateEmbedding(a.id, vectorToBytes(fakeVec(101)));
		// B's vector: orthogonal to query (very different seed)
		store.updateEmbedding(b.id, vectorToBytes(fakeVec(9999)));

		// Run search WITH semantic query
		const results = hybridSearch(store, "Ctrl+P command palette", {
			applyDecay: false,
			semanticQuery: queryVec,
		});

		// A should rank above B because its embedding matches the query
		const aIdx = results.findIndex((r) => r.memory.id === a.id);
		const bIdx = results.findIndex((r) => r.memory.id === b.id);
		assert.ok(aIdx >= 0 && bIdx >= 0, "both should be returned");
		assert.ok(aIdx < bIdx, `A (semantic match) should rank above B (lexical-only); got A=${aIdx}, B=${bIdx}`);
	} finally {
		cleanup();
	}
});

test("hybridSearch: semanticQuery=null is the default (BM25-only path unchanged)", () => {
	const { store, cleanup } = makeStore();
	try {
		const a = store.createMemory({
			content: "Keybinding Ctrl+P command palette",
			scope: "global",
			target: "user",
		});
		const b = store.createMemory({
			content: "Ctrl+P shortcuts are good",
			scope: "global",
			target: "user",
		});
		// Inject wildly different embeddings to confirm they're IGNORED
		store.updateEmbedding(a.id, vectorToBytes(fakeVec(1)));
		store.updateEmbedding(b.id, vectorToBytes(fakeVec(9999)));

		// No semanticQuery option: should run pure BM25, ignoring embeddings
		const results = hybridSearch(store, "Ctrl+P command palette", { applyDecay: false });
		const aIdx = results.findIndex((r) => r.memory.id === a.id);
		const bIdx = results.findIndex((r) => r.memory.id === b.id);
		// BM25 should rank a (more terms matched) above b
		assert.ok(aIdx < bIdx, "BM25 should rank a (more lexical overlap) above b");
	} finally {
		cleanup();
	}
});

test("hybridSearch: memories without embeddings still appear in results", () => {
	const { store, cleanup } = makeStore();
	try {
		const withVec = store.createMemory({
			content: "Zed editor keybindings",
			scope: "global",
			target: "user",
		});
		const withoutVec = store.createMemory({
			content: "Zed editor is fast",
			scope: "global",
			target: "user",
		});
		store.updateEmbedding(withVec.id, vectorToBytes(fakeVec(1)));
		// withoutVec: no embedding, simulating pre-feature memory

		const results = hybridSearch(store, "Zed editor", {
			applyDecay: false,
			semanticQuery: fakeVec(1), // query close to withVec
		});

		const ids = results.map((r) => r.memory.id);
		assert.ok(ids.includes(withVec.id), "withVec should be in results");
		assert.ok(ids.includes(withoutVec.id), "withoutVec should still be in results (not silently dropped)");
	} finally {
		cleanup();
	}
});

test("hybridSearch: semanticWeight=0 gives pure BM25 ranking", () => {
	const { store, cleanup } = makeStore();
	try {
		const a = store.createMemory({
			content: "alpha beta gamma keybinding Zed",
			scope: "global",
			target: "user",
		});
		const b = store.createMemory({
			content: "alpha beta keybinding Zed",
			scope: "global",
			target: "user",
		});
		// a has 3 terms matching, b has 2. Invert with embeddings: a's vec
		// is FAR from query, b's vec is CLOSE. With semanticWeight=0,
		// lexical ranking should win.
		store.updateEmbedding(a.id, vectorToBytes(fakeVec(9999)));
		store.updateEmbedding(b.id, vectorToBytes(fakeVec(100)));

		const results = hybridSearch(store, "alpha beta gamma", {
			applyDecay: false,
			semanticQuery: fakeVec(100),
			semanticWeight: 0,
		});
		const aIdx = results.findIndex((r) => r.memory.id === a.id);
		const bIdx = results.findIndex((r) => r.memory.id === b.id);
		assert.ok(aIdx < bIdx, "With semanticWeight=0, lexical (more terms) should win");
	} finally {
		cleanup();
	}
});

test("hybridSearch: semanticWeight=1 gives pure semantic ranking", () => {
	const { store, cleanup } = makeStore();
	try {
		const a = store.createMemory({
			content: "alpha beta gamma keybinding Zed",
			scope: "global",
			target: "user",
		});
		const b = store.createMemory({
			content: "alpha beta keybinding Zed",
			scope: "global",
			target: "user",
		});
		// Same setup as previous test, but with semanticWeight=1
		store.updateEmbedding(a.id, vectorToBytes(fakeVec(9999)));
		store.updateEmbedding(b.id, vectorToBytes(fakeVec(100)));

		const results = hybridSearch(store, "alpha beta gamma", {
			applyDecay: false,
			semanticQuery: fakeVec(100),
			semanticWeight: 1,
		});
		const aIdx = results.findIndex((r) => r.memory.id === a.id);
		const bIdx = results.findIndex((r) => r.memory.id === b.id);
		// With semanticWeight=1, b (closer embedding) should win
		assert.ok(bIdx < aIdx, "With semanticWeight=1, semantic (closer embedding) should win");
	} finally {
		cleanup();
	}
});

test("hybridSearch: RRF score magnitude matches literature formula (semanticWeight=1, tight)", () => {
	// Catches off-by-one in semantic RRF (e.g., `semanticRank + 1 + 1`
	// instead of `+ 1`). We test the PURE semantic channel (weight=1) so
	// the score depends only on the semantic RRF, with no lexical term
	// masking the bug. The literature value for K=60, rank=0 is exactly
	// 1/61. An off-by-one mutation produces 1/62 instead — a delta of
	// 0.00026, which is large enough to catch with tight tolerance.
	const { store, cleanup } = makeStore();
	try {
		const mem = store.createMemory({
			content: "single memory",
			scope: "global",
			target: "user",
		});
		store.updateEmbedding(mem.id, vectorToBytes(fakeVec(1)));

		const results = hybridSearch(store, "single", {
			applyDecay: false,
			semanticQuery: fakeVec(1),
			semanticWeight: 1, // pure semantic
		});
		assert.equal(results.length, 1);
		const score = results[0].score;
		const expected = 1 / 61;
		// Tight tolerance: off-by-one gives 1/62 ≈ 0.016129, off-by-two
		// gives 1/63. Both are > 1e-4 away from 1/61.
		assert.ok(
			Math.abs(score - expected) < 1e-4,
			`RRF top score (semanticWeight=1) should be 1/61=${expected.toFixed(6)}, got ${score.toFixed(6)}`,
		);
	} finally {
		cleanup();
	}
});

test("hybridSearch: default semanticWeight is 0.5 (balanced), not pure semantic", () => {
	// Catches default-value mutations (e.g., `?? 1.0` instead of `?? 0.5`).
	// Previous tests always passed semanticWeight explicitly, so a default
	// change was invisible. To make the default observable, we need
	// ASYMMETRIC rank pairs (A and B with crossed lex/sem ranks) — when
	// the ranks are parallel (A:0/0, B:1/1), the weight cancels out and
	// the gap is the same regardless of default.
	//
	// Setup: A is lex-strong, sem-weak; B is lex-weak, sem-strong. With
	// weight 0.5 the two channels balance and A, B tie. With weight 1.0
	// only lex matters, so A wins clearly.
	const { store, cleanup } = makeStore();
	try {
		// A: 3/3 query terms, strong lexical match → lex rank 0
		const a = store.createMemory({
			content: "alpha beta gamma Zed keybinding",
			scope: "global",
			target: "user",
		});
		// B: 1/N overlap, weak lexical match → lex rank 1
		const b = store.createMemory({
			content: "alpha zulu yankee wahoo unrelated words here",
			scope: "global",
			target: "user",
		});
		// A: vec far from query (sem rank 1)
		store.updateEmbedding(a.id, vectorToBytes(fakeVec(9999)));
		// B: vec identical to query (sem rank 0, highest cosine)
		store.updateEmbedding(b.id, vectorToBytes(fakeVec(100)));

		// Run WITHOUT specifying semanticWeight — uses default
		const results = hybridSearch(store, "alpha beta gamma", {
			applyDecay: false,
			semanticQuery: fakeVec(100),
			// semanticWeight deliberately omitted
		});
		assert.equal(results.length, 2);
		const scoreA = results.find((r) => r.memory.id === a.id)!.score;
		const scoreB = results.find((r) => r.memory.id === b.id)!.score;
		// With default 0.5: A=0.5/61+0.5/62 ≈ B=0.5/62+0.5/61 → TIE
		// With weight 1.0: A=1/61 > B=1/62 → A wins by 0.000264
		// Asserting they're within 1e-6 of each other catches the mutation
		// (it would produce a clear A>B gap of 0.000264).
		assert.ok(
			Math.abs(scoreA - scoreB) < 1e-6,
			`Default semanticWeight=0.5 should make A and B tie (asymmetric setup); ` +
			`got A=${scoreA.toFixed(6)}, B=${scoreB.toFixed(6)}, gap=${(scoreA - scoreB).toFixed(6)}. ` +
			`If gap is ~0.000264, default was changed to 1.0 (pure lexical — A wins).`,
		);
	} finally {
		cleanup();
	}
});

test("hybridSearch: RRF lexical channel also matches formula (semanticWeight=0, tight)", () => {
	// Mirror of the previous test, but for the lexical channel. Catches
	// off-by-one mutations in the LEXICAL RRF too. We pass a non-null
	// semanticQuery (any vector) so the RRF branch RUNS, but with
	// semanticWeight=0 the semantic term is zero and only the lexical
	// term contributes.
	const { store, cleanup } = makeStore();
	try {
		store.createMemory({
			content: "single memory",
			scope: "global",
			target: "user",
		});

		const results = hybridSearch(store, "single", {
			applyDecay: false,
			semanticQuery: fakeVec(1),
			semanticWeight: 0,
		});
		assert.equal(results.length, 1);
		const score = results[0].score;
		const expected = 1 / 61; // K=60, rank=0
		assert.ok(
			Math.abs(score - expected) < 1e-4,
			`RRF top score (semanticWeight=0) should be 1/61=${expected.toFixed(6)}, got ${score.toFixed(6)}`,
		);
	} finally {
		cleanup();
	}
});
