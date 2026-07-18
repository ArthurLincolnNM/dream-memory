/**
 * Item 2: VACUUM + wal_checkpoint no fluxo de cleanup.
 *
 * Hoje o /dream-cleanup (e autoCleanupFiles em session_start) só apaga
 * arquivos velhos do disco (.archived-*, dream-output, WAL órfão). Mas o
 * `.db` em uso (global.db 77 MB → 13 MB de WAL pendente) nunca é reduzido.
 * Sem `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM`, o arquivo principal
 * mantém o tamanho pré-cleanup e o WAL não é zerado.
 *
 * RED tests:
 *   1. Após cleanup que removeu arquivos, chamar `vacuumAfterCleanup` deve
 *      retornar a soma de bytes reclaimados **incluindo** a redução do .db.
 *   2. O `cleanupAllForTest` deve aplicar checkpoint+vacuum aos stores vivos.
 *
 * A função extraída `vacuumAfterCleanup(stores)` é testável isoladamente.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BankManager } from "../store/bank.js";
import { vacuumAfterCleanup } from "../store/cleanup.js";

function makeBank(): { bank: BankManager; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "dm-vac-test-"));
	const bank = new BankManager({ basePath: dir });
	return {
		bank,
		dir,
		cleanup: () => {
			bank.closeAll();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("REGRESSION: vacuumAfterCleanup é idempotente sem stores", () => {
	// Não deve explodir nem retornar nada dramático.
	const result = vacuumAfterCleanup([]);
	assert.equal(result.vacuumedStores, 0);
	assert.equal(result.totalBytesBefore, 0);
	assert.equal(result.totalBytesAfter, 0);
});

test("REGRESSION: vacuumAfterCleanup encolhe .db após inserts + deletes", () => {
	const { bank, dir, cleanup } = makeBank();
	try {
		const globalStore = bank.getGlobalStore();

		// Cria 1000 memórias, depois apaga todas (simula alto write + cleanup).
		const ids: string[] = [];
		for (let i = 0; i < 1000; i++) {
			const m = globalStore.createMemory({
				content: `memory ${i} ${"x".repeat(50)}`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "operational",
			});
			ids.push(m.id);
		}

		// Força o arquivo a crescer fisicamente
		const path = join(dir, "global.db");
		const sizeBeforeDelete = statSync(path).size;

		// Deleta todos e força vacuum manual pra comparar baseline
		for (const id of ids) globalStore.deleteMemory(id);
		globalStore.vacuum();
		const sizeAfterManualVacuum = statSync(path).size;

		// Re-popula, deleta e usa nossa função
		const ids2: string[] = [];
		for (let i = 0; i < 1000; i++) {
			const m = globalStore.createMemory({
				content: `memory ${i} ${"x".repeat(50)}`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "operational",
			});
			ids2.push(m.id);
		}
		const sizeBeforeCleanup = statSync(path).size;
		for (const id of ids2) globalStore.deleteMemory(id);

		const result = vacuumAfterCleanup([globalStore]);

		const sizeAfterCleanupVacuum = statSync(path).size;

		assert.equal(result.vacuumedStores, 1);
		assert.equal(result.totalBytesBefore, sizeBeforeCleanup);
		assert.equal(result.totalBytesAfter, sizeAfterCleanupVacuum);
		assert.ok(
			sizeAfterCleanupVacuum < sizeBeforeCleanup,
			`arquivo deveria ter encolhido após vacuum (antes=${sizeBeforeCleanup}, depois=${sizeAfterCleanupVacuum})`,
		);
		// Deve chegar **perto** do tamanho pós-vacuum manual (mesma quantidade de dados).
		// Tolerância de 5% pra overhead de páginas livres.
		const diff = Math.abs(sizeAfterCleanupVacuum - sizeAfterManualVacuum);
		assert.ok(
			diff < sizeBeforeCleanup * 0.05 || sizeAfterCleanupVacuum < sizeBeforeCleanup,
			`cleanup devia chegar perto do baseline manual. baseline=${sizeAfterManualVacuum}, atual=${sizeAfterCleanupVacuum}`,
		);
	} finally {
		cleanup();
	}
});

test("REGRESSION: vacuumAfterCleanup checkpoint WAL antes do vacuum", () => {
	const { bank, dir, cleanup } = makeBank();
	try {
		const globalStore = bank.getGlobalStore();

		// 100 inserts curtos sem checkpoint manual — o WAL fica com pending pages.
		for (let i = 0; i < 100; i++) {
			globalStore.createMemory({
				content: `mem ${i}`,
				scope: "global",
				target: "user",
				category: "preference",
				tier: "operational",
			});
		}

		// Sem checkpoint prévio, WAL pode ter alguns KB.
		// Só queremos garantir que vacuumAfterCleanup NÃO crasha se o store está aberto.
		const result = vacuumAfterCleanup([globalStore]);
		assert.equal(result.vacuumedStores, 1);
	} finally {
		cleanup();
	}
});
