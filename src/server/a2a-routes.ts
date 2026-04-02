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
            return;
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
            return;
        }

        const contextId = `ctx-${crypto.randomUUID()}`;
        const task = taskStore.create(contextId, metadata);
        taskStore.updateStatus(task.id, 'TASK_STATE_WORKING');

        const model = (metadata?.['model'] as string) ?? undefined;
        const artifactId = `art-${crypto.randomUUID()}`;
        let fullText = '';

        try {
            await executeAgent(messageText, { model }, (event) => {
                if (event.type === 'message' && event.content) {
                    fullText += event.content;
                }
            });

            taskStore.addArtifact(task.id, {
                artifactId,
                parts: [{ text: fullText }],
            });
            taskStore.updateStatus(task.id, 'TASK_STATE_COMPLETED');
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            taskStore.updateStatus(task.id, 'TASK_STATE_FAILED', errMsg);
        }

        const updated = taskStore.get(task.id);
        res.json({ task: updated });
        return;
    });

    // SendStreamingMessage (§3.1.2, §11.3.1, §11.7)
    router.post('/message\\:stream', async (req: Request, res: Response) => {
        const parsed = A2ASendMessageRequestSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({
                error: { code: 400, message: 'Invalid request', details: parsed.error.issues },
            });
            return;
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
            return;
        }

        // SSE setup
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const contextId = `ctx-${crypto.randomUUID()}`;
        const task = taskStore.create(contextId, metadata);
        const model = (metadata?.['model'] as string) ?? undefined;
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

                if (event.type === 'message' && event.content) {
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
        const taskId = req.params['id'] as string;
        const task = taskStore.get(taskId);
        if (!task) {
            res.status(404).json({
                error: {
                    code: 404,
                    status: 'NOT_FOUND',
                    message: `Task not found: ${taskId}`,
                },
            });
            return;
        }
        res.json({ task });
    });

    return router;
}

function sendSSE(res: Response, data: A2AStreamResponse): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}
