# A2A v1.0.0 準拠レイヤー Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 既存の opencode-cursorcli-a2a サーバーに A2A Protocol v1.0.0 (HTTP+JSON/REST binding) 準拠のエンドポイントを追加し、既存のjeffkit互換APIと共存させる。

**Architecture:** 既存の `cursor-agent-service.ts` (CLI ラッパー) と Express サーバーはそのまま維持し、A2A準拠のルートハンドラを追加する。リクエスト/レスポンス変換アダプタで A2A ↔ 内部形式をブリッジする。TaskStore で A2A のタスクライフサイクルを管理する。

**Tech Stack:** TypeScript, Express, Zod, vitest

**対象ディレクトリ:** `/home/y_ohi/program/private/opencode-cursorcli-a2a`

**既存テスト:** 9ファイル 98テスト 全パス (vitest)

---

## Task 1: A2A データモデル型定義

**Files:**
- Create: `src/server/a2a-types.ts`
- Test: `src/server/a2a-types.test.ts`

**Step 1: Write the failing test**

```typescript
// src/server/a2a-types.test.ts
import { describe, it, expect } from 'vitest';
import {
    A2AMessageSchema,
    A2APartSchema,
    A2ASendMessageRequestSchema,
    A2ATaskSchema,
    A2AStreamResponseSchema,
    A2ATaskStatusUpdateEventSchema,
    A2AArtifactUpdateEventSchema,
    A2AAgentCardSchema,
} from './a2a-types.js';

describe('A2A Types', () => {
    describe('A2APartSchema', () => {
        it('should validate a text part', () => {
            const part = { text: 'Hello world' };
            expect(A2APartSchema.parse(part)).toEqual(part);
        });

        it('should reject empty object', () => {
            expect(() => A2APartSchema.parse({})).toThrow();
        });
    });

    describe('A2AMessageSchema', () => {
        it('should validate a user message with text parts', () => {
            const msg = {
                role: 'ROLE_USER',
                parts: [{ text: 'Hello' }],
                messageId: 'msg-1',
            };
            expect(A2AMessageSchema.parse(msg)).toMatchObject(msg);
        });

        it('should reject message without role', () => {
            expect(() => A2AMessageSchema.parse({
                parts: [{ text: 'Hello' }],
            })).toThrow();
        });
    });

    describe('A2ASendMessageRequestSchema', () => {
        it('should validate a minimal send message request', () => {
            const req = {
                message: {
                    role: 'ROLE_USER',
                    parts: [{ text: 'Hello' }],
                    messageId: 'msg-1',
                },
            };
            const result = A2ASendMessageRequestSchema.parse(req);
            expect(result.message.role).toBe('ROLE_USER');
        });

        it('should accept optional configuration and metadata', () => {
            const req = {
                message: {
                    role: 'ROLE_USER',
                    parts: [{ text: 'Hello' }],
                    messageId: 'msg-1',
                },
                configuration: {
                    acceptedOutputModes: ['text/plain'],
                },
                metadata: {
                    model: 'claude-4.6-sonnet-medium',
                },
            };
            const result = A2ASendMessageRequestSchema.parse(req);
            expect(result.metadata?.model).toBe('claude-4.6-sonnet-medium');
        });
    });

    describe('A2ATaskSchema', () => {
        it('should validate a working task', () => {
            const task = {
                id: 'task-1',
                contextId: 'ctx-1',
                status: { state: 'TASK_STATE_WORKING' },
            };
            expect(A2ATaskSchema.parse(task)).toMatchObject(task);
        });

        it('should validate a completed task with artifacts', () => {
            const task = {
                id: 'task-1',
                contextId: 'ctx-1',
                status: {
                    state: 'TASK_STATE_COMPLETED',
                    timestamp: '2026-04-02T03:00:00.000Z',
                },
                artifacts: [{
                    artifactId: 'art-1',
                    parts: [{ text: 'result' }],
                }],
            };
            expect(A2ATaskSchema.parse(task)).toMatchObject(task);
        });
    });

    describe('A2AStreamResponseSchema', () => {
        it('should validate a task response', () => {
            const resp = {
                task: {
                    id: 'task-1',
                    contextId: 'ctx-1',
                    status: { state: 'TASK_STATE_WORKING' },
                },
            };
            expect(A2AStreamResponseSchema.parse(resp)).toMatchObject(resp);
        });

        it('should validate an artifact update response', () => {
            const resp = {
                artifactUpdate: {
                    taskId: 'task-1',
                    artifact: {
                        artifactId: 'art-1',
                        parts: [{ text: 'chunk' }],
                    },
                },
            };
            expect(A2AStreamResponseSchema.parse(resp)).toMatchObject(resp);
        });

        it('should validate a status update response', () => {
            const resp = {
                statusUpdate: {
                    taskId: 'task-1',
                    status: {
                        state: 'TASK_STATE_COMPLETED',
                        timestamp: '2026-04-02T03:00:00.000Z',
                    },
                },
            };
            expect(A2AStreamResponseSchema.parse(resp)).toMatchObject(resp);
        });
    });

    describe('A2AAgentCardSchema', () => {
        it('should validate a minimal agent card', () => {
            const card = {
                name: 'Test Agent',
                description: 'Test',
                supportedInterfaces: [{
                    url: 'http://localhost:4937',
                    protocolBinding: 'HTTP+JSON',
                    protocolVersion: '1.0',
                }],
                capabilities: { streaming: true },
                defaultInputModes: ['text/plain'],
                defaultOutputModes: ['text/plain'],
                skills: [],
            };
            expect(A2AAgentCardSchema.parse(card)).toMatchObject(card);
        });
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/a2a-types.test.ts --reporter=verbose`
Expected: FAIL (module not found)

