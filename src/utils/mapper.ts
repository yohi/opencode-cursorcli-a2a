// src/utils/mapper.ts
// cursor-agent-a2a (https://github.com/jeffkit/cursor-agent-a2a) REST API 向けマッパー
import type {
    LanguageModelV2Prompt as LanguageModelV1Prompt,
    LanguageModelV2FinishReason as LanguageModelV1FinishReason,
    LanguageModelV2StreamPart as LanguageModelV1StreamPart,
} from '@ai-sdk/provider';
import type { CursorAgentMessageRequest, CursorAgentStreamEvent } from '../schemas.js';
import type { AgentTriggerConfig, CursorContextConfig } from '../config.js';

// ---------------------------------------------------------------------------
// CursorCLI 内部ツール (cursor-agent が認識するツール名)
// ---------------------------------------------------------------------------
export const DEFAULT_INTERNAL_TOOLS: string[] = [
    'codebase_search',
    'read_file',
    'edit_file',
    'list_dir',
    'run_terminal_command',
    'grep_search',
    'file_search',
    'delete_file',
    'reapply',
];

// ---------------------------------------------------------------------------
// プロンプト変換オプション
// ---------------------------------------------------------------------------
export interface MapPromptOptions {
    /** cursor-agent-a2a に渡す Cursor モデル名（最高優先度）。省略時はサーバーデフォルト使用 */
    cursorModel?: string;
    /** CursorAgent が操作するワークスペースパス */
    workspace?: string;
    /** 継続セッション ID */
    sessionId?: string;
    /** ツール名マッピング (OpenCode 名 → Cursor 名) */
    toolMapping?: Record<string, string>;
    /** 自動承認する内部ツールリスト */
    internalTools?: string[];
    /** CursorCLI コンテキスト設定 */
    cursorContext?: CursorContextConfig;
    /** エージェント固有トリガー設定 */
    triggerConfig?: AgentTriggerConfig;
    /** モデル ID（ログや診断用） */
    modelId?: string;
    /** 対話回数 */
    processedMessagesCount?: number;
    /** コンテキスト ID (後方互換) */
    contextId?: string;
    /** タスク ID (後方互換) */
    taskId?: string;
    /** 生成パラメータ */
    generationConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AI SDK メッセージ → cursor-agent-a2a リクエストボディ変換
// ---------------------------------------------------------------------------

/**
 * AI SDK の LanguageModelV1Prompt を cursor-agent-a2a の
 * `POST /messages` リクエストボディに変換する。
 */
export function mapPromptToCursorRequest(
    prompt: LanguageModelV1Prompt,
    options?: MapPromptOptions,
): CursorAgentMessageRequest {
    const messageText = buildMessageText(prompt, options);

    // コンテキスト構築
    const context: Record<string, string> = {};
    const workspace = options?.workspace ?? process.cwd();
    if (workspace) context['workspace'] = workspace;

    // モデル決定: cursorModel > modelId(モデル名一致) > 省略
    let model: string | undefined = options?.cursorModel;
    if (!model && options?.modelId) {
        model = resolveCursorModelFromId(options.modelId);
    }

    return {
        message: messageText,
        ...(model ? { model } : {}),
        ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
        ...(Object.keys(context).length > 0 ? { context } : {}),
    };
}

/** モデル ID から Cursor モデル名を解決する。 */
function resolveCursorModelFromId(modelId: string): string | undefined {
    // "cursor-agent/sonnet-4.5" → "sonnet-4.5"
    const parts = modelId.split('/');
    const candidate = parts[parts.length - 1] ?? modelId;

    // 既知のプレフィックス制限を撤廃し、そのまま通す
    // ユーザーが "auto" 等を指定した際に undefined となり、サーバー側の "auto" へのフォールバックを防ぐため
    return candidate;
}

/** AI SDK プロンプト配列を単一テキストに変換 */
function buildMessageText(prompt: LanguageModelV1Prompt, options?: MapPromptOptions): string {
    const parts: string[] = [];

    for (const msg of prompt) {
        if (msg.role === 'system') {
            parts.push(`[SYSTEM]\n${msg.content}\n[/SYSTEM]`);
        } else if (msg.role === 'user') {
            const rawContent = msg.content;
            const userParts = Array.isArray(rawContent)
                ? rawContent
                : [{ type: 'text' as const, text: rawContent as string }];

            const textParts = userParts
                .filter((p): p is { type: 'text'; text: string } => (p as { type: string }).type === 'text')
                .map(p => p.text);
            if (textParts.length > 0) parts.push(textParts.join('\n'));

            const fileParts = userParts.filter(
                (p): p is any =>
                    (p as { type: string }).type === 'file',
            );
            for (const f of fileParts) {
                parts.push(`[FILE: ${f.mimeType || f.mediaType}]\n${typeof f.data === 'string' ? f.data : f.data.toString()}`);
            }
        } else if (msg.role === 'assistant') {
            const rawContent = msg.content;
            const assistantContent = Array.isArray(rawContent) ? rawContent : [];

            const textParts = assistantContent
                .filter((p): p is { type: 'text'; text: string } => (p as { type: string }).type === 'text')
                .map(p => p.text);
            if (textParts.length > 0) parts.push(`[Assistant]\n${textParts.join('\n')}`);

            const toolCalls = assistantContent.filter(
                (p): p is any =>
                    (p as { type: string }).type === 'tool-call',
            );
            for (const tc of toolCalls) {
                parts.push(`[Tool Call: ${tc.toolName}]\n${JSON.stringify(tc.args || tc.input, null, 2)}`);
            }
        } else if (msg.role === 'tool') {
            for (const result of msg.content) {
                parts.push(`[Tool Result: ${(result as { toolName?: string; toolCallId?: string }).toolName ?? (result as { toolCallId?: string }).toolCallId}]\n${JSON.stringify((result as { result?: unknown }).result, null, 2)}`);
            }
        }
    }

    const triggerAddendum = options?.triggerConfig?.systemPromptAddendum;
    if (triggerAddendum) parts.unshift(`[Context]\n${triggerAddendum}\n[/Context]`);

    const userIntent = options?.cursorContext?.userIntent;
    if (userIntent) parts.push(`\n[User Intent]: ${userIntent}`);

    return parts.join('\n\n') || '(empty)';
}

// ---------------------------------------------------------------------------
// ExtendedFinishPart — provider.ts との互換インターフェース
// ---------------------------------------------------------------------------
export interface ExtendedFinishPart {
    type: 'finish';
    finishReason: LanguageModelV1FinishReason;
    usage: {
        inputTokens: { total: number };
        outputTokens: { total: number };
    };
    inputRequired?: boolean;
    hasExposedTools?: boolean;
    coderAgentKind?: string;
    rawState?: string;
    providerMetadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SSE レスポンスマッパー
// ---------------------------------------------------------------------------
export type MappedPart = LanguageModelV1StreamPart | ExtendedFinishPart;

export interface A2AStreamMapperOptions {
    toolMapping?: Record<string, string>;
    internalTools?: string[];
    clientTools?: string[];
}

/**
 * cursor-agent-a2a の SSE ストリームイベントを AI SDK ストリームパーツに変換するマッパー。
 */
export class CursorA2AStreamMapper {
    private toolMapping: Record<string, string>;
    private internalTools: Set<string>;
    private clientTools?: Set<string>;

