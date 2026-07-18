/**
 * Item 1: Cap session_messages — 7 dias + truncate a 4KB.
 *
 * RED tests. Os defaults novos (a serem implementados) substituem:
 *   - maxAgeMs: 30 dias → 7 dias
 *   - content: full → truncado em 4000 chars com sufixo '[truncated]'.
 *
 * Esses testes devem FALHAR antes do fix (RED) e PASSAR depois (GREEN).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { indexSessions } from "../sessions/indexer.js";

function makeFixture(): { root: string; sessionsDir: string; projectDir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "dm-cap-test-"));
	const sessionsDir = join(root, "agent-sessions");
	const projectDir = join(sessionsDir, "test-project");
	mkdirSync(projectDir, { recursive: true });
	return { root, sessionsDir, projectDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeJsonl(lines: object[]): string {
	return lines.map(l => JSON.stringify(l)).join("\n");
}

function touch(path: string, mtimeMs: number): void {
	const atime = mtimeMs / 1000;
	const mtime = mtimeMs / 1000;
	utimesSync(path, atime, mtime);
}

/**
 * Cria um JSONL, escreve no project fixture, e retorna o path absoluto.
 */
function writeSessionFile(projectDir: string, name: string, lines: object[], mtimeMs?: number): string {
	const filePath = join(projectDir, `${name}.jsonl`);
	writeFileSync(filePath, makeJsonl(lines));
	if (mtimeMs !== undefined) touch(filePath, mtimeMs);
	return filePath;
}

function makeInMemoryDb(): Database.Database {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE session_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			session_id TEXT,
			message_id TEXT,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			parent_id TEXT,
			metadata TEXT,
			indexed_at INTEGER NOT NULL
		);
	`);
	return db;
}

test("REGRESSION: arquivos com mtime > 7 dias NÃO são indexados", async () => {
	const { sessionsDir, projectDir, cleanup } = makeFixture();
	try {
		// Sessão antiga: mtime simulando 10 dias atrás
		writeSessionFile(
			projectDir,
			"old_session",
			[
				{
					type: "message",
					id: "old-1",
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text: "old content" }] },
				},
			],
			Date.now() - 10 * 24 * 60 * 60 * 1000,
		);
		// Sessão recente: 1 dia atrás
		writeSessionFile(
			projectDir,
			"new_session",
			[
				{
					type: "message",
					id: "new-1",
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text: "new content" }] },
				},
			],
			Date.now() - 1 * 24 * 60 * 60 * 1000,
		);

		const db = makeInMemoryDb();
		const result = await indexSessions(db as any, { sessionsDir });

		assert.equal(
			result.filesProcessed,
			1,
			`esperado 1 arquivo processado (só o recente), obtido ${result.filesProcessed}`,
		);
		assert.equal(result.messagesIndexed, 1, "esperado 1 mensagem indexada");

		const rows = db.prepare(`SELECT message_id FROM session_messages`).all() as Array<{message_id: string}>;
		assert.equal(rows.length, 1);
		assert.equal(rows[0].message_id, "new-1", "apenas a sessão recente deve ter sido indexada");
	} finally {
		cleanup();
	}
});

test("REGRESSION: mensagens com content > 4000 chars são truncadas", async () => {
	const { sessionsDir, projectDir, cleanup } = makeFixture();
	try {
		const longText = "x".repeat(10_000); // 10KB >> 4000
		writeSessionFile(projectDir, "long_session", [
			{
				type: "message",
				id: "long-user",
				timestamp: new Date().toISOString(),
				message: { role: "user", content: [{ type: "text", text: longText }] },
			},
			{
				type: "message",
				id: "long-tool",
				timestamp: new Date().toISOString(),
				message: {
					role: "toolResult",
					content: [{ type: "text", text: longText }],
				},
			},
		]);

		const db = makeInMemoryDb();
		await indexSessions(db as any, { sessionsDir });

		const rows = db.prepare(
			`SELECT role, length(content) as len, content FROM session_messages ORDER BY id`,
		).all() as Array<{role: string; len: number; content: string}>;

		assert.equal(rows.length, 2);
		for (const row of rows) {
			assert.ok(
				row.len <= 4020,
				`role=${row.role}: content.length=${row.len} deveria estar ≤ 4020`,
			);
			if (row.len > 4000) {
				assert.ok(
					row.content.includes("[truncated]"),
					`role=${row.role}: conteúdo longo deve ter marcador '[truncated]'`,
				);
			}
		}
	} finally {
		cleanup();
	}
});