**Step 3: Write minimal implementation**

```typescript
// src/server/a2a-types.ts
import { z } from 'zod';

// --- A2A Part (§4.1.6) ---
export const A2APartSchema = z.object({
    text: z.string().optional(),
    raw: z.string().optional(),
    url: z.string().optional(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
}).refine(
    (p) => p.text !== undefined || p.raw !== undefined || p.url !== undefined,
    { message: 'Part must have at least one of: text, raw, url' },
);
export type A2APart = z.infer<typeof A2APartSchema>;

// --- A2A Message (§4.1.4) ---
export const A2AMessageSchema = z.object({
    role: z.enum(['ROLE_USER', 'ROLE_AGENT']),
    parts: z.array(A2APartSchema).min(1),
    messageId: z.string().optional(),
    extensions: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
});
export type A2AMessage = z.infer<typeof A2AMessageSchema>;

// --- A2A SendMessageRequest (§3.2.1) ---
export const A2ASendMessageRequestSchema = z.object({
    message: A2AMessageSchema,
    configuration: z.object({
        acceptedOutputModes: z.array(z.string()).optional(),
        blocking: z.boolean().optional(),
    }).optional(),
    metadata: z.record(z.unknown()).optional(),
});
export type A2ASendMessageRequest = z.infer<typeof A2ASendMessageRequestSchema>;

// --- A2A TaskStatus (§4.1.3) ---
export const A2A_TASK_STATES = [
    'TASK_STATE_SUBMITTED',
    'TASK_STATE_WORKING',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_COMPLETED',
    'TASK_STATE_CANCELED',
    'TASK_STATE_FAILED',
    'TASK_STATE_AUTH_REQUIRED',
    'TASK_STATE_REJECTED',
] as const;

export const A2ATaskStatusSchema = z.object({
    state: z.enum(A2A_TASK_STATES),
    message: A2AMessageSchema.optional(),
    timestamp: z.string().optional(),
});
export type A2ATaskStatus = z.infer<typeof A2ATaskStatusSchema>;

// --- A2A Artifact (§4.1.7) ---
export const A2AArtifactSchema = z.object({
    artifactId: z.string(),
    name: z.string().optional(),
    parts: z.array(A2APartSchema),
    append: z.boolean().optional(),
    lastChunk: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
});
export type A2AArtifact = z.infer<typeof A2AArtifactSchema>;

// --- A2A Task (§4.1.1) ---
export const A2ATaskSchema = z.object({
    id: z.string(),
    contextId: z.string(),
    status: A2ATaskStatusSchema,
    artifacts: z.array(A2AArtifactSchema).optional(),
    history: z.array(A2AMessageSchema).optional(),
    metadata: z.record(z.unknown()).optional(),
});
export type A2ATask = z.infer<typeof A2ATaskSchema>;

// --- A2A Streaming Events (§4.2) ---
export const A2ATaskStatusUpdateEventSchema = z.object({
    taskId: z.string(),
    contextId: z.string().optional(),
    status: A2ATaskStatusSchema,
    final: z.boolean().optional(),
});

export const A2AArtifactUpdateEventSchema = z.object({
    taskId: z.string(),
    contextId: z.string().optional(),
    artifact: A2AArtifactSchema,
});

// --- A2A StreamResponse (§3.2.3) ---
export const A2AStreamResponseSchema = z.union([
    z.object({ task: A2ATaskSchema }),
    z.object({ message: A2AMessageSchema }),
    z.object({ statusUpdate: A2ATaskStatusUpdateEventSchema }),
    z.object({ artifactUpdate: A2AArtifactUpdateEventSchema }),
]);
export type A2AStreamResponse = z.infer<typeof A2AStreamResponseSchema>;

// --- A2A Agent Card (§4.4.1) ---
export const A2AAgentCardSchema = z.object({
    name: z.string(),
    description: z.string(),
    version: z.string().optional(),
    supportedInterfaces: z.array(z.object({
        url: z.string(),
        protocolBinding: z.string(),
        protocolVersion: z.string(),
    })),
    capabilities: z.object({
        streaming: z.boolean().optional(),
        pushNotifications: z.boolean().optional(),
        stateTransitionHistory: z.boolean().optional(),
        extendedAgentCard: z.boolean().optional(),
    }),
    securitySchemes: z.record(z.unknown()).optional(),
    security: z.array(z.record(z.array(z.string()))).optional(),
    defaultInputModes: z.array(z.string()),
    defaultOutputModes: z.array(z.string()),
    skills: z.array(z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        inputModes: z.array(z.string()).optional(),
        outputModes: z.array(z.string()).optional(),
    })),
});
export type A2AAgentCard = z.infer<typeof A2AAgentCardSchema>;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/a2a-types.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/a2a-types.ts src/server/a2a-types.test.ts
git commit -m "feat(a2a): A2A v1.0.0 データモデル型定義を追加"
```

