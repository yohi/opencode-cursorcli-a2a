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
    authMiddleware?: (req: Request, res: Response, next: import('express').NextFunction) => void;
}

export function createA2ARouter(options: A2ARouterOptions): Router {
    const { taskStore, executeAgent, port = 4937, host = '127.0.0.1', authMiddleware } = options;
    const router = Router();
    
    // auth helper
    const requireAuth = authMiddleware || ((_req: Request, _res: Response, next: import('express').NextFunction) => next());

    // Agent Card (§8.2)
    router.get('/.well-known/agent-card.json', (_req: Request, res: Response) => {
        const card = buildAgentCard({ port, host });
        res.json(card);
    });

    // SendMessage (§3.1.1, §11.3.1)
    router.post('/message\\:send', requireAuth, async (req: Request, res: Response) => {
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
        // Lookup existing sessionId if possible. In a stateless a2a-routes we need the TaskStore / SessionStore. 
        // We'll use the taskStore to store session ids
        const existingSessionId = taskStore.getSessionId(contextId);
        const artifactId = `art-${crypto.randomUUID()}`;
        let fullText = '';

        const controller = new AbortController();
        req.on('close', () => controller.abort());

        try {
            const { sessionId } = await executeAgent(messageText, { model, sessionId: existingSessionId, signal: controller.signal }, (event) => {
                if (event.type === 'message' && event.content) {
                    fullText += event.content;
                } else if (event.type === 'error') {
                    fullText += `\n[Error]: ${event.content || event.text || JSON.stringify(event.data)}`;
                } else if (event.type === 'warning' || event.type === 'info') {
                    fullText += `\n[${event.type.toUpperCase()}]: ${event.content || event.text}`;
                }
            });
            if (sessionId) {
                taskStore.setSessionId(contextId, sessionId);
            }

            taskStore.addArtifact(task.id, {
                artifactId,
                parts: [{ text: fullText }],
            });
            taskStore.updateStatus(task.id, 'TASK_STATE_COMPLETED');
        } catch (err) {
            if (controller.signal.aborted) {
                taskStore.updateStatus(task.id, 'TASK_STATE_ABORTED');
                return;
            }
            const errMsg = err instanceof Error ? err.message : String(err);
            taskStore.updateStatus(task.id, 'TASK_STATE_FAILED', errMsg);
        } finally {
            req.removeAllListeners('close');
        }

        const updated = taskStore.get(task.id);
        res.json({ task: updated });
        return;
    });

    // SendStreamingMessage (§3.1.2, §11.3.1, §11.7)
    router.post('/message\\:stream', requireAuth, async (req: Request, res: Response) => {
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
        const existingSessionId = taskStore.getSessionId(contextId);
        const artifactId = `art-${crypto.randomUUID()}`;

        // 1. Send initial task (WORKING)
        taskStore.updateStatus(task.id, 'TASK_STATE_WORKING');
        sendSSE(res, { task: taskStore.get(task.id)! });

        const controller = new AbortController();
        const cleanup = () => {
            if (!controller.signal.aborted) {
                controller.abort();
                taskStore.updateStatus(task.id, 'TASK_STATE_ABORTED');
                if (!res.writableEnded) {
                    sendSSE(res, { task: taskStore.get(task.id)! });
                    res.end();
                }
            }
        };
        res.on('close', cleanup);

        let fullText = '';
        try {
            const { sessionId } = await executeAgent(messageText, { model, sessionId: existingSessionId, signal: controller.signal }, (event) => {
                if (res.destroyed || !res.writable || controller.signal.aborted) return;

                let chunk = '';
                if (event.type === 'message' && event.content) {
                    chunk = event.content;
                } else if (event.type === 'error') {
                    chunk = `\n[Error]: ${event.content || event.text || JSON.stringify(event.data)}`;
                    sendSSE(res, { message: { role: 'ROLE_AGENT', parts: [{ text: chunk }] } });
                } else if (event.type === 'warning' || event.type === 'info') {
                    chunk = `\n[${event.type.toUpperCase()}]: ${event.content || event.text}`;
                }

                if (chunk) {
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
            if (sessionId) {
                taskStore.setSessionId(contextId, sessionId);
            }

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
    router.get('/tasks/:id', requireAuth, (req: Request, res: Response) => {
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
