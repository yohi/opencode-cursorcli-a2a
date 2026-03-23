// src/schemas.ts
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. Configuration Schema
// ---------------------------------------------------------------------------
export const ConfigSchema = z.object({
    host: z.string().default('127.0.0.1'),
    /** cursor-agent-a2a のデフォルトポート */
    port: z.number().int().min(1).max(65535).default(4937),
    token: z.string().optional(),
    protocol: z.enum(['http', 'https']).default('http'),
});

export type A2AConfig = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// 2. Generation Config Schema
// ---------------------------------------------------------------------------
export const GenerationConfigSchema = z.object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    stopSequences: z.array(z.string()).optional(),
    presencePenalty: z.number().optional(),
    frequencyPenalty: z.number().optional(),
    seed: z.number().optional(),
    responseFormat: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// 3. Agent Endpoint Schema (multi-agent routing)
// ---------------------------------------------------------------------------
export const ModelConfigSchema = z.object({
    options: z.object({
        generationConfig: GenerationConfigSchema.optional(),
    }).passthrough().optional(),
}).passthrough();

export const AgentEndpointSchema = ConfigSchema.extend({
    key: z.string().min(1),
    models: z.union([
        z.array(z.string()),
        z.record(z.union([z.boolean(), ModelConfigSchema]))
    ]).default([]),
});

export type AgentEndpoint = z.infer<typeof AgentEndpointSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

// ---------------------------------------------------------------------------
// 4. A2A JSON-RPC Request Schema
// ---------------------------------------------------------------------------
export const ToolSchema = z.object({}).passthrough();
export type Tool = z.infer<typeof ToolSchema>;

export const A2AJsonRpcRequestSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    method: z.literal('message/stream'),
    params: z.object({
        message: z.object({
            messageId: z.string(),
            role: z.enum(['user', 'assistant']),
            parts: z.array(z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('text'), text: z.string() }),
                z.object({
                    kind: z.literal('file'),
                    file: z.object({
                        name: z.string().optional(),
                        mimeType: z.string().optional(),
                        fileWithBytes: z.string().optional(),
                        uri: z.string().optional(),
                    }).passthrough().refine(
                        (obj: Record<string, unknown>) => Boolean(obj['fileWithBytes']) || Boolean(obj['uri']),
                        { message: 'file must contain at least one of fileWithBytes, or uri' }
                    ),
                }),
                z.object({
                    kind: z.literal('image'),
                    image: z.object({
                        mimeType: z.string().optional(),
                        bytes: z.string().optional(),
                        uri: z.string().optional(),
                    }).passthrough().refine(
                        (obj: Record<string, unknown>) => Boolean(obj['bytes']) || Boolean(obj['uri']),
                        { message: 'image must contain at least one of bytes, or uri' }
                    ),
                }),
            ])),
        }),
        configuration: z.object({
            blocking: z.boolean().default(false),
            tools: z.array(ToolSchema).optional(),
        }).optional(),
        generationConfig: GenerationConfigSchema.optional(),
        model: z.string().optional(),
        contextId: z.string().optional(),
        taskId: z.string().optional(),
        /** CursorCLI 固有: アクティブファイルパス */
        activeFilePath: z.string().optional(),
        /** CursorCLI 固有: 選択コードスニペット */
        selectedCode: z.string().optional(),
        /** CursorCLI 固有: ワークスペースルート */
        workspaceRoot: z.string().optional(),
    }),
});

export type A2AJsonRpcRequest = z.infer<typeof A2AJsonRpcRequestSchema>;

// ---------------------------------------------------------------------------
// 5. A2A Response Schema
// ---------------------------------------------------------------------------
export const STATUS_STATES = [
    'submitted', 'queued', 'working', 'stop', 'error',
    'input-required', 'completed', 'failed', 'tool_calls',
    'cancelled', 'timeout', 'aborted', 'length', 'max_tokens',
    'content_filter', 'blocked',
] as const;

export const metadataSchema = z.object({
    coderAgent: z.object({ kind: z.string() }).optional(),
}).passthrough().optional();

