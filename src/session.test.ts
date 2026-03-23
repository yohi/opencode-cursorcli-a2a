// src/session.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemorySessionStore } from './session';

describe('InMemorySessionStore', () => {
    let store: InMemorySessionStore;

    beforeEach(() => {
        store = new InMemorySessionStore({ ttlMs: 1000, maxEntries: 5 });
    });

    it('should return undefined for a non-existent session', async () => {
        const result = await store.get('non-existent');
        expect(result).toBeUndefined();
    });

    it('should create and retrieve a session', async () => {
        await store.update('session-1', { contextId: 'ctx-abc', taskId: 'task-xyz' });
        const session = await store.get('session-1');
        expect(session).toEqual({ contextId: 'ctx-abc', taskId: 'task-xyz' });
    });

    it('should update an existing session', async () => {
        await store.update('session-1', { contextId: 'ctx-abc' });
        await store.update('session-1', { taskId: 'task-xyz' });
        const session = await store.get('session-1');
        expect(session).toEqual({ contextId: 'ctx-abc', taskId: 'task-xyz' });
    });

    it('should delete a session', async () => {
        await store.update('session-1', { contextId: 'ctx-abc' });
        await store.delete('session-1');
        const session = await store.get('session-1');
        expect(session).toBeUndefined();
    });

    it('should reset a session by clearing its data', async () => {
        await store.update('session-1', { contextId: 'ctx-abc', taskId: 'task-xyz' });
        await store.resetSession('session-1');
        const session = await store.get('session-1');
        expect(session).toBeUndefined();
    });

    it('should clear all sessions', async () => {
        await store.update('session-1', { contextId: 'ctx-abc' });
        await store.update('session-2', { contextId: 'ctx-def' });
        await store.clear();
        expect(await store.get('session-1')).toBeUndefined();
        expect(await store.get('session-2')).toBeUndefined();
    });

    it('should expire sessions after TTL', async () => {
        const shortTtlStore = new InMemorySessionStore({ ttlMs: 1 });
        await shortTtlStore.update('session-1', { contextId: 'ctx-abc' });
        await new Promise(r => setTimeout(r, 10));
        const session = await shortTtlStore.get('session-1');
        expect(session).toBeUndefined();
    });

    it('should evict oldest entry when maxEntries is exceeded', async () => {
        for (let i = 0; i < 5; i++) {
            await store.update(`session-${i}`, { contextId: `ctx-${i}` });
            await new Promise(r => setTimeout(r, 1));
        }
        await store.update('session-5', { contextId: 'ctx-5' });
        expect(await store.get('session-0')).toBeUndefined();
    });

    it('should return a copy not a reference', async () => {
        await store.update('s1', { contextId: 'original' });
        const session = await store.get('s1');
        if (session) session.contextId = 'mutated';
        const session2 = await store.get('s1');
        expect(session2?.contextId).toBe('original');
    });

    it('should prune expired sessions', async () => {
        const store2 = new InMemorySessionStore({ ttlMs: 1 });
        await store2.update('s1', { contextId: 'x' });
        await new Promise(r => setTimeout(r, 10));
        await store2.update('s2', { contextId: 'y' });
        await store2.prune!();
        expect(await store2.get('s1')).toBeUndefined();
        expect(await store2.get('s2')).toBeDefined();
    });

    it('should throw RangeError for invalid ttlMs', () => {
        expect(() => new InMemorySessionStore({ ttlMs: -1 })).toThrow(RangeError);
        expect(() => new InMemorySessionStore({ ttlMs: 0 })).toThrow(RangeError);
        expect(() => new InMemorySessionStore({ ttlMs: Infinity })).toThrow(RangeError);
    });

    it('should throw RangeError for invalid maxEntries', () => {
        expect(() => new InMemorySessionStore({ maxEntries: -1 })).toThrow(RangeError);
        expect(() => new InMemorySessionStore({ maxEntries: 0 })).toThrow(RangeError);
        expect(() => new InMemorySessionStore({ maxEntries: 1.5 })).toThrow(RangeError);
    });
});
