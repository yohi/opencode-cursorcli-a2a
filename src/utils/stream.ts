// src/utils/stream.ts
// cursor-agent-a2a の SSE レスポンスパーサー
// フォーマット: `data: <JSON>\n\n` または `data: [DONE]`
import type { CursorAgentStreamEvent } from '../schemas.js';
import { RpcResponseSchema } from '../schemas.js';

/**
 * cursor-agent-a2a サーバーの SSE ストリームを解析する AsyncGenerator。
 *
 * 各チャンクは `CursorAgentStreamEvent` として yield される。
 * `data: [DONE]` は終端マーカーとして終了する。
 *
 * @param stream - ReadableStream<Uint8Array>
 */
export async function* parseCursorA2AStream(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<CursorAgentStreamEvent> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue; // SSE コメント・空行をスキップ

                const dataStr = trimmed.startsWith('data:')
                    ? trimmed.slice(5).trim()
                    : trimmed;

                if (dataStr === '[DONE]') return; // 終端マーカー

                try {
                    const parsed: unknown = JSON.parse(dataStr);
                    yield parsed as CursorAgentStreamEvent;
                } catch (e) {
                    throw new Error(
                        `Failed to parse cursor-agent-a2a SSE event: ${e instanceof Error ? e.message : String(e)} -- data: ${dataStr}`,
                    );
                }
            }
        }

        // バッファに残ったデータをフラッシュ
        if (buffer.trim()) {
            const dataStr = buffer.trim().startsWith('data:')
                ? buffer.trim().slice(5).trim()
                : buffer.trim();
            if (dataStr && dataStr !== '[DONE]') {
                try {
                    yield JSON.parse(dataStr) as CursorAgentStreamEvent;
                } catch { /* 不完全なバッファは無視 */ }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

// ---------------------------------------------------------------------------
// Legacy: 旧 A2A JSON-RPC SSE パーサー (後方互換性のため保持)
// ---------------------------------------------------------------------------

/**
 * @deprecated cursor-agent-a2a REST API では `parseCursorA2AStream` を使用すること。
 * 旧 A2A JSON-RPC ストリームパーサー。
 */
export async function* parseA2AStream(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<import('../schemas.js').A2AJsonRpcResponse> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;

                const dataStr = trimmed.startsWith('data:')
                    ? trimmed.slice(5).trim()
                    : trimmed;

                if (dataStr === '[DONE]') return;

                try {
                    const parsed = JSON.parse(dataStr);
                    const validated = RpcResponseSchema.parse(parsed);
                    yield validated;
                } catch (e) {
                    throw new Error(
                        `Failed to parse A2A JSON-RPC SSE event: ${e instanceof Error ? e.message : String(e)} -- data: ${dataStr}`,
                    );
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}