export const A2AResponseResultSchema = z.union([
    z.object({
        kind: z.literal('task'),
        id: z.string(),
        contextId: z.string(),
        status: z.object({ state: z.union([z.enum(STATUS_STATES), z.string()]) }),
        history: z.array(z.unknown()).optional(),
        metadata: metadataSchema,
        artifacts: z.array(z.unknown()).optional(),
    }),
    z.object({
        kind: z.literal('status-update'),
        taskId: z.string(),
        contextId: z.string().optional(),
        status: z.object({
            state: z.union([z.enum(STATUS_STATES), z.string()]),
            message: z.object({
                parts: z.array(z.object({
                    kind: z.string(),
                    text: z.string().optional(),
                    data: z.unknown().optional(),
                    image: z.object({
                        mimeType: z.string().optional(),
                        bytes: z.string().optional(),
                        uri: z.string().optional(),
                    }).optional(),
                    file: z.object({
                        name: z.string().optional(),
                        mimeType: z.string().optional(),
                        fileWithBytes: z.string().optional(),
                        uri: z.string().optional(),
                    }).optional(),
                })),
            }).optional(),
            timestamp: z.string().optional(),
        }),
        final: z.boolean().optional(),
        metadata: metadataSchema,
        usage: z.object({
            promptTokens: z.number().optional(),
            completionTokens: z.number().optional(),
        }).optional(),
    }),
    z.object({
        kind: z.literal('artifact-update'),
        taskId: z.string(),
        contextId: z.string().optional(),
        artifact: z.unknown().optional(),
    }),
]);

export type A2AResponseResult = z.infer<typeof A2AResponseResultSchema>;

export const ResultResponseSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    result: A2AResponseResultSchema,
    error: z.undefined().optional(),
}).passthrough();

export const ErrorResponseSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    error: z.object({
        code: z.number(),
        message: z.string(),
        data: z.unknown().optional(),
    }),
    result: z.undefined().optional(),
}).passthrough();

export const RpcResponseSchema = z.union([ResultResponseSchema, ErrorResponseSchema]);
export const A2AJsonRpcResponseSchema = RpcResponseSchema;
export type A2AJsonRpcResponse = z.infer<typeof A2AJsonRpcResponseSchema>;

// ---------------------------------------------------------------------------
// 6. cursor-agent-a2a REST API (https://github.com/jeffkit/cursor-agent-a2a)
// ---------------------------------------------------------------------------

/**
 * POST /messages リクエストボディ。
 * `model` フィールドで Cursor モデルを直接指定できる（最高優先度）。
 */
export const CursorAgentMessageRequestSchema = z.object({
    /** 送信するメッセージ */
    message: z.string(),
    /**
     * Cursor モデル名（最高優先度）。
     * 未指定時は CURSOR_DEFAULT_MODEL 環境変数 → デフォルト "auto" の順で適用される。
     * 例: "auto", "claude-4.6-sonnet-medium", "gpt-5.4-high"
     * 最新の対応モデルは README.md または `cursor agent --list-models` を参照。
     */
    model: z.string().optional(),
    /** セッション ID（multi-turn 会話で継続利用） */
    sessionId: z.string().optional(),
    /**
     * リクエストコンテキスト。
     * `workspace` にプロジェクトパスを指定することで CursorAgent がそのワークスペースで動作する。
     */
    context: z.object({
        /** CursorAgent が動作するワークスペースパス */
        workspace: z.string().optional(),
        /** アクティブファイルパス */
        activeFile: z.string().optional(),
        /** 選択コードスニペット */
        selectedCode: z.string().optional(),
    }).passthrough().optional(),
});

export type CursorAgentMessageRequest = z.infer<typeof CursorAgentMessageRequestSchema>;

/** SSE ストリームイベント (POST /messages?stream=true) */
export const CursorAgentStreamEventSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), content: z.string() }),
    z.object({ type: z.literal('thinking'), text: z.string().optional(), subtype: z.string().optional() }),
    z.object({ type: z.literal('complete'), sessionId: z.string().optional(), metadata: z.record(z.unknown()).optional() }),
    z.object({ type: z.literal('error'), message: z.string(), code: z.number().optional() }),
    z.object({ type: z.literal('tool_call'), name: z.string(), arguments: z.record(z.unknown()).optional(), callId: z.string().optional() }),
    z.object({ type: z.literal('tool_result'), callId: z.string().optional(), result: z.unknown() }),
]);

export type CursorAgentStreamEvent = z.infer<typeof CursorAgentStreamEventSchema>;

/**
 * 利用可能な Cursor モデル名 (cursor-agent-a2a v1 時点)。
 * `cursor agent --list-models` で最新一覧を取得可能。
 */
export const CURSOR_AGENT_MODELS = [
    'auto',                           // 自動選択 (デフォルト)
    'claude-4.6-sonnet-medium',       // Claude 3.7 Sonnet (Cursor名)
    'claude-4.6-opus-high-thinking',  // Claude 3.7 Opus + thinking
    'gpt-5.4-high',                   // GPT-4o 高性能版
    'gpt-5.4-xhigh',                  // GPT-4o 最高性能
    'gpt-5.3-codex-high',             // GPT-4o mini 等のコーディング版
    'composer-2',                     // Composer v2 モデル
] as const;

export type CursorAgentModelName = typeof CURSOR_AGENT_MODELS[number];

