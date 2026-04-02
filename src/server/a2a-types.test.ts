// src/server/a2a-types.test.ts
import { describe, it, expect } from 'vitest';
import {
    A2AMessageSchema,
    A2APartSchema,
    A2ASendMessageRequestSchema,
    A2ATaskSchema,
    A2AStreamResponseSchema,
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
