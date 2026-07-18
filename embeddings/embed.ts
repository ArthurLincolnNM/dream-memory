/**
 * dream-memory/embeddings/embed.ts
 *
 * Local embedding generation for semantic re-rank in recall.
 *
 * Design:
 * - Lazy singleton model load (one-time, ~25MB download, then cached).
 * - `embed(text)` returns Float32Array (384 dims) or null on any failure.
 *   Null is the universal "fall back to BM25" signal — callers never
 *   need to check model availability; they just pass the result to
 *   cosineSim which handles null arrays as zero similarity.
 * - `cosineSim(a, b)` works on any Float32Array pair. Assumes L2-normalized
 *   input (the MiniLM model output IS normalized, so this holds). For
 *   non-normalized vectors, would need to divide by ||a||*||b||.
 *
 * Opt-in via install: `@huggingface/transformers` is in optionalDependencies
 * so npm install never fails. If the package isn't present, the dynamic
 * import at the top of this file throws, the load fails, and embed() always
 * returns null. BM25 path keeps working exactly as before.
 *
 * Performance:
 * - First call: model download + ONNX init (~5-15s, one-time, cached on disk)
 * - Subsequent calls: ~5-30ms per text on CPU, <5ms on CUDA
 * - For a recall (1 query embed + ~20 cosine sims), total ~50-80ms
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Model: all-MiniLM-L6-v2 quantized to int8. 384 dims, ~23MB download. */
const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
/** Cache directory for the model (avoids re-download). */
const MODEL_CACHE_DIR = join(homedir(), ".cache", "dream-memory-models");

/** Embedding dimensionality for this model. Stored alongside vectors so
 *  the cosine function can validate dimensions match. */
export const EMBEDDING_DIM = 384;

let pipeline: any = null;
let extractorPromise: Promise<any> | null = null;

/**
 * Try to load the @huggingface/transformers package. Returns the `pipeline`
 * factory on success, or null if the package isn't installed (optional dep
 * not satisfied).
 *
 * We use a dynamic import so the missing-package case doesn't crash the
 * whole extension at load time. This matters because dream-memory is a Pi
 * extension — if it throws on import, the agent can't start at all.
 *
 * Also configures `env.cacheDir` to point at a discoverable location
 * (the same `~/.cache/dream-memory-models/` documented at the top of
 * this file) so the user can find the downloaded model without grepping
 * node_modules. The library's v3 API uses `env.cacheDir` (an exported
 * mutable object), NOT the `TRANSFORMERS_CACHE` env var (which is the
 * v2 / python convention and is silently ignored by v3 in Node).
 */
async function tryGetPipeline(): Promise<any | null> {
	if (pipeline) return pipeline;
	try {
		// Dynamic import: throws if package not installed
		const mod = await import("@huggingface/transformers");
		// Configure the cache directory BEFORE the first pipeline() call,
		// so the model is downloaded to a predictable location. The library
		// reads env.cacheDir lazily on each download, so a late set is OK
		// but doing it here keeps the contract clear.
		if (mod.env && typeof (mod.env as any).cacheDir !== "undefined") {
			(mod.env as any).cacheDir = MODEL_CACHE_DIR;
		}
		pipeline = (mod as any).pipeline;
		return pipeline;
	} catch (err) {
		// Package not installed (or failed to load). Silent: this is the
		// expected state when the user hasn't opted in. The caller checks
		// for null and falls back to BM25.
		if (process.env.DREAM_DEBUG) {
			console.warn(`[dream] @huggingface/transformers not available: ${(err as Error).message}`);
		}
		return null;
	}
}

/**
 * Get the feature-extraction pipeline. Lazy-loads on first call. Concurrent
 * callers share the same promise (no duplicate loads).
 *
 * @throws if the package isn't installed (caught by embed() and turned into null)
 */
async function getExtractor(): Promise<any> {
	if (extractorPromise) return extractorPromise;
	extractorPromise = (async () => {
		const p = await tryGetPipeline();
		if (!p) throw new Error("@huggingface/transformers not installed");
		// Ensure cache dir exists. The library creates the dir itself when
		// downloading, but creating it upfront makes the contract explicit
		// and gives a clearer error if the home dir is read-only.
		if (!existsSync(MODEL_CACHE_DIR)) {
			mkdirSync(MODEL_CACHE_DIR, { recursive: true });
		}
		// env.cacheDir is set inside tryGetPipeline() above. We just
		// trigger the actual download/load here.
		return p("feature-extraction", MODEL_NAME, { dtype: "q8" });
	})();
	return extractorPromise;
}