    private _sessionId?: string;
    private _textAccum = '';
    private _toolCallBuffer: Map<string, { name: string; args: Record<string, unknown> }> = new Map();
    private _lastFinishReason: LanguageModelV1FinishReason = 'unknown';
    private _promptTokens = 0;
    private _completionTokens = 0;

    constructor(opts?: A2AStreamMapperOptions) {
        this.toolMapping = opts?.toolMapping ?? {};
        this.internalTools = new Set(opts?.internalTools ?? DEFAULT_INTERNAL_TOOLS);
        this.clientTools = opts?.clientTools ? new Set(opts.clientTools) : undefined;
    }

    get sessionId() { return this._sessionId; }
    get lastFinishReason() { return this._lastFinishReason; }

    startNewTurn(): void {
        this._textAccum = '';
        this._toolCallBuffer.clear();
    }

    /**
     * cursor-agent-a2a の SSE イベントを AI SDK ストリームパーツに変換する。
     */
    mapEvent(event: CursorAgentStreamEvent): MappedPart[] {
        const parts: MappedPart[] = [];
        const typeStr = event.type as string;

        switch (typeStr) {
            case 'text':
            case 'message': {
                const newText = String((event as any).content ?? '');
                let delta = '';

                if (newText === this._textAccum) {
                    // Exact match (e.g. final result echoing full sequence), ignore.
                    delta = '';
                } else if (newText.startsWith(this._textAccum)) {
                    // Cumulative snapshot
                    delta = newText.slice(this._textAccum.length);
                    this._textAccum = newText;
                } else if (this._textAccum.startsWith(newText) || this._textAccum.includes(newText)) {
                    // Substring received (maybe an out of order chunk or duplicate chunk), ignore.
                    delta = '';
                } else {
                    // Entirely new chunk sequence (e.g. consecutive array blocks)
                    delta = newText;
                    this._textAccum += newText;
                }

                if (delta) {
                    parts.push({ type: 'text-delta', textDelta: delta, delta } as any);
                }
                break;
            }

            case 'thinking':
            case 'reasoning': {
                if ((event as any).subtype === 'delta' && (event as any).text) {
                    parts.push({ type: 'reasoning', textDelta: String((event as any).text) } as any);
                }
                break;
            }

            case 'tool_call': {
                const rawName = String((event as any).name ?? 'unknown');
                const mappedName = this.toolMapping[rawName] ?? rawName;
                const callId = String((event as any).callId ?? `call-${rawName}-${Date.now()}`);
                const isInternal = this.internalTools.has(mappedName) || this.internalTools.has(rawName);
                const isClientKnown = !this.clientTools || this.clientTools.has(mappedName) || this.clientTools.has(rawName);

                if (rawName === 'invalid' || (!isInternal && !isClientKnown)) {
                    // invalid / 未知のツール → run_terminal_command に変換して doom_loop 防止
                    const safeArgs = JSON.stringify({ command: `echo "[intercepted invalid tool: ${rawName}]"` });
                    parts.push({
                        type: 'tool-call',
                        toolCallType: 'function',
                        toolCallId: callId,
                        toolName: 'run_terminal_command',
                        args: safeArgs,
                    } as unknown as LanguageModelV1StreamPart);
                } else {
                    const argsObj = ((event as any).arguments ?? {}) as Record<string, unknown>;
                    const argsStr = JSON.stringify(argsObj);
                    this._toolCallBuffer.set(callId, { name: mappedName, args: argsObj });
                    parts.push({
                        type: 'tool-call',
                        toolCallType: 'function',
                        toolCallId: callId,
                        toolName: mappedName,
                        args: argsStr,
                    } as unknown as LanguageModelV1StreamPart);
                }
                break;
            }

            case 'tool_result': {
                // ツール結果はストリームパーツとして emit しない（内部で使用）
                break;
            }

            case 'result':
            case 'done':
            case 'complete': {
                if ((event as any).sessionId) this._sessionId = (event as any).sessionId;
                const metadata = ((event as any).metadata ?? {}) as Record<string, unknown>;
                this._promptTokens = (metadata['promptTokens'] as number | undefined) ?? this._promptTokens;
                this._completionTokens = (metadata['completionTokens'] as number | undefined) ?? this._completionTokens;
                this._lastFinishReason = 'stop';
                parts.push({
                    type: 'finish',
                    finishReason: 'stop',
                    usage: {
                        inputTokens: { total: this._promptTokens },
                        outputTokens: { total: this._completionTokens },
                    },
                    providerMetadata: Object.keys(metadata).length > 0 ? { 'cursor-agent': metadata } : undefined,
                } as ExtendedFinishPart);
                break;
            }

            case 'error': {
                // エラーはスローして caller が処理
                const errEvent = event as Record<string, any>;
                const errorMessage = errEvent.error || errEvent.content || errEvent.message || 'unknown';
                const errorCode = errEvent.code || 'unknown';
                throw new Error(`cursor-agent-a2a error: ${String(errorMessage)} (code: ${errorCode})`);
            }

            default:
                // 未知のイベントタイプは無視
                break;
        }

        return parts;
    }
}

// ---------------------------------------------------------------------------
// 後方互換エクスポート (provider.ts で使用している既存 API)
// ---------------------------------------------------------------------------

/** @deprecated `mapPromptToCursorRequest` を使用すること */
export function mapPromptToA2AJsonRpcRequest(
    prompt: LanguageModelV1Prompt,
    options?: MapPromptOptions,
): import('../schemas.js').A2AJsonRpcRequest {
    const restReq = mapPromptToCursorRequest(prompt, options);
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
        jsonrpc: '2.0',
        id: msgId,
        method: 'message/stream' as const,
        params: {
            message: {
                messageId: msgId,
                role: 'user',
                parts: [{ kind: 'text', text: restReq.message }],
            },
            ...(options?.contextId ? { contextId: options.contextId } : {}),
            ...(options?.taskId ? { taskId: options.taskId } : {}),
            ...(restReq.model ? { model: restReq.model } : {}),
        },
    };
}

/** 確認リクエスト生成 (後方互換) */
export function buildConfirmationRequest(
    taskId: string,
    modelId?: string,
    confirm = true,
): import('../schemas.js').A2AJsonRpcRequest {
    const msgId = `confirm-${Date.now()}`;
    return {
        jsonrpc: '2.0',
        id: msgId,
        method: 'message/stream' as const,
        params: {
            message: {
                messageId: msgId,
                role: 'user',
                parts: [{ kind: 'text', text: confirm ? 'Proceed' : 'Cancel' }],
            },
            taskId,
            ...(modelId ? { model: modelId } : {}),
        },
    };
}

/** @deprecated 後方互換 — 新実装では `CursorA2AStreamMapper` を使用 */
export class A2AStreamMapper {
    private inner: CursorA2AStreamMapper;
    public contextId?: string;
    public taskId?: string;
    public lastFinishReason?: LanguageModelV1FinishReason;

