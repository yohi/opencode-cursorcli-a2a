// src/server/a2a-routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { createA2ARouter } from './a2a-routes.js';
import { TaskStore } from './task-store.js';
import type { CursorAgentEvent } from './cursor-agent-service.js';

// express supertest-like helper
async function makeRequest(app: express.Express, method: string, path: string, body?: unknown) {
    return new Promise<{ status: number; body: unknown; headers: Record<string, string> }>((resolve, reject) => {
        const server = app.listen(0, () => {
            const addr = server.address() as { port: number };
            const url = `http://127.0.0.1:${addr.port}${path}`;
            const opts: RequestInit = {
                method,
                headers: { 'Content-Type': 'application/json' },
            };
            if (body) opts.body = JSON.stringify(body);
            fetch(url, opts)
                .then(async (res) => {
                    const contentType = res.headers.get('content-type') || '';
                    const responseBody = contentType.includes('json') ? await res.json() : await res.text();
                    resolve({
                        status: res.status,
                        body: responseBody,
                        headers: Object.fromEntries(res.headers.entries()),
                    });
                })
                .catch(reject)
                .finally(() => {
                    server.close();
                });
        });
        server.on('error', reject);
    });
}

describe('A2A Routes', () => {
    let app: express.Express;

    beforeEach(() => {
        app = express();
        app.use(express.json());
        const taskStore = new TaskStore();
        const router = createA2ARouter({
            taskStore,
            executeAgent: vi.fn(async (_msg: string, _opts: { workspace?: string; sessionId?: string; model?: string; signal?: AbortSignal }, onEvent: (event: CursorAgentEvent) => void) => {
                onEvent({ type: 'message', content: 'Hello', timestamp: Date.now() });
                return { sessionId: 'sess-1' };
            }),
        });
        app.use(router);
    });

    it('GET /.well-known/agent-card.json should return a valid agent card', async () => {
        const res = await makeRequest(app, 'GET', '/.well-known/agent-card.json');
        expect(res.status).toBe(200);
        const body = res.body as { name: string; capabilities: { streaming: boolean } };
        expect(body.name).toBe('Cursor Agent (A2A)');
        expect(body.capabilities.streaming).toBe(true);
    });

    it('POST /message:send should return a task', async () => {
        const res = await makeRequest(app, 'POST', '/message:send', {
            message: {
                role: 'ROLE_USER',
                parts: [{ text: 'Hello' }],
                messageId: 'msg-1',
            },
        });
        expect(res.status).toBe(200);
        const body = res.body as { task: { id: string; status: { state: string } } };
        expect(body.task).toBeDefined();
        expect(body.task.id).toBeDefined();
        expect(body.task.status.state).toBe('TASK_STATE_COMPLETED');
    });

    it('POST /message:send should reject invalid request', async () => {
        const res = await makeRequest(app, 'POST', '/message:send', {
            message: { invalid: true },
        });
        expect(res.status).toBe(400);
    });

    it('POST /message:stream should return a valid SSE stream', async () => {
        const res = await makeRequest(app, 'POST', '/message:stream', {
            message: {
                role: 'ROLE_USER',
                parts: [{ text: 'Hello stream' }],
                messageId: 'msg-stream-1',
            },
        });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.body).toContain('data: {');
        expect(res.body).toContain('TASK_STATE_WORKING');
        expect(res.body).toContain('TASK_STATE_COMPLETED');
    });

    it('GET /tasks/:id should return a task', async () => {
        // First create a task
        const createRes = await makeRequest(app, 'POST', '/message:send', {
            message: {
                role: 'ROLE_USER',
                parts: [{ text: 'Hello' }],
                messageId: 'msg-2',
            },
        });
        const taskId = (createRes.body as { task: { id: string } }).task.id;

        const res = await makeRequest(app, 'GET', `/tasks/${taskId}`);
        expect(res.status).toBe(200);
        const body = res.body as { task: { id: string } };
        expect(body.task.id).toBe(taskId);
    });

    it('GET /tasks/:id should return 404 for unknown task', async () => {
        const res = await makeRequest(app, 'GET', '/tasks/nonexistent');
        expect(res.status).toBe(404);
    });
});
