/**
 * dream-memory/utils/observability.ts
 * Enhanced diagnostics and metrics tracking
 */

export interface Metrics {
	recall: {
		total: number;
		successful: number;
		failed: number;
		avgLatencyMs: number;
		lastRecall?: {
			timestamp: number;
			query: string;
			resultCount: number;
			latencyMs: number;
		};
	};
	storage: {
		totalMemories: number;
		totalAdds: number;
		totalUpdates: number;
		totalDeletes: number;
		lastAdd?: {
			timestamp: number;
			content: string;
			target: string;
		};
	};
	contradictions: {
		detected: number;
		autoResolved: number;
		llmArbitrated: number;
		keptBoth: number;
		discarded: number;
	};
	distill: {
		patternsDetected: number;
		skillsGenerated: number;
		lastDistill?: {
			timestamp: number;
			patterns: number;
			generated: number;
		};
	};
	performance: {
		searchLatencyMs: number[];
		addLatencyMs: number[];
	};
	rollback: {
		edgeCasesDetected: number; // cross-store moves that batch rollback can't fully revert
		lastEdgeCase?: {
			timestamp: number;
			memoryId: string;
			store: "global" | "project";
			batchId: string;
		};
	};
}

const DEFAULT_METRICS: Metrics = {
	recall: { total: 0, successful: 0, failed: 0, avgLatencyMs: 0 },
	storage: { totalMemories: 0, totalAdds: 0, totalUpdates: 0, totalDeletes: 0 },
	contradictions: { detected: 0, autoResolved: 0, llmArbitrated: 0, keptBoth: 0, discarded: 0 },
	distill: { patternsDetected: 0, skillsGenerated: 0 },
	performance: { searchLatencyMs: [], addLatencyMs: [] },
	rollback: { edgeCasesDetected: 0 },
};

export class Observability {
	private metrics: Metrics;
	private startTime: number;

	constructor() {
		this.metrics = JSON.parse(JSON.stringify(DEFAULT_METRICS));
		this.startTime = Date.now();
	}

	// ── Recall Metrics ──────────────────────────────────────────────────

	recordRecall(params: { query: string; resultCount: number; latencyMs: number; success: boolean }): void {
		this.metrics.recall.total++;

		if (params.success) {
			this.metrics.recall.successful++;
		} else {
			this.metrics.recall.failed++;
		}

		// Update average latency
		const total = this.metrics.recall.successful + this.metrics.recall.failed;
		this.metrics.recall.avgLatencyMs = (this.metrics.recall.avgLatencyMs * (total - 1) + params.latencyMs) / total;

		this.metrics.recall.lastRecall = {
			timestamp: Date.now(),
			query: params.query.slice(0, 100),
			resultCount: params.resultCount,
			latencyMs: params.latencyMs,
		};
	}

	// ── Storage Metrics ─────────────────────────────────────────────────

	recordAdd(params: { content: string; target: string }): void {
		this.metrics.storage.totalAdds++;
		this.metrics.storage.lastAdd = {
			timestamp: Date.now(),
			content: params.content.slice(0, 100),
			target: params.target,
		};
	}

	recordUpdate(): void {
		this.metrics.storage.totalUpdates++;
	}

	recordDelete(): void {
		this.metrics.storage.totalDeletes++;
	}

	updateMemoryCount(count: number): void {
		this.metrics.storage.totalMemories = count;
	}

	// ── Queue Metrics ───────────────────────────────────────────────────

	recordContradiction(params: { detected: boolean; action: string }): void {
		if (params.detected) {
			this.metrics.contradictions.detected++;
		}

		switch (params.action) {
			case "replace":
				this.metrics.contradictions.autoResolved++;
				break;
			case "keep-both":
				this.metrics.contradictions.keptBoth++;
				break;
			case "discard":
				this.metrics.contradictions.discarded++;
				break;
			case "ask-user":
				// User-mediated arbitration (the ambiguous-range path in
				// contradiction/resolver.ts). Was previously a dead field.
				this.metrics.contradictions.llmArbitrated++;
				break;
		}
	}

	// ── Distill Metrics ─────────────────────────────────────────────────

	recordDistill(params: { patterns: number; generated: number }): void {
		this.metrics.distill.patternsDetected += params.patterns;
		this.metrics.distill.skillsGenerated += params.generated;

		this.metrics.distill.lastDistill = {
			timestamp: Date.now(),
			patterns: params.patterns,
			generated: params.generated,
		};
	}