---

## Task 2: TaskStore (タスク状態管理)

**Files:**
- Create: `src/server/task-store.ts`
- Test: `src/server/task-store.test.ts`

**Step 1: Write the failing test**

```typescript
// src/server/task-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStore } from './task-store.js';
import type { A2ATask } from './a2a-types.js';

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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/task-store.test.ts --reporter=verbose`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
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
            ...(message ? { message: { role: 'ROLE_AGENT', parts: [{ text: message }] } } : {}),
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/task-store.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/task-store.ts src/server/task-store.test.ts
git commit -m "feat(a2a): TaskStore — タスクライフサイクル管理を追加"
```

---

## Task 3: Agent Card 定義

**Files:**
- Create: `src/server/agent-card.ts`
- Test: `src/server/agent-card.test.ts`

**Step 1: Write the failing test**

```typescript
// src/server/agent-card.test.ts
import { describe, it, expect } from 'vitest';
import { buildAgentCard } from './agent-card.js';
import { A2AAgentCardSchema } from './a2a-types.js';

describe('Agent Card', () => {
    it('should build a valid A2A agent card', () => {
        const card = buildAgentCard({ port: 4937, host: '127.0.0.1' });
        expect(() => A2AAgentCardSchema.parse(card)).not.toThrow();
        expect(card.name).toBe('Cursor Agent (A2A)');
        expect(card.capabilities.streaming).toBe(true);
    });

    it('should include the correct URL', () => {
        const card = buildAgentCard({ port: 8080, host: 'localhost' });
        expect(card.supportedInterfaces[0].url).toBe('http://localhost:8080');
    });

    it('should include code-assistant skill', () => {
        const card = buildAgentCard({ port: 4937, host: '127.0.0.1' });
        expect(card.skills).toHaveLength(1);
        expect(card.skills[0].id).toBe('code-assistant');
    });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/agent-card.test.ts --reporter=verbose`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/server/agent-card.ts
import type { A2AAgentCard } from './a2a-types.js';

export interface AgentCardOptions {
    port: number;
    host: string;
    protocol?: string;
    version?: string;
}

export function buildAgentCard(options: AgentCardOptions): A2AAgentCard {
    const { port, host, protocol = 'http', version = '1.0.0' } = options;
    return {
        name: 'Cursor Agent (A2A)',
        description: 'AI-powered code assistant via Cursor CLI, exposed as an A2A-compliant agent',
        version,
        supportedInterfaces: [
            {
                url: `${protocol}://${host}:${port}`,
                protocolBinding: 'HTTP+JSON',
                protocolVersion: '1.0',
            },
        ],
        capabilities: {
            streaming: true,
            pushNotifications: false,
            stateTransitionHistory: false,
        },
        securitySchemes: {
            bearerAuth: {
                httpAuthSecurityScheme: { scheme: 'bearer' },
            },
        },
        security: [{ bearerAuth: [] }],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [
            {
                id: 'code-assistant',
                name: 'Code Assistant',
                description: 'General-purpose AI coding assistant powered by Cursor',
                tags: ['coding', 'development', 'ai'],
                inputModes: ['text/plain'],
                outputModes: ['text/plain'],
            },
        ],
    };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/agent-card.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/agent-card.ts src/server/agent-card.test.ts
