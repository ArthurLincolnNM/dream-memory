/**
 * dream-memory/store/cleanup.ts
 *
 * Item 2 (anti-bloat): VACUUM + WAL checkpoint após cleanup.
 *
 * Por que existe: o `autoCleanupFiles` em `bank.ts` só apaga arquivos
 * do disco (.archived-*, dream-output, WAL órfão). Mas o .db vivo
 * (`global.db`) nunca tem seu free space reclaimado — depois de muitos
 * inserts/deletes, o arquivo principal fica gigante apesar de quase
 * vazio. O `PRAGMA wal_checkpoint(TRUNCATE)` força o WAL a flushar,
 * e o `VACUUM` reescreve o .db compactado.
 *
 * Módulo extraído (não-inline no `bank.ts`) por dois motivos:
 *   1. Testabilidade — função pura recebe lista de stores, retorna diff
 *      de bytes antes/depois. Sem I/O externo.
 *   2. Composição — o handler de /dream-cleanup e o auto-cleanup em
 *      session_start chamam a mesma função. DRY.
 */

import type { DreamStore } from "./sqlite.js";

export interface VacuumResult {
	/** Número de stores em que vacuum foi aplicado. */
	vacuumedStores: number;
	/** Soma de bytes dos .db **antes** do vacuum. */
	totalBytesBefore: number;
	/** Soma de bytes dos .db **depois** do vacuum. */
	totalBytesAfter: number;
	/** Bytes efetivamente economizados (pode ser ≤ 0 se um store cresceu — improvável). */
	bytesReclaimed: number;
	/** Erros de checkpoint/vacuum em stores específicos (best-effort). */
	errors: string[];
}

import { statSync } from "node:fs";

interface StoreWithPath{
	dbPath?: string;
	checkpoint(): void;
	vacuum(): void;
}

function resolveDbPath(store: DreamStore): string | null{
	// DreamStore expõe getDbPath() desde a refatoração do Item 2.
	// Fallback null só ocorre em mocks muito stripped (testes isolados).
	const anyStore = store as unknown as { getDbPath?: () => string };
	if (typeof anyStore.getDbPath === "function") {
		return anyStore.getDbPath();
	}
	return null;
}

function measureDbSize(store: DreamStore, dbPath: string | null): number {
	if (!dbPath) return 0;
	try {
		return statSync(dbPath).size;
	} catch {
		return 0;
	}
}

/**
 * Aplica checkpoint (TRUNCATE) + VACUUM em cada store vivo.
 *
 * - Idempotente: chamar 2× é seguro (segundo é no-op).
 * - Best-effort: falha em um store não aborta os outros.
 * - NÃO fecha o store: WAL continua ativo para o caller.
 *
 * @param stores Lista de DreamStore abertos para vacuum.
 * @returns Sumário de bytes antes/depois por store agregado.
 */
export function vacuumAfterCleanup(stores: DreamStore[]): VacuumResult {
	let totalBytesBefore = 0;
	let totalBytesAfter = 0;
	let vacuumedStores = 0;
	const errors: string[] = [];

	for (const store of stores) {
		const dbPath = resolveDbPath(store);
		const sizeBefore = measureDbSize(store, dbPath);
		totalBytesBefore += sizeBefore;

		try {
			// Checkpoint TRUNCATE primeiro: zera o WAL para que VACUUM
			// meça o espaço correto pré-cleanup.
			(store as StoreWithPath).checkpoint();
			(store as StoreWithPath).vacuum();
			vacuumedStores++;
		} catch (err: any) {
			errors.push(`${dbPath ?? "unknown"}: ${err.message}`);
			// Continua com medição mesmo em erro para o caller ter dados.
		}

		const sizeAfter = measureDbSize(store, dbPath);
		totalBytesAfter += sizeAfter;
	}

	return {
		vacuumedStores,
		totalBytesBefore,
		totalBytesAfter,
		bytesReclaimed: Math.max(0, totalBytesBefore - totalBytesAfter),
		errors,
	};
}