	// ── Rollback Metrics ───────────────────────────────────────────────

	/**
	 * Record a cross-store rollback edge case: a memory whose batch
	 * lifecycle includes a move between stores (create in dest + delete
	 * in source). Batch rollback can't fully revert these because we
	 * don't cross-reference stores. The destination memory gets
	 * deleted, the source memory stays where it is — which is the
	 * correct end state for most cases (the source already had the
	 * pre-batch content), but worth telemetry so the user can audit.
	 */
	recordRollbackEdgeCase(params: { memoryId: string; store: "global" | "project"; batchId: string }): void {
		this.metrics.rollback.edgeCasesDetected++;
		this.metrics.rollback.lastEdgeCase = {
			timestamp: Date.now(),
			memoryId: params.memoryId,
			store: params.store,
			batchId: params.batchId,
		};
	}

	// ── Performance Metrics ─────────────────────────────────────────────

	recordSearchLatency(ms: number): void {
		this.metrics.performance.searchLatencyMs.push(ms);
		if (this.metrics.performance.searchLatencyMs.length > 100) {
			this.metrics.performance.searchLatencyMs.shift();
		}
	}

	recordAddLatency(ms: number): void {
		this.metrics.performance.addLatencyMs.push(ms);
		if (this.metrics.performance.addLatencyMs.length > 100) {
			this.metrics.performance.addLatencyMs.shift();
		}
	}

	// ── Getters ─────────────────────────────────────────────────────────

	getMetrics(): Metrics {
		// Deep clone so callers can mutate the result without corrupting
		// internal state. The previous `{ ...this.metrics }` only shallow-
		// copied the top level; nested objects (recall, storage, etc.) were
		// still shared by reference, so a caller mutating `metrics.recall.total`
		// would also mutate ours.
		return JSON.parse(JSON.stringify(this.metrics));
	}

	getUptime(): number {
		return Date.now() - this.startTime;
	}

	getFormattedReport(): string {
		const m = this.metrics;
		const uptime = this.getUptime();
		const uptimeStr = formatDuration(uptime);

		return [
			"Dream Memory — Observability Report",
			"====================================",
			"",
			`Uptime: ${uptimeStr}`,
			"",
			"Recall:",
			`  Total: ${m.recall.total} (success: ${m.recall.successful}, failed: ${m.recall.failed})`,
			`  Avg latency: ${m.recall.avgLatencyMs.toFixed(1)}ms`,
			`  Last: ${m.recall.lastRecall ? new Date(m.recall.lastRecall.timestamp).toISOString() : "none"}`,
			"",
			"Storage:",
			`  Memories: ${m.storage.totalMemories}`,
			`  Adds: ${m.storage.totalAdds}, Updates: ${m.storage.totalUpdates}, Deletes: ${m.storage.totalDeletes}`,
			`  Last add: ${m.storage.lastAdd ? new Date(m.storage.lastAdd.timestamp).toISOString() : "none"}`,
			"",
			"Contradictions:",
			`  Detected: ${m.contradictions.detected}`,
			`  Auto-resolved: ${m.contradictions.autoResolved}`,
			`  Kept both: ${m.contradictions.keptBoth}`,
			`  Discarded: ${m.contradictions.discarded}`,
			"",
			"Distill:",
			`  Patterns: ${m.distill.patternsDetected}, Skills: ${m.distill.skillsGenerated}`,
			`  Last distill: ${m.distill.lastDistill ? new Date(m.distill.lastDistill.timestamp).toISOString() : "none"}`,
			"",
			"Rollback:",
			`  Cross-store edge cases: ${m.rollback.edgeCasesDetected}`,
			`  Last edge case: ${m.rollback.lastEdgeCase ? `${m.rollback.lastEdgeCase.memoryId} in ${m.rollback.lastEdgeCase.store} (batch ${m.rollback.lastEdgeCase.batchId})` : "none"}`,
			"",
			"Performance (avg):",
			`  Search: ${avg(m.performance.searchLatencyMs).toFixed(1)}ms (${m.performance.searchLatencyMs.length} samples)`,
			`  Add: ${avg(m.performance.addLatencyMs).toFixed(1)}ms (${m.performance.addLatencyMs.length} samples)`,
		].join("\n");
	}
}

function avg(arr: number[]): number {
	if (arr.length === 0) return 0;
	return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		return `${hours}h ${minutes % 60}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds % 60}s`;
	}
	return `${seconds}s`;
}
