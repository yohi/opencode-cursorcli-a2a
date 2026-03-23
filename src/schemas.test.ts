// src/schemas.test.ts
import { describe, it, expect } from 'vitest';
import { ConfigSchema, A2AJsonRpcRequestSchema, RpcResponseSchema, CURSOR_AGENT_MODELS, CursorAgentStreamEventSchema } from './schemas';

describe('ConfigSchema', () => {
    it('uses defaults for missing fields', () => {
        const config = ConfigSchema.parse({});
        expect(config.host).toBe('127.0.0.1');
        // cursor-agent-a2a のデフォルトポートは 4937
        expect(config.port).toBe(4937);
        expect(config.protocol).toBe('http');
    });

    it('accepts valid config with all fields', () => {
        const config = ConfigSchema.parse({ host: 'localhost', port: 4937, protocol: 'https', token: 'tok-123' });
        expect(config.host).toBe('localhost');
        expect(config.port).toBe(4937);
        expect(config.protocol).toBe('https');
        expect(config.token).toBe('tok-123');
    });

    it('rejects invalid port', () => {
        expect(() => ConfigSchema.parse({ port: 0 })).toThrow();
        expect(() => ConfigSchema.parse({ port: 65536 })).toThrow();
    });

    it('rejects invalid protocol', () => {
        expect(() => ConfigSchema.parse({ protocol: 'ftp' })).toThrow();
    });
});

describe('A2AJsonRpcRequestSchema', () => {
    const validRequest = {
        jsonrpc: '2.0',
        id: '123',
        method: 'message/stream',
        params: {
            message: {
                messageId: 'msg-1',
                role: 'user',
                parts: [{ kind: 'text', text: 'Hello CursorCLI!' }],
            },
        },
    };

    it('validates a correct text message request', () => {
        const result = A2AJsonRpcRequestSchema.parse(validRequest);
        expect(result.jsonrpc).toBe('2.0');
        expect(result.params.message.parts[0]).toMatchObject({ kind: 'text', text: 'Hello CursorCLI!' });
    });

    it('rejects wrong jsonrpc version', () => {
        expect(() => A2AJsonRpcRequestSchema.parse({ ...validRequest, jsonrpc: '1.0' })).toThrow();
    });

    it('rejects wrong method', () => {
        expect(() => A2AJsonRpcRequestSchema.parse({ ...validRequest, method: 'other/method' })).toThrow();
    });

    it('accepts contextId and taskId in params', () => {
        const req = A2AJsonRpcRequestSchema.parse({
            ...validRequest,
            params: { ...validRequest.params, contextId: 'ctx-1', taskId: 'task-1' },
        });
        expect(req.params.contextId).toBe('ctx-1');
        expect(req.params.taskId).toBe('task-1');
    });

    describe('refine rules for file/image', () => {
        it('accepts file with fileWithBytes', () => {
            const req: any = { ...validRequest };
            req.params.message.parts = [{ kind: 'file', file: { name: 'test.ts', fileWithBytes: 'base64data' } }];
            expect(() => A2AJsonRpcRequestSchema.parse(req)).not.toThrow();
        });

        it('accepts file with uri', () => {
            const req: any = { ...validRequest };
            req.params.message.parts = [{ kind: 'file', file: { name: 'test.ts', uri: 'file:///path' } }];
            expect(() => A2AJsonRpcRequestSchema.parse(req)).not.toThrow();
        });

        it('rejects file with neither fileWithBytes nor uri', () => {
            const req: any = { ...validRequest };
            req.params.message.parts = [{ kind: 'file', file: { name: 'test.ts' } }];
            expect(() => A2AJsonRpcRequestSchema.parse(req)).toThrow();
        });

        it('accepts image with bytes', () => {
            const req: any = { ...validRequest };
            req.params.message.parts = [{ kind: 'image', image: { mimeType: 'image/png', bytes: 'base64data' } }];
            expect(() => A2AJsonRpcRequestSchema.parse(req)).not.toThrow();
        });

        it('accepts image with uri', () => {
            const req: any = { ...validRequest };
            req.params.message.parts = [{ kind: 'image', image: { uri: 'https://example.com/img.png' } }];
            expect(() => A2AJsonRpcRequestSchema.parse(req)).not.toThrow();
        });

        it('rejects image with neither bytes nor uri', () => {
            const req: any = { ...validRequest };
            req.params.message.parts = [{ kind: 'image', image: { mimeType: 'image/png' } }];
            expect(() => A2AJsonRpcRequestSchema.parse(req)).toThrow();
        });
    });
});

describe('RpcResponseSchema', () => {
    it('validates a successful status-update response', () => {
        const response = {
            jsonrpc: '2.0',
            id: '123',
            result: {
                kind: 'status-update',
                taskId: 'task-1',
                contextId: 'ctx-1',
                status: {
                    state: 'working',
                    message: { parts: [{ kind: 'text', text: 'Processing...' }] },
                },
                final: false,
            },
        };
        const result = RpcResponseSchema.parse(response);
        expect('result' in result).toBe(true);
    });

    it('validates a JSON-RPC error response', () => {
        const response = {
            jsonrpc: '2.0',
            id: '123',
            error: { code: -32000, message: 'Internal error' },
        };
        const result = RpcResponseSchema.parse(response);
        expect('error' in result).toBe(true);
    });
});

describe('CursorAgentStreamEventSchema', () => {
    it('validates a correct text event', () => {
        const event = { type: 'text', content: 'Hello' };
        const result = CursorAgentStreamEventSchema.parse(event);
        expect(result.type).toBe('text');
        if (result.type === 'text') {
            expect(result.content).toBe('Hello');
        }
    });

    it('validates a thinking event', () => {
        const event = { type: 'thinking', text: 'Hmm...', subtype: 'searching' };
        const result = CursorAgentStreamEventSchema.parse(event);
        expect(result.type).toBe('thinking');
        if (result.type === 'thinking') {
            expect(result.text).toBe('Hmm...');
        }
    });

    it('rejects text event missing content', () => {
        const event = { type: 'text' };
        expect(() => CursorAgentStreamEventSchema.parse(event)).toThrow();
    });

    it('rejects error event missing message', () => {
        const event = { type: 'error' };
        expect(() => CursorAgentStreamEventSchema.parse(event)).toThrow();
    });

    it('rejects unknown event type', () => {
        const event = { type: 'unknown_type', foo: 'bar' };
        expect(() => CursorAgentStreamEventSchema.parse(event)).toThrow();
    });
});

describe('CURSOR_AGENT_MODELS', () => {
    it('includes auto and follows format', () => {
        expect(CURSOR_AGENT_MODELS).toContain('auto');
        
        const pattern = /^[a-z0-9-\.]+$/i;
        for (const model of CURSOR_AGENT_MODELS) {
            expect(typeof model).toBe('string');
            expect(model.length).toBeGreaterThan(0);
            expect(model).toMatch(pattern);
        }
    });

    it('has no duplicates', () => {
        const uniqueModels = new Set(CURSOR_AGENT_MODELS);
        expect(uniqueModels.size).toBe(CURSOR_AGENT_MODELS.length);
    });

    it('has at least 6 models', () => {
        expect(CURSOR_AGENT_MODELS.length).toBeGreaterThanOrEqual(6);
    });
});