/**
 * Embed a text string into a 384-dim vector. Returns null on any failure
 * (model not installed, ONNX error, empty input, etc). The null contract
 * is what makes the rest of the system graceful: callers can pipe the
 * result through cosineSim without checking availability.
 *
 * Input is trimmed and length-capped (2000 chars) to avoid pathological
 * inputs blowing up the model's context window. MiniLM's max is 256 word
 * pieces (~1000-1500 chars), but we allow some headroom for tokenization
 * variance.
 */
export async function embed(text: string): Promise<Float32Array | null> {
	if (typeof text !== "string" || text.trim().length === 0) return null;
	const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
	try {
		const extractor = await getExtractor();
		const output = await extractor(truncated, { pooling: "mean", normalize: true });
		// output.data is Float32Array-like. Wrap in a new Float32Array so
		// the buffer is portable across serialization boundaries.
		return new Float32Array(output.data as ArrayLike<number>);
	} catch (err) {
		if (process.env.DREAM_DEBUG) {
			console.warn(`[dream] embed() failed: ${(err as Error).message}`);
		}
		return null;
	}
}

/**
 * Synchronous best-effort query embed. Used in the hot path (recall) where
 * we can't await without adding 30ms+ latency per turn.
 *
 * Strategy: keep the last embedded query in a module-level cache. If the
 * current query matches (normalized), reuse. If not, schedule a background
 * embed and return null for now (caller falls back to BM25 only). Next
 * turn with the same query will hit the cache.
 *
 * This is a pragmatic compromise: a new query takes 1 turn to "warm up" the
 * semantic layer, but a repeated query (very common — users often re-ask
 * similar things) gets instant semantic search.
 */
let lastEmbeddedQuery: string | null = null;
let lastEmbeddedVector: Float32Array | null = null;
let inflightQuery: string | null = null;
let inflightPromise: Promise<void> | null = null;

export function primeQueryEmbedding(query: string): void {
	if (typeof query !== "string") return;
	const normalized = query.trim();
	if (!normalized || normalized === lastEmbeddedQuery || normalized === inflightQuery) return;
	inflightQuery = normalized;
	inflightPromise = (async () => {
		const vec = await embed(normalized);
		if (vec) {
			lastEmbeddedQuery = normalized;
			lastEmbeddedVector = vec;
		}
		inflightQuery = null;
		inflightPromise = null;
	})();
}

export function getCachedQueryEmbedding(query: string): Float32Array | null {
	const normalized = query.trim();
	if (lastEmbeddedQuery === normalized && lastEmbeddedVector) {
		return lastEmbeddedVector;
	}
	return null;
}

/**
 * Cosine similarity between two vectors. Returns 0 if either is null or
 * if dimensions don't match. The MiniLM output is L2-normalized, so the
 * dot product IS the cosine similarity — no need to divide by magnitudes.
 *
 * Performance: ~5μs for 384 dims in V8. Safe to call inside a tight loop.
 */
export function cosineSim(a: Float32Array | null, b: Float32Array | null): number {
	if (!a || !b) return 0;
	if (a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
	}
	return dot;
}

/**
 * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
 * Uses the platform's native endianness (little-endian on every platform
 * SQLite runs on). The reverse is `bytesToVector`.
 */
export function vectorToBytes(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Deserialize a Buffer from SQLite BLOB back to a Float32Array.
 * Returns null if the buffer is the wrong size (defensive — old embeddings
 * with a different dimension would mismatch).
 */
export function bytesToVector(buf: Buffer | Uint8Array | null | undefined): Float32Array | null {
	if (!buf || buf.byteLength === 0) return null;
	if (buf.byteLength !== EMBEDDING_DIM * 4) return null;
	// Copy into a new buffer so the resulting Float32Array owns its memory
	// (avoids alignment issues with arbitrary byteOffsets from SQLite).
	const copy = Buffer.from(buf);
	return new Float32Array(copy.buffer, copy.byteOffset, EMBEDDING_DIM);
}

/**
 * Force-warm the model. Useful in tests or session_start to pre-load the
 * model before the first recall. Returns true if the model loaded, false
 * if the package isn't installed. Errors during model load return false
 * (logged under DREAM_DEBUG).
 */
export async function warmupEmbedder(): Promise<boolean> {
	try {
		await getExtractor();
		return true;
	} catch {
		return false;
	}
}

/**
 * Reset module state. Test-only. Clears the singleton, the in-flight
 * promise, and the query cache. Without this, tests that mock the
 * @huggingface/transformers module would see stale state.
 */
export function _resetForTests(): void {
	pipeline = null;
	extractorPromise = null;
	lastEmbeddedQuery = null;
	lastEmbeddedVector = null;
	inflightQuery = null;
	inflightPromise = null;
}
