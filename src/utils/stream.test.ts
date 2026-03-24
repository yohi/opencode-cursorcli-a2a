// src/utils/stream.test.ts
import { describe, it, expect } from 'vitest';
import { parseA2AStream, parseCursorA2AStream } from './stream';

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

const validCursorEvent = {
    type: 'text',
    content: 'Hello Cursor',
};

describe('parseA2AStream', () => {
    it('yields parsed valid JSON-RPC response', async () => {
        const stream = makeStream([`data: ${JSON.stringify(validStatusUpdate)}`]);
        const results: any[] = [];
        for await (const chunk of parseA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(1);
        expect(results[0].jsonrpc).toBe('2.0');
    });

    it('skips [DONE] sentinel', async () => {
        const stream = makeStream(['data: [DONE]']);
        const results: any[] = [];
        for await (const chunk of parseA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(0);
    });

    it('throws for invalid JSON', async () => {
        const stream = makeStream(['data: {invalid json}']);
        const gen = parseA2AStream(stream);
        await expect(gen.next()).rejects.toThrow(/Failed to parse/);
    });
});

describe('parseCursorA2AStream', () => {
    it('yields parsed valid CursorAgentStreamEvent', async () => {
        const stream = makeStream([`data: ${JSON.stringify(validCursorEvent)}`]);
        const results: any[] = [];
        for await (const chunk of parseCursorA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(1);
        expect(results[0].type).toBe('text');
        expect(results[0].content).toBe('Hello Cursor');
    });

    it('handles chunk boundaries', async () => {
        const encoder = new TextEncoder();
        const part1 = 'data: {"type": "te';
        const part2 = 'xt", "content": "chunked"}\n';
        
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode(part1));
                controller.enqueue(encoder.encode(part2));
                controller.close();
            }
        });

        const results: any[] = [];
        for await (const chunk of parseCursorA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(1);
        expect(results[0].content).toBe('chunked');
    });

    it('skips comments and empty lines', async () => {
        const stream = makeStream(['', ': comment', `data: ${JSON.stringify(validCursorEvent)}`]);
        const results: any[] = [];
        for await (const chunk of parseCursorA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(1);
    });

    it('stops at [DONE]', async () => {
        const stream = makeStream([
            `data: ${JSON.stringify(validCursorEvent)}`,
            'data: [DONE]',
            `data: {"type": "text", "content": "ignored"}`
        ]);
        const results: any[] = [];
        for await (const chunk of parseCursorA2AStream(stream)) {
            results.push(chunk);
        }
        expect(results).toHaveLength(1);
        expect(results[0].content).toBe('Hello Cursor');
    });

    it('throws validation error for malformed event', async () => {
        const stream = makeStream(['data: {"type": "text"}']); // content is missing
        const gen = parseCursorA2AStream(stream);
        await expect(gen.next()).rejects.toThrow();
    });
});
