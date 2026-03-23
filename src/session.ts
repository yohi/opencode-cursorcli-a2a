// src/session.ts
import { Logger } from './utils/logger.js';

export interface A2ASession {
    contextId?: string;
    taskId?: string;
    lastFinishReason?: string;
    lastModelId?: string;
    processedMessagesCount?: number;
    inputRequired?: boolean;
    rawState?: string;
}

export interface SessionStore {
    get(sessionId: string): Promise<A2ASession | undefined>;
    update(sessionId: string, patch: Partial<A2ASession>): Promise<void>;
    delete(sessionId: string): Promise<void>;
    /**
     * 指定セッションのコンテキスト（contextId / taskId / lastFinishReason）をリセットします。
     */
    resetSession(sessionId: string): Promise<void>;
    clear(): Promise<void>;
    prune?(): Promise<void>;
}

interface InMemorySessionEntry {
    session: A2ASession;
    lastAccessedAt: number;
}

export class InMemorySessionStore implements SessionStore {
    private sessions = new Map<string, InMemorySessionEntry>();
    private ttlMs: number;
    private maxEntries: number;

    constructor(options?: { ttlMs?: number; maxEntries?: number }) {
        const defaultTtlMs = 1000 * 60 * 60; // 1 hour
        const defaultMaxEntries = 1000;

        if (options?.ttlMs !== undefined) {
            if (typeof options.ttlMs !== 'number' || !Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
                throw new RangeError(`ttlMs must be a finite positive number, but got: ${options.ttlMs}`);
            }
            this.ttlMs = options.ttlMs;
        } else {
            this.ttlMs = defaultTtlMs;
        }

        if (options?.maxEntries !== undefined) {
            if (typeof options.maxEntries !== 'number' || !Number.isFinite(options.maxEntries) || options.maxEntries <= 0 || !Number.isInteger(options.maxEntries)) {
                throw new RangeError(`maxEntries must be a finite positive integer, but got: ${options.maxEntries}`);
            }
            this.maxEntries = options.maxEntries;
        } else {
            this.maxEntries = defaultMaxEntries;
        }
    }

    private isExpired(entry: InMemorySessionEntry): boolean {
        return Date.now() - entry.lastAccessedAt > this.ttlMs;
    }

    private evictIfNeeded(): void {
        if (this.sessions.size > this.maxEntries) {
            const oldestKey = this.sessions.keys().next().value;
            if (oldestKey !== undefined) {
                this.sessions.delete(oldestKey);
            }
        }
    }

    async get(sessionId: string): Promise<A2ASession | undefined> {
        const entry = this.sessions.get(sessionId);
        if (entry) {
            if (this.isExpired(entry)) {
                this.sessions.delete(sessionId);
                return undefined;
            }
            entry.lastAccessedAt = Date.now();
            this.sessions.delete(sessionId);
            this.sessions.set(sessionId, entry);
            return { ...entry.session };
        }
        return undefined;
    }

    async update(sessionId: string, patch: Partial<A2ASession>): Promise<void> {
        let entry = this.sessions.get(sessionId);

        if (entry && this.isExpired(entry)) {
            this.sessions.delete(sessionId);
            entry = undefined;
        }

        if (entry) {
            entry.session = { ...entry.session, ...patch };
            entry.lastAccessedAt = Date.now();
            this.sessions.delete(sessionId);
            this.sessions.set(sessionId, entry);
        } else {
            this.sessions.set(sessionId, {
                session: { ...patch },
                lastAccessedAt: Date.now(),
            });
            this.evictIfNeeded();
        }
    }

    async delete(sessionId: string): Promise<void> {
        this.sessions.delete(sessionId);
    }

    async resetSession(sessionId: string): Promise<void> {
        const maskedId = sessionId.length > 8
            ? `${sessionId.substring(0, 4)}...${sessionId.substring(sessionId.length - 4)}`
            : '***';
        Logger.info(`Resetting session context: ${maskedId}`);
        this.sessions.delete(sessionId);
    }

    async clear(): Promise<void> {
        this.sessions.clear();
    }

    async prune(): Promise<void> {
        const now = Date.now();
        for (const [key, entry] of this.sessions.entries()) {
            if (now - entry.lastAccessedAt > this.ttlMs) {
                this.sessions.delete(key);
            }
        }
    }
}
