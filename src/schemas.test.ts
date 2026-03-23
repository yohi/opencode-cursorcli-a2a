// src/schemas.test.ts
import { describe, it, expect } from 'vitest';
import { ConfigSchema, A2AJsonRpcRequestSchema, RpcResponseSchema, CURSOR_AGENT_MODELS } from './schemas';

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

describe('CURSOR_AGENT_MODELS', () => {
    it('includes expected models', () => {
        expect(CURSOR_AGENT_MODELS).toContain('auto');
        expect(CURSOR_AGENT_MODELS).toContain('claude-4.6-sonnet-medium');
        expect(CURSOR_AGENT_MODELS).toContain('gpt-5.4-high');
        expect(CURSOR_AGENT_MODELS).toContain('composer-2');
    });

    it('has at least 6 models', () => {
        expect(CURSOR_AGENT_MODELS.length).toBeGreaterThanOrEqual(6);
    });
});
