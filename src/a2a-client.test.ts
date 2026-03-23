// src/a2a-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ofetch } from 'ofetch';
import { A2AClient } from './a2a-client';
import { APICallError } from '@ai-sdk/provider';
import type { A2AConfig } from './schemas';
import type { CursorAgentMessageRequest } from './schemas';

vi.mock('ofetch', () => {
    const ofetchFn = vi.fn(async (url: string, options?: any) => {
        if (url.includes('/projects') && options?.method === 'POST') {
            return { id: 'default' };
        }
        if (url.includes('/projects')) {
            return { projects: [{ id: 'default', workspace: '/tmp/project' }] };
        }
        return {};
    });
    (ofetchFn as any).raw = vi.fn();
    return {
        ofetch: ofetchFn,
        FetchError: class extends Error {
            response: unknown;
            constructor(message: string, response?: unknown) {
                super(message);
                this.response = response;
            }
        },
    };
});

describe('A2AClient', () => {
    let client: A2AClient;
    const mockConfig: A2AConfig = {
        host: '127.0.0.1',
        port: 4937,
        protocol: 'http',
    };

    const mockRequest: CursorAgentMessageRequest = {
        message: 'hello cursor',
        model: 'sonnet-4.5',
        context: { workspace: '/tmp/project' },
    };

    // cursor-agent-a2a REST API エンドポイント
    const expectedUrl = 'http://127.0.0.1:4937/default/messages?stream=true';

    beforeEach(() => {
        vi.clearAllMocks();
        client = new A2AClient(mockConfig);
    });

    const createMockResponse = (ok: boolean, status: number) => ({
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        headers: new Map(),
        _data: new ReadableStream(),
        forEach: (_cb: (v: string, k: string) => void) => {},
    });

    it('should send request with idempotency key and retry=3', async () => {
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(true, 200) as unknown);
        await client.chatStream({ request: mockRequest, idempotencyKey: 'test-key' });
        expect(ofetch.raw).toHaveBeenCalledWith(
            expectedUrl,
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'Idempotency-Key': 'test-key',
                    'x-a2a-trace-id': expect.any(String),
                }),
                retry: 3,
                retryDelay: 1000,
                ignoreResponseError: true,
                responseType: 'stream',
            })
        );
    });

    it('should send request without idempotency key and retry=0', async () => {
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(true, 200) as unknown);
        await client.chatStream({ request: mockRequest });
        expect(ofetch.raw).toHaveBeenCalledWith(
            expectedUrl,
            expect.objectContaining({ retry: 0 })
        );
    });

    it('should use token in Authorization header for localhost', async () => {
        const tokenClient = new A2AClient({ ...mockConfig, token: 'secret-cursor-token' });
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(true, 200) as unknown);
        await tokenClient.chatStream({ request: mockRequest });
        expect(ofetch.raw).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'Authorization': 'Bearer secret-cursor-token',
                }),
            })
        );
    });

    it('should throw APICallError on non-ok response', async () => {
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(false, 500) as unknown);
        await expect(client.chatStream({ request: mockRequest })).rejects.toThrow(APICallError);
        await expect(client.chatStream({ request: mockRequest })).rejects.toThrow('HTTP error 500');
    });

    it('should wrap network errors in APICallError', async () => {
        vi.mocked(ofetch.raw).mockRejectedValue(new Error('Network failure'));
        await expect(client.chatStream({ request: mockRequest })).rejects.toThrow(APICallError);
        await expect(client.chatStream({ request: mockRequest })).rejects.toThrow('Network failure');
    });

    it('should send with custom traceId if provided', async () => {
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(true, 200) as unknown);
        await client.chatStream({ request: mockRequest, traceId: 'trace-123' });
        expect(ofetch.raw).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({ 'x-a2a-trace-id': 'trace-123' }),
            })
        );
    });

    it('should build correct endpoint URL with default port 4937', async () => {
        const c = new A2AClient({ host: '127.0.0.1', port: 4937, protocol: 'http' });
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(true, 200) as unknown);
        await c.chatStream({ request: mockRequest });
        // cursor-agent-a2a は /messages?stream=true エンドポイントを使用
        expect(ofetch.raw).toHaveBeenCalledWith('http://127.0.0.1:4937/default/messages?stream=true', expect.any(Object));
    });
});
