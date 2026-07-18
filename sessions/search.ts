/**
 * dream-memory/sessions/search.ts
 *
 * Search across indexed session messages using FTS5.
 * Returns matching user/assistant messages with snippets and metadata.
 */

export interface SessionSearchResult {
	sessionId: string;
	role: string;
	content: string;
	timestamp: number;
	snippet: string;
	score: number;
	filePath: string;
}

/**
 * Search session messages via FTS5.
 *
 * @param db - better-sqlite3 database instance
 * @param query - FTS5 search query (supports AND, OR, phrases)
 * @param options - filters and limits
 */
export function searchSessionMessages(
	db: any,
	query: string,
	options?: { topK?: number; role?: string; since?: number; sessionId?: string },
): SessionSearchResult[] {
	const topK = options?.topK ?? 10;

	// Build query with optional filters
	let sql = `
		SELECT
			sm.session_id, sm.role, sm.content, sm.timestamp, sm.session_file,
			snippet(session_messages_fts, 0, '>>>', '<<<', '...', 40) as snippet,
			rank
		FROM session_messages_fts
		JOIN session_messages sm ON sm.id = session_messages_fts.rowid
		WHERE session_messages_fts MATCH ?
	`;
	const params: any[] = [query];

	if (options?.role) {
		sql += ` AND sm.role = ?`;
		params.push(options.role);
	}
	if (options?.since) {
		sql += ` AND sm.timestamp >= ?`;
		params.push(options.since);
	}
	if (options?.sessionId) {
		sql += ` AND sm.session_id = ?`;
		params.push(options.sessionId);
	}

	sql += ` ORDER BY rank LIMIT ?`;
	params.push(topK);

	try {
		const rows = db.prepare(sql).all(...params) as any[];
		return rows.map(r => ({
			sessionId: r.session_id,
			role: r.role,
			content: r.content,
			timestamp: r.timestamp,
			snippet: r.snippet,
			score: -r.rank, // FTS5 rank is negative (lower = better)
			filePath: r.session_file,
		}));
	} catch {
		// FTS5 query syntax error or table doesn't exist yet
		return [];
	}
}

/**
 * Get statistics about indexed sessions.
 */
export function getSessionIndexStats(db: any): {
	totalMessages: number;
	totalSessions: number;
	indexedFiles: number;
} {
	try {
		const total = db.prepare("SELECT COUNT(*) as cnt FROM session_messages").get() as any;
		const sessions = db.prepare("SELECT COUNT(DISTINCT session_id) as cnt FROM session_messages").get() as any;
		const files = db.prepare("SELECT COUNT(DISTINCT session_file) as cnt FROM session_messages").get() as any;
		return {
			totalMessages: total?.cnt ?? 0,
			totalSessions: sessions?.cnt ?? 0,
			indexedFiles: files?.cnt ?? 0,
		};
	} catch {
		return { totalMessages: 0, totalSessions: 0, indexedFiles: 0 };
	}
}
