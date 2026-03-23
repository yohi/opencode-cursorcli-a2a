// src/utils/stream.test.ts
import { describe, it, expect } from 'vitest';
import { parseA2AStream } from './stream';

function makeStream(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream({
        pull(controller) {
            if (index < lines.length) {
                controller.enqueue(encoder.encode(lines[index++] + '\n'));
            } else {
                controller.close();
            }
        },
    });
}

const validStatusUpdate = {
    jsonrpc: '2.0',
    id: '1',
    result: {
        kind: 'status-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: {
            state: 'working',
            message: { parts: [{ kind: 'text', text: 'Processing' }] },
        },
        final: false,
    },
};

describe('parseA2AStream', () => {
    it('yields parsed valid JSON-RPC response', async () => {
        const stream = makeStream([`data: ${JSON.stringify(validStatusUpdate)}`]);
        const results: unknown[] = [];
        for await (const chunk of parseA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(1);
        expect((results[0] as Record<string, unknown>)['jsonrpc']).toBe('2.0');
    });

    it('skips [DONE] sentinel', async () => {
        const stream = makeStream(['data: [DONE]']);
        const results: unknown[] = [];
        for await (const chunk of parseA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(0);
    });

    it('skips empty lines', async () => {
        const stream = makeStream(['', '   ', `data: ${JSON.stringify(validStatusUpdate)}`]);
        const results: unknown[] = [];
        for await (const chunk of parseA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(1);
    });

    it('handles lines without data: prefix gracefully', async () => {
        const stream = makeStream([': comment', `data: ${JSON.stringify(validStatusUpdate)}`]);
        const results: unknown[] = [];
        for await (const chunk of parseA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(1);
    });

    it('throws InvalidResponseDataError for invalid JSON', async () => {
        const stream = makeStream(['data: {invalid json}']);
        const gen = parseA2AStream(stream);
        await expect(gen.next()).rejects.toThrow();
    });

    it('handles multiple chunks in one stream', async () => {
        const second = { ...validStatusUpdate, id: '2' };
        const stream = makeStream([
            `data: ${JSON.stringify(validStatusUpdate)}`,
            `data: ${JSON.stringify(second)}`,
        ]);
        const results: unknown[] = [];
        for await (const chunk of parseA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(2);
    });
});
