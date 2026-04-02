// src/server/task-store.ts
import crypto from 'node:crypto';
import type { A2ATask, A2AArtifact } from './a2a-types.js';
import { A2A_TASK_STATES } from './a2a-types.js';

type TaskState = typeof A2A_TASK_STATES[number];

export class TaskStore {
    private tasks = new Map<string, A2ATask>();

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
        this.tasks.set(task.id, task);
        return structuredClone(task);
    }

    get(taskId: string): A2ATask | undefined {
        const task = this.tasks.get(taskId);
        return task ? structuredClone(task) : undefined;
    }

    updateStatus(taskId: string, state: TaskState, message?: string): A2ATask | undefined {
        const task = this.tasks.get(taskId);
        if (!task) return undefined;
        task.status = {
            state,
            timestamp: new Date().toISOString(),
            ...(message ? { message: { role: 'ROLE_AGENT' as const, parts: [{ text: message }] } } : {}),
        };
        return structuredClone(task);
    }

    addArtifact(taskId: string, artifact: A2AArtifact): void {
        const task = this.tasks.get(taskId);
        if (!task) return;
        if (!task.artifacts) task.artifacts = [];
        task.artifacts.push(artifact);
    }

    appendArtifactText(taskId: string, artifactId: string, text: string): void {
        const task = this.tasks.get(taskId);
        if (!task?.artifacts) return;
        const artifact = task.artifacts.find((a) => a.artifactId === artifactId);
        if (!artifact || artifact.parts.length === 0) return;
        const lastPart = artifact.parts[artifact.parts.length - 1];
        if (lastPart.text !== undefined) {
            lastPart.text += text;
        }
    }

    listByContext(contextId: string): A2ATask[] {
        const result: A2ATask[] = [];
        for (const task of this.tasks.values()) {
            if (task.contextId === contextId) {
                result.push(structuredClone(task));
            }
        }
        return result;
    }
}