    constructor(opts?: A2AStreamMapperOptions) {
        this.inner = new CursorA2AStreamMapper(opts);
    }

    startNewTurn(): void { this.inner.startNewTurn(); }

    mapResult(result: import('../schemas.js').A2AResponseResult): MappedPart[] {
        if (result.kind === 'status-update') {
            if (result.contextId) this.contextId = result.contextId;
            if (result.taskId) this.taskId = result.taskId;

            const parts: MappedPart[] = [];
            const msg = result.status.message;

            if (msg) {
                for (const p of msg.parts) {
                    if (p.kind === 'text' && p.text) {
                        const fakeEvent: CursorAgentStreamEvent = { type: 'text', content: p.text };
                        parts.push(...this.inner.mapEvent(fakeEvent));
                    } else if (p.kind === 'data' && p.data) {
                        const data = (p.data as Record<string, unknown>);
                        if (data['request'] && typeof data['request'] === 'object') {
                            const req = data['request'] as Record<string, unknown>;
                            const fakeToolEvent: CursorAgentStreamEvent = {
                                type: 'tool_call',
                                name: String(req['name'] ?? 'unknown'),
                                arguments: (req['arguments'] ?? req['params'] ?? {}) as Record<string, unknown>,
                                callId: req['callId'] as string | undefined,
                            };
                            parts.push(...this.inner.mapEvent(fakeToolEvent));
                        }
                    }
                }
            }

            const isFinal = result.final === true;
            const state = result.status?.state;
            if (isFinal || state === 'completed' || state === 'stop' || state === 'error') {
                const finishReason: LanguageModelV1FinishReason =
                    state === 'error' ? 'error' : 'stop';
                this.lastFinishReason = finishReason;
                const usageRaw = (result as Record<string, unknown>)['usage'] as Record<string, number> | undefined;
                parts.push({
                    type: 'finish',
                    finishReason,
                    inputRequired: state === 'input-required',
                    rawState: state,
                    coderAgentKind: (result.metadata as Record<string, unknown> | undefined)?.['coderAgent'] as string | undefined,
                    usage: {
                        inputTokens: { total: usageRaw?.['promptTokens'] ?? 0 },
                        outputTokens: { total: usageRaw?.['completionTokens'] ?? 0 },
                    },
                } as ExtendedFinishPart);
            }

            return parts;
        }
        return [];
    }
}
