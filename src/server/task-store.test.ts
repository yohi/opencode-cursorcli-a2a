// src/server/task-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStore } from './task-store.js';

describe('TaskStore', () => {
    let store: TaskStore;

    beforeEach(() => {
        store = new TaskStore();
    });

    it('should create a new task', () => {
        const task = store.create('ctx-1');
        expect(task.id).toBeDefined();
        expect(task.contextId).toBe('ctx-1');
        expect(task.status.state).toBe('TASK_STATE_SUBMITTED');
    });

    it('should get an existing task', () => {
        const created = store.create('ctx-1');
        const got = store.get(created.id);
        expect(got).toEqual(created);
    });

    it('should return undefined for non-existent task', () => {
        expect(store.get('nonexistent')).toBeUndefined();
    });

    it('should update task status', () => {
        const task = store.create('ctx-1');
        store.updateStatus(task.id, 'TASK_STATE_WORKING');
        const updated = store.get(task.id);
        expect(updated?.status.state).toBe('TASK_STATE_WORKING');
    });

    it('should add artifact to task', () => {
        const task = store.create('ctx-1');
        store.addArtifact(task.id, {
            artifactId: 'art-1',
            parts: [{ text: 'hello' }],
        });
        const updated = store.get(task.id);
        expect(updated?.artifacts).toHaveLength(1);
        expect(updated?.artifacts?.[0].artifactId).toBe('art-1');
    });

    it('should append text to existing artifact', () => {
        const task = store.create('ctx-1');
        store.addArtifact(task.id, {
            artifactId: 'art-1',
            parts: [{ text: 'hello' }],
        });
        store.appendArtifactText(task.id, 'art-1', ' world');
        const updated = store.get(task.id);
        const art = updated?.artifacts?.find(a => a.artifactId === 'art-1');
        expect(art?.parts[0].text).toBe('hello world');
    });

    it('should complete a task', () => {
        const task = store.create('ctx-1');
        store.updateStatus(task.id, 'TASK_STATE_WORKING');
        store.updateStatus(task.id, 'TASK_STATE_COMPLETED');
        const updated = store.get(task.id);
        expect(updated?.status.state).toBe('TASK_STATE_COMPLETED');
        expect(updated?.status.timestamp).toBeDefined();
    });

    it('should list tasks by contextId', () => {
        store.create('ctx-1');
        store.create('ctx-1');
        store.create('ctx-2');
        expect(store.listByContext('ctx-1')).toHaveLength(2);
        expect(store.listByContext('ctx-2')).toHaveLength(1);
    });
});
