// src/server/task-store.ts
import crypto from 'node:crypto';
import type { A2ATask, A2AArtifact } from './a2a-types.js';
import { A2A_TASK_STATES } from './a2a-types.js';

type TaskState = typeof A2A_TASK_STATES[number];

export interface TaskStoreOptions {
    ttlMs?: number;
    cleanupIntervalMs?: number;
}

export class TaskStore {
    private tasks = new Map<string, { task: A2ATask, expiresAt: number }>();
    private sessions = new Map<string, string>(); // contextId -> sessionId
    private timer?: NodeJS.Timeout;
    private ttlMs: number;

    constructor(options: TaskStoreOptions = {}) {
        this.ttlMs = options.ttlMs || 60 * 60 * 1000; // default 1 hour
        const interval = options.cleanupIntervalMs || 5 * 60 * 1000;
        
        // Start periodic cleanup 
        if (typeof setInterval !== 'undefined') {
            this.timer = setInterval(() => this.cleanup(), interval);
            // Don't block Node exit
            if (this.timer.unref) this.timer.unref();
        }
    }

    destroy(): void {
        if (this.timer) clearInterval(this.timer);
    }

    private cleanup(): void {
        const now = Date.now();
        for (const [id, entry] of this.tasks.entries()) {
            if (now > entry.expiresAt) {
                this.tasks.delete(id);
            }
        }
    }

    getSessionId(contextId: string): string | undefined {
        return this.sessions.get(contextId);
    }

    setSessionId(contextId: string, sessionId: string): void {
        this.sessions.set(contextId, sessionId);
    }

    create(contextId: string, metadata?: Record<string, unknown>): A2ATask {
        const task: A2ATask = {
            id: `task-${crypto.randomUUID()}`,
            contextId,
            status: {
                state: 'TASK_STATE_SUBMITTED',
                timestamp: new Date().toISOString(),
            },
            artifacts: [],
            metadata,
        };
        this.tasks.set(task.id, { task, expiresAt: Date.now() + this.ttlMs });
        return structuredClone(task);
    }

    get(taskId: string): A2ATask | undefined {
        const entry = this.tasks.get(taskId);
        if (!entry || Date.now() > entry.expiresAt) {
            if (entry) this.tasks.delete(taskId);
            return undefined;
        }
        return structuredClone(entry.task);
    }

    updateStatus(taskId: string, state: TaskState, message?: string): A2ATask | undefined {
        const entry = this.tasks.get(taskId);
        if (!entry) return undefined;
        const task = entry.task;
        task.status = {
            state,
            timestamp: new Date().toISOString(),
            ...(message ? { message: { role: 'ROLE_AGENT' as const, parts: [{ text: message }] } } : {}),
        };
        return structuredClone(task);
    }

    addArtifact(taskId: string, artifact: A2AArtifact): A2ATask | undefined {
        const entry = this.tasks.get(taskId);
        if (!entry) return undefined;
        const task = entry.task;
        if (!task.artifacts) task.artifacts = [];
        task.artifacts.push(artifact);
        return structuredClone(task);
    }

    appendArtifactText(taskId: string, artifactId: string, text: string): A2ATask | undefined {
        const entry = this.tasks.get(taskId);
        if (!entry?.task?.artifacts) return undefined;
        const task = entry.task;
        const artifact = task.artifacts!.find((a) => a.artifactId === artifactId);
        if (!artifact || artifact.parts.length === 0) return undefined;
        const lastPart = artifact.parts[artifact.parts.length - 1];
        if (lastPart.text !== undefined) {
            lastPart.text += text;
        }
        return structuredClone(task);
    }

    listByContext(contextId: string): A2ATask[] {
        const result: A2ATask[] = [];
        const now = Date.now();
        for (const [id, entry] of this.tasks.entries()) {
            if (now > entry.expiresAt) {
                this.tasks.delete(id);
                continue;
            }
            if (entry.task.contextId === contextId) {
                result.push(structuredClone(entry.task));
            }
        }
        return result;
    }
}
