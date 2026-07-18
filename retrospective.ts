/**
 * dream-memory/retrospective.ts
 * Memory Retrospective — re-reads past conversations to capture missed memories.
 *
 * Inspired by Vellum's memory-retrospective-job. Reads session_messages from
 * the DB, finds messages not yet processed, and extracts durable facts via
 * an LLM callback.
 */

import type { DreamStore } from "./store/sqlite.js";

export interface RetrospectiveConfig {
    /** Max messages to process per run */
    maxMessages: number;
    /** Min messages between runs */
    minMessagesThreshold: number;
    /** Cooldown between runs (ms) */
    cooldownMs: number;
}

const DEFAULT_CONFIG: RetrospectiveConfig = {
    maxMessages: 50,
    minMessagesThreshold: 10,
    cooldownMs: 5 * 60 * 1000, // 5 minutes
};

export interface RetrospectiveResult {
    messagesProcessed: number;
    memoriesExtracted: number;
    memoryIds: string[];
}

/**
 * Run a retrospective pass over unprocessed session messages.
 *
 * @param store - DreamStore instance
 * @param processFn - Callback that receives message content and returns extracted memories
 * @param config - Optional configuration overrides
 */
export async function runRetrospective(
    store: DreamStore,
    processFn: (messages: Array<{ role: string; content: string; timestamp: number }>) => Promise<Array<{ content: string; target?: string; category?: string; trust_level?: number }>>,
    config: Partial<RetrospectiveConfig> = {},
): Promise<RetrospectiveResult> {
    const opts = { ...DEFAULT_CONFIG, ...config };
    const now = Date.now();

    // Check cooldown
    const lastRun = store.getStat("retrospective_last_run_at");
    if (lastRun && now - Number(lastRun) < opts.cooldownMs) {
        return { messagesProcessed: 0, memoriesExtracted: 0, memoryIds: [] };
    }

    // Get last processed message ID
    const lastProcessedId = store.getStat("retrospective_last_message_id");
    const lastProcessedIdNum = lastProcessedId ? Number(lastProcessedId) : 0;

    // Fetch unprocessed messages
    const messages = store.getUnprocessedMessages(lastProcessedIdNum, opts.maxMessages);

    if (messages.length < opts.minMessagesThreshold) {
        return { messagesProcessed: 0, memoriesExtracted: 0, memoryIds: [] };
    }

    // Call processFn to extract memories
    const extracted = await processFn(
        messages.map(m => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
        }))
    );

    // Save extracted memories
    const memoryIds: string[] = [];
    for (const item of extracted) {
        const mem = store.createMemory({
            content: item.content,
            scope: "global",
            target: (item.target as any) || "user",
            category: (item.category as any) || "insight",
            tier: "operational",
            confidence: "inferred",
            trust_level: item.trust_level ?? 1,
            memory_kind: "episodic",
            metadata: { source: "retrospective", processedAt: now },
        });
        memoryIds.push(mem.id);
    }

    // Update tracking
    const lastMsgId = messages[messages.length - 1].id;
    store.setStat("retrospective_last_run_at", String(now));
    store.setStat("retrospective_last_message_id", String(lastMsgId));

    return {
        messagesProcessed: messages.length,
        memoriesExtracted: extracted.length,
        memoryIds,
    };
}