git commit -m "feat(a2a): Agent Card 定義を追加"
```

---

## Task 4: A2A ルートハンドラ

**Files:**
- Create: `src/server/a2a-routes.ts`
- Test: `src/server/a2a-routes.test.ts`

**Step 1: Write the failing test**

```typescript
// src/server/a2a-routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { createA2ARouter } from './a2a-routes.js';
import { TaskStore } from './task-store.js';

// express supertest-like helper
async function makeRequest(app: express.Express, method: string, path: string, body?: unknown) {
    return new Promise<{ status: number; body: unknown; headers: Record<string, string> }>((resolve) => {
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
                    server.close();
                    resolve({
                        status: res.status,
                        body: responseBody,
                        headers: Object.fromEntries(res.headers.entries()),
                    });
                })
                .catch((err) => {
                    server.close();
                    throw err;
                });
        });
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
            executeAgent: vi.fn(async (_msg, _opts, onEvent) => {
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/a2a-routes.test.ts --reporter=verbose`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/server/a2a-routes.ts
import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { A2ASendMessageRequestSchema } from './a2a-types.js';
import type { A2AStreamResponse } from './a2a-types.js';
import { buildAgentCard } from './agent-card.js';
import { TaskStore } from './task-store.js';
import type { CursorAgentEvent } from './cursor-agent-service.js';

export interface A2ARouterOptions {
    taskStore: TaskStore;
    executeAgent: (
        message: string,
        config: { workspace?: string; sessionId?: string; model?: string; signal?: AbortSignal },
        onEvent: (event: CursorAgentEvent) => void,
    ) => Promise<{ sessionId?: string }>;
    port?: number;
    host?: string;
}

export function createA2ARouter(options: A2ARouterOptions): Router {
    const { taskStore, executeAgent, port = 4937, host = '127.0.0.1' } = options;
    const router = Router();

    // Agent Card (§8.2)
    router.get('/.well-known/agent-card.json', (_req: Request, res: Response) => {
        const card = buildAgentCard({ port, host });
        res.json(card);
    });

    // SendMessage (§3.1.1, §11.3.1)
    router.post('/message\\:send', async (req: Request, res: Response) => {
        const parsed = A2ASendMessageRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: { code: 400, message: 'Invalid request', details: parsed.error.issues },
            });
        }

        const { message, metadata } = parsed.data;
        const messageText = message.parts
            .map((p) => p.text ?? '')
            .filter(Boolean)
            .join('\n');

        if (!messageText.trim()) {
            res.status(400).json({
                error: { code: 400, message: 'Message must contain at least one text part' },
            });
        }

        const contextId = `ctx-${crypto.randomUUID()}`;
        const task = taskStore.create(contextId, metadata);
        taskStore.updateStatus(task.id, 'TASK_STATE_WORKING');

        const model = (metadata?.model as string) ?? undefined;
        const artifactId = `art-${crypto.randomUUID()}`;
        let fullText = '';

        try {
            await executeAgent(messageText, { model }, (event) => {
                if ((event.type === 'message' || event.type === 'text') && event.content) {
                    fullText += event.content;
                }
            });

            taskStore.addArtifact(task.id, {
                artifactId,
                parts: [{ text: fullText }],
            });
            taskStore.updateStatus(task.id, 'TASK_STATE_COMPLETED');
                return;
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            taskStore.updateStatus(task.id, 'TASK_STATE_FAILED', errMsg);
        }

        const updated = taskStore.get(task.id);
        res.json({ task: updated });
    });

    // SendStreamingMessage (§3.1.2, §11.3.1, §11.7)
    router.post('/message\\:stream', async (req: Request, res: Response) => {
        const parsed = A2ASendMessageRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: { code: 400, message: 'Invalid request', details: parsed.error.issues },
            });
        }

        const { message, metadata } = parsed.data;
        const messageText = message.parts
            .map((p) => p.text ?? '')
            .filter(Boolean)
            .join('\n');

        if (!messageText.trim()) {
            res.status(400).json({
                error: { code: 400, message: 'Message must contain at least one text part' },
            });
        }

        // SSE setup
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const contextId = `ctx-${crypto.randomUUID()}`;
        const task = taskStore.create(contextId, metadata);
        const model = (metadata?.model as string) ?? undefined;
        const artifactId = `art-${crypto.randomUUID()}`;

        // 1. Send initial task (WORKING)
        taskStore.updateStatus(task.id, 'TASK_STATE_WORKING');
        sendSSE(res, { task: taskStore.get(task.id)! });

        const controller = new AbortController();
        res.on('close', () => controller.abort());

        let fullText = '';
        try {
            await executeAgent(messageText, { model, signal: controller.signal }, (event) => {
                if (res.destroyed || !res.writable || controller.signal.aborted) return;

                if ((event.type === 'message' || event.type === 'text') && event.content) {
                    const chunk = event.content;
                    fullText += chunk;

                    // 2. Send artifact updates
                    const a2aResp: A2AStreamResponse = {
                        artifactUpdate: {
                            taskId: task.id,
                            artifact: {
                                artifactId,
                                parts: [{ text: chunk }],
                                append: fullText.length > chunk.length,
                            },
                        },
                    };
                    sendSSE(res, a2aResp);
                }
            });

            // 3. Save final artifact and send completion
            taskStore.addArtifact(task.id, {
                artifactId,
                parts: [{ text: fullText }],
            });
            taskStore.updateStatus(task.id, 'TASK_STATE_COMPLETED');

            if (!res.destroyed && res.writable) {
                sendSSE(res, {
                    statusUpdate: {
                        taskId: task.id,
                        status: {
                            state: 'TASK_STATE_COMPLETED',
                            timestamp: new Date().toISOString(),
                        },
                        final: true,
                    },
                });
                res.end();
            }
                return;
        } catch (err) {
            if (controller.signal.aborted || res.destroyed || !res.writable) {
                if (!res.writableEnded) res.end();
                return;
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            taskStore.updateStatus(task.id, 'TASK_STATE_FAILED', errMsg);
            sendSSE(res, {
                statusUpdate: {
                    taskId: task.id,
                    status: {
                        state: 'TASK_STATE_FAILED',
                        timestamp: new Date().toISOString(),
                        message: { role: 'ROLE_AGENT', parts: [{ text: errMsg }] },
                    },
                    final: true,
                },
            });
            res.end();
        }
    });

    // GetTask (§3.1.3, §11.3.2)
    router.get('/tasks/:id', (req: Request, res: Response) => {
        const task = taskStore.get(req.params.id);
        if (!task) {
            res.status(404).json({
                error: {
                    code: 404,
                    status: 'NOT_FOUND',
                    message: `Task not found: ${req.params.id}`,
                },
            });
        }
        res.json({ task });
    });

    return router;
}

function sendSSE(res: Response, data: A2AStreamResponse): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/a2a-routes.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/a2a-routes.ts src/server/a2a-routes.test.ts
git commit -m "feat(a2a): A2A準拠ルートハンドラ (/message:send, /message:stream, /tasks/{id}) を追加"
```

---

## Task 5: サーバーへの統合

**Files:**
- Modify: `src/server/index.ts`

**Step 1: サーバーにA2Aルートを追加**

`src/server/index.ts` の既存ルートの**前**に A2A ルーターをマウントする。
既存の `/:projectId/messages` ルートには影響しない。

追加するインポートと設定:

```typescript
// 既存インポートの後に追加
import { createA2ARouter } from './a2a-routes.js';
import { TaskStore } from './task-store.js';

// app.use(express.json()); の後に追加
const taskStore = new TaskStore();
const a2aRouter = createA2ARouter({
    taskStore,
    executeAgent: executeCursorAgentStream,
    port: PORT,
    host: HOST,
});
app.use(a2aRouter);
```

**Step 2: 既存テスト + 新テストがすべて通ることを確認**

Run: `npx vitest run --reporter=verbose`
Expected: 全テストPASS (既存98 + 新テスト)

**Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(a2a): A2Aルーターをサーバーに統合"
```

---

## Task 6: 全テスト確認 + ビルド検証

**Step 1: 全テスト実行**

Run: `npx vitest run --reporter=verbose`
Expected: 全テスト PASS

**Step 2: 型チェック**

Run: `npm run typecheck`
Expected: エラーなし

**Step 3: ビルド**

Run: `npm run build`
Expected: `dist/index.cjs`, `dist/index.js`, `dist/server.js` が生成される

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: A2A v1.0.0 準拠レイヤー — ビルド検証完了"
```
