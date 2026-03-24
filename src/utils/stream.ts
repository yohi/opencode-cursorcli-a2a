// src/utils/stream.ts
// cursor-agent-a2a の SSE レスポンスパーサー
// フォーマット: `data: <JSON>\n\n` または `data: [DONE]`
import { CursorAgentStreamEventSchema, RpcResponseSchema } from '../schemas.js';
import type { CursorAgentStreamEvent, A2AJsonRpcResponse } from '../schemas.js';
import { Logger } from './logger.js';

/**
 * Common SSE parsing logic.
 */
async function* parseSSEStream<T>(
    stream: ReadableStream<Uint8Array>,
    mapper: (dataStr: string) => T | undefined,
    abortSignal?: AbortSignal,
): AsyncGenerator<T> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = '';

    const onAbort = () => {
        reader.cancel().catch(() => {});
    };

    if (abortSignal) {
        if (abortSignal.aborted) {
            reader.releaseLock();
            throw abortSignal.reason || new Error('AbortError');
        }
        abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        Logger.info('[Stream] Starting to read from reader');
        while (true) {
            if (abortSignal?.aborted) {
                break;
            }

            const { done, value } = await reader.read();
            if (done) {
                Logger.info('[Stream] Reader done');
                buffer += decoder.decode(); // Flush any remaining bytes
                break;
            }
            Logger.debug(`[Stream] Read ${value.length} bytes`);
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;

                const dataStr = trimmed.startsWith('data:')
                    ? trimmed.slice(5).trim()
                    : trimmed;

                if (dataStr === '[DONE]') {
                    Logger.info('[Stream] Received [DONE] marker');
                    return;
                }

                const result = mapper(dataStr);
                if (result !== undefined) yield result;
            }
        }

        if (!abortSignal?.aborted && buffer.trim()) {
            const dataStr = buffer.trim().startsWith('data:')
                ? buffer.trim().slice(5).trim()
                : buffer.trim();
            if (dataStr && dataStr !== '[DONE]') {
                const result = mapper(dataStr);
                if (result !== undefined) yield result;
            }
        }
    } catch (e) {
        Logger.error('[Stream] Error during reading/parsing stream', e);
        throw e;
    } finally {
        Logger.info('[Stream] Releasing reader lock');
        if (abortSignal) {
            abortSignal.removeEventListener('abort', onAbort);
        }
        reader.releaseLock();
    }
}

/**
 * cursor-agent-a2a サーバーの SSE ストリームを解析する AsyncGenerator。
 *
 * 各チャンクは `CursorAgentStreamEvent` として yield される。
 * `data: [DONE]` は終端マーカーとして終了する。
 *
 * @param stream - ReadableStream<Uint8Array>
 */
export function parseCursorA2AStream(
    stream: ReadableStream<Uint8Array>,
    abortSignal?: AbortSignal,
): AsyncGenerator<CursorAgentStreamEvent> {
    return parseSSEStream(stream, (dataStr) => {
        try {
            const parsed = JSON.parse(dataStr);
            return CursorAgentStreamEventSchema.parse(parsed);
        } catch (e) {
            const dataLength = dataStr.length;
            const dataPreview = dataStr.length > 100 ? dataStr.substring(0, 100) + '...' : dataStr;
            Logger.error(`Failed to parse cursor-agent-a2a SSE event`, { error: e, dataLength, dataPreview });
            throw new Error(
                `Failed to parse cursor-agent-a2a SSE event: ${e instanceof Error ? e.message : String(e)} -- data length: ${dataLength}, preview: ${dataPreview}`,
            );
        }
    }, abortSignal);
}

        /**
         * 旧 A2A JSON-RPC ストリームパーサー。
         */
        export function parseA2AStream(
            stream: ReadableStream<Uint8Array>,
            abortSignal?: AbortSignal,
        ): AsyncIterable<A2AJsonRpcResponse> {
            return parseSSEStream(stream, (dataStr) => {
                try {
                    const parsed = JSON.parse(dataStr);
                    return RpcResponseSchema.parse(parsed);
                } catch (e) {
                    const dataLength = dataStr.length;
                    const dataPreview = dataStr.length > 100 ? dataStr.substring(0, 100) + '...' : dataStr;
                    Logger.error(`Failed to parse A2A JSON-RPC SSE event`, { error: e, dataLength, dataPreview });
                    throw new Error(
                        `Failed to parse A2A JSON-RPC SSE event: ${e instanceof Error ? e.message : String(e)} -- data length: ${dataLength}, preview: ${dataPreview}`,
                    );
                }
            }, abortSignal);
        }
