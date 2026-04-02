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
    (ofetchFn as any).raw = vi.fn(async (url: string, options?: any) => {
        if (options?.signal?.aborted) {
            throw new Error('The operation was aborted.');
        }
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            _data: new ReadableStream(),
        };
    });
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

    const createMockResponse = (ok: boolean, status: number, body: string = '') => {
        const headers = new Headers();
        const stream = new ReadableStream({
            start(controller) {
                if (body) {
                    controller.enqueue(new TextEncoder().encode(body));
                }
                controller.close();
            }
        });
        return {
            ok,
            status,
            statusText: ok ? 'OK' : 'Error',
            headers,
            _data: stream,
        };
    };

    it('should send request with idempotency key', async () => {
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(true, 200) as any);
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
                ignoreResponseError: true,
                responseType: 'stream',
            })
        );
    });

    it('should send request without idempotency key', async () => {
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(true, 200) as any);
        await client.chatStream({ request: mockRequest });
        expect(ofetch.raw).toHaveBeenCalledWith(
            expectedUrl,
            expect.objectContaining({ method: 'POST' })
        );
    });

    it('should handle AbortSignal and reject on immediate abort', async () => {
        const controller = new AbortController();
        controller.abort();
        
        // Mock ofetch.raw to reject since the signal is already aborted
        vi.mocked(ofetch.raw).mockRejectedValue(new Error('The operation was aborted.'));
        
        const p = client.chatStream({ request: mockRequest, abortSignal: controller.signal });
        await expect(p).rejects.toThrow();
        expect(ofetch.raw).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ signal: controller.signal })
        );
    });

    it('should handle mid-stream abort', async () => {
        const controller = new AbortController();
        const cancelSpy = vi.fn();
        
        // エミュレート: 中断時にキャンセルを呼ぶ
        controller.signal.addEventListener('abort', () => cancelSpy());

        const mockStream = {
            getReader: () => ({
                read: vi.fn().mockImplementation(async () => {
                    if (controller.signal.aborted) {
                        throw new Error('Aborted');
                    }
                    return { done: false, value: new TextEncoder().encode('data: {}\n\n') };
                }),
                cancel: cancelSpy,
                releaseLock: vi.fn(),
            }),
            cancel: cancelSpy,
        };

        vi.mocked(ofetch.raw).mockResolvedValue({
            status: 200,
            headers: new Headers(),
            _data: mockStream,
        } as any);

        const { stream } = await client.chatStream({ request: mockRequest, abortSignal: controller.signal });
        expect(stream).toBeDefined();
        
        const reader = stream.getReader();
        const firstRead = await reader.read();
        expect(firstRead.done).toBe(false);

        // Trigger abort
        controller.abort();
        
        // Next read should throw or handle abort
        await expect(reader.read()).rejects.toThrow();
        
        expect(ofetch.raw).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ signal: controller.signal })
        );

        // Verify cancel was called (due to signal abort event listener)
        expect(cancelSpy).toHaveBeenCalled();
    });

    it('should use token in Authorization header for localhost', async () => {
        const tokenClient = new A2AClient({ ...mockConfig, token: 'secret-cursor-token' });
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(true, 200) as any);
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

    it('should reject token for 0.0.0.0 even if provided', async () => {
        const insecureClient = new A2AClient({ host: '0.0.0.0', port: 4937, protocol: 'http', token: 'secret' });
        await expect(insecureClient.chatStream({ request: mockRequest })).rejects.toThrow('Token cannot be sent over an insecure non-localhost connection');
    });

    it('should throw APICallError on non-ok response', async () => {
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(false, 500, 'Error body content') as any);
        try {
            await client.chatStream({ request: mockRequest });
            throw new Error('Should have thrown APICallError');
        } catch (e: any) {
            expect(e).toBeInstanceOf(APICallError);
            expect(e.statusCode).toBe(500);
            expect(e.responseBody).toBe('Error body content');
            expect(e.message).toContain('Error body content');
        }
    });

    it('should wrap network errors in APICallError', async () => {
        vi.mocked(ofetch.raw).mockRejectedValue(new Error('Network failure'));
        try {
            await client.chatStream({ request: mockRequest });
            throw new Error('Should have thrown APICallError');
        } catch (e: any) {
            expect(e).toBeInstanceOf(APICallError);
            expect(e.message).toContain('Network failure');
        }
    });

    it('should send with custom traceId if provided', async () => {
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(true, 200) as any);
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
        vi.mocked(ofetch.raw).mockResolvedValue(createMockResponse(true, 200) as any);
        await c.chatStream({ request: mockRequest });
        // cursor-agent-a2a は /messages?stream=true エンドポイントを使用
        expect(ofetch.raw).toHaveBeenCalledWith('http://127.0.0.1:4937/default/messages?stream=true', expect.any(Object));
    });
});
