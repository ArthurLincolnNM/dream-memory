/**
 * Tests for observability edge-case tracking on batch rollback.
 *
 * Background: when a batch contains a cross-store move, the rollback
 * processes each store independently. The destination-side "create" is
 * deleted, the source-side "delete" is restored. The end state is
 * correct, but the system has no way to surface that this happened.
 *
 * Phase 1 audit fix: recordRollbackEdgeCase increments a counter and
 * stores the last edge case. getFormattedReport surfaces both, and the
 * batch rollback tool's response includes a summary line when edge
 * cases are detected.
 *
 * This test covers the observability method directly. End-to-end
 * batch-rollback behavior is exercised by manual smoke tests in the
 * integration phase (the rollback logic is inline in index.ts and
 * requires a pi ExtensionAPI instance to drive the full tool path).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Observability } from "../utils/observability.js";

test("recordRollbackEdgeCase increments the counter", () => {
	const obs = new Observability();
	assert.equal(obs.getMetrics().rollback.edgeCasesDetected, 0);
	obs.recordRollbackEdgeCase({ memoryId: "m1", store: "global", batchId: "b1" });
	assert.equal(obs.getMetrics().rollback.edgeCasesDetected, 1);
	obs.recordRollbackEdgeCase({ memoryId: "m2", store: "project", batchId: "b1" });
	assert.equal(obs.getMetrics().rollback.edgeCasesDetected, 2);
});

test("recordRollbackEdgeCase records the last case", () => {
	const obs = new Observability();
	obs.recordRollbackEdgeCase({ memoryId: "m1", store: "global", batchId: "b1" });
	obs.recordRollbackEdgeCase({ memoryId: "m2", store: "project", batchId: "b2" });
	const last = obs.getMetrics().rollback.lastEdgeCase;
	assert.ok(last);
	assert.equal(last!.memoryId, "m2");
	assert.equal(last!.store, "project");
	assert.equal(last!.batchId, "b2");
	assert.ok(last!.timestamp > 0);
});

test("getFormattedReport includes the Rollback section", () => {
	const obs = new Observability();
	obs.recordRollbackEdgeCase({ memoryId: "m1", store: "global", batchId: "b1" });
	const report = obs.getFormattedReport();
	assert.ok(report.includes("Rollback:"), "report should include Rollback section header");
	assert.ok(
		report.includes("Cross-store edge cases: 1"),
		"report should show the edge case count",
	);
	assert.ok(report.includes("m1"), "report should reference the last edge case memory id");
	assert.ok(report.includes("global"), "report should show the store name");
});
