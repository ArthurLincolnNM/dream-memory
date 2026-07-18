/**
 * dream-memory/sessions/indexer.ts
 *
 * Parse Pi JSONL session files and index into session_messages + FTS5.
 * Incremental — skips already-indexed files via file path dedup.
 *
 * Pi stores sessions as JSONL files at:
 *   ~/.pi/agent/sessions/<project-dir>/<timestamp>_<uuid>.jsonl
 *
 * Each line is a JSON object with a `type` field. We index `message` types
 * (user/assistant/toolResult) and extract readable text content.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, basename } from "path";

/**
 * Item 1 (anti-bloat): defaults cortados de 30 → 7 dias.
 * Justificativa: em sessões intensas (vibecoding), 30 dias de JSONL renderam
 * DBs de 30 GB porque todo `web_fetch` / `read` ia inteiro pro FTS5.
 * 7 dias é suficiente pra recall de "o que discutimos essa semana" sem inchar.
 */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Item 1 (anti-bloat): cap de 4000 chars por mensagem.
 * Web fetches e toolResults podem ser dezenas de KB; indexar tudo é overkill.
 * Truncamento com sufixo explícito permite que o recall mostre que a versão
 * completa existe no JSONL original (que ainda está acessível pelo session_file).
 */
const MAX_MESSAGE_LENGTH = 4000;

const SESSIONS_DIR = join(process.env.HOME ?? "", ".pi", "agent", "sessions");

interface JsonlMessage {
	type: string;
	id?: string;
	parentId?: string;
	timestamp?: string;
	message?: {
		role: string;
		content?: Array<{ type: string; text?: string; name?: string; arguments?: any }>;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
}

export interface IndexResult {
	filesProcessed: number;
	messagesIndexed: number;
	errors: string[];
}

/**
 * Discover all session JSONL files across project directories.
 */
export async function discoverSessionFiles(sessionsDir?: string): Promise<string[]> {
	const dir = sessionsDir ?? join(process.env.HOME ?? "", ".pi", "agent", "sessions");
	const files: string[] = [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dirPath = join(dir, entry.name);
			try {
				const jsonlFiles = await readdir(dirPath);
				for (const f of jsonlFiles) {
					if (f.endsWith(".jsonl")) {
						files.push(join(dirPath, f));
					}
				}
			} catch {
				// skip unreadable directories
			}
		}
	} catch {
		// sessions dir doesn't exist
	}
	return files;
}

/**
 * Parse a single JSONL session file into structured messages.
 */
export function parseJsonlSession(content: string): JsonlMessage[] {
	const lines = content.split("\n").filter(l => l.trim());
	const messages: JsonlMessage[] = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === "message" && parsed.message?.role) {
				messages.push(parsed);
			}
		} catch {
			// skip malformed lines
		}
	}
	return messages;
}

/**
 * Extract readable text from message content array.
 */
export function extractMessageText(content: any[]): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n");
}

/**
 * Item 1 (anti-bloat): trunca texto para MAX_MESSAGE_LENGTH com marcador
 * explícito. Recall ainda consegue indexar; o session_file aponta pra versão
 * completa caso o agente precise.
 */
export function truncateMessageText(text: string): string {
	if (text.length <= MAX_MESSAGE_LENGTH) return text;
	return text.slice(0, MAX_MESSAGE_LENGTH) + "\n...[truncated]";
}

/**
 * Extract metadata from assistant messages (tool calls, model, usage).
 */
export function extractMessageMetadata(msg: JsonlMessage): Record<string, any> {
	const meta: Record<string, any> = {};
	if (msg.message?.role === "assistant") {
		const content = msg.message.content ?? [];
		const toolCalls = content
			.filter((c: any) => c.type === "toolCall")
			.map((c: any) => ({ name: c.name, id: c.id }));
		if (toolCalls.length > 0) meta.toolCalls = toolCalls;
	}
	return meta;
}

/**
 * Index all new session files into the database.
 * Skips files that have already been indexed (tracked via session_file column).
 *
 * Uses the underlying better-sqlite3 db directly for batch inserts.
 *
 * Item 1 (anti-bloat): dois caps rígidos.
 *   - maxAgeMs default: 7 dias (era 30). 30 dias renderam 30GB de WAL em uso
 *     intenso. 7 dias preserva recall útil ("essa semana") sem inflar disco.
 *   - MAX_MESSAGE_LENGTH (4000): toolResults grandes são truncados com
 *     sufixo '[truncated]'. Recall ainda funciona; sessão original tem o full.
 *
 * Item 1: aceita `sessionsDir` opcional para permitir testes isolados
 * sem varrer o diretório real do usuário.
 *
 * @param db  The SQLite database instance (better-sqlite3)
 * @param options.maxAgeMs  Only index files modified within this window. Default 7 days.
 * @param options.sessionsDir  Override session discovery root (for tests).
 */
export async function indexSessions(
	db: any,
	options: { maxAgeMs?: number; sessionsDir?: string } = {},
): Promise<IndexResult> {
	const result: IndexResult = { filesProcessed: 0, messagesIndexed: 0, errors: [] };
	const allFiles = await discoverSessionFiles(options.sessionsDir);

	// Filter by age: skip files older than maxAgeMs to prevent DB bloat.
	// During intensive sessions (vibecoding), JSONL files can be several MB each.
	// Indexing thousands of old files on every session_start caused 30GB+ growth.
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const now = Date.now();
	const files: string[] = [];
	for (const f of allFiles) {
		try {
			const s = await stat(f);
			if (now - s.mtimeMs < maxAgeMs) {
				files.push(f);
			}
		} catch {
			// file vanished between readdir and stat — skip
		}
	}

	// Get already-indexed files
	const indexedRows = db.prepare(
		"SELECT DISTINCT session_file FROM session_messages"
	).all() as Array<{ session_file: string }>;
	const indexedFiles = new Set(indexedRows.map(r => r.session_file));

	const insert = db.prepare(`
		INSERT INTO session_messages
		(session_file, session_id, message_id, role, content, timestamp, parent_id, metadata, indexed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	for (const filePath of files) {
		if (indexedFiles.has(filePath)) continue;

		try {
			const content = await readFile(filePath, "utf-8");
			const messages = parseJsonlSession(content);

			// Extract session ID from filename (uuid part after last underscore)
			const fname = basename(filePath, ".jsonl");
			const uuidPart = fname.split("_").pop() ?? fname;
			const sessionId = uuidPart;

			const tx = db.transaction(() => {
				for (const msg of messages) {
					const role = msg.message!.role;
					const text = truncateMessageText(extractMessageText(msg.message?.content ?? []));
					if (!text.trim()) continue;

					const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : now;
					const meta = extractMessageMetadata(msg);

					insert.run(
						filePath,
						sessionId,
						msg.id ?? null,
						role,
						text,
						ts,
						msg.parentId ?? null,
						Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
						now,
					);
					result.messagesIndexed++;
				}
			});
			tx();
			result.filesProcessed++;
		} catch (err: any) {
			result.errors.push(`${filePath}: ${err.message}`);
		}
	}

	return result;
}
