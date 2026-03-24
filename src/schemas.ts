/**
 * Shared A2A Schemas for Cursor Agent
 * 
 * Defines Zod schemas for the A2A (Agent-to-Agent) protocol.
 * Based on the cursor-agent-a2a implementation.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// 1. Config Schema
// ---------------------------------------------------------------------------
export const ConfigSchema = z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().min(1).max(65535).default(4937),
    protocol: z.enum(['http', 'https']).default('http'),
    token: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// 2. Generation Config
// ---------------------------------------------------------------------------
export const GenerationConfigSchema = z.object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    candidateCount: z.number().optional(),
    stopSequences: z.array(z.string()).optional(),
});

export type GenerationConfig = z.infer<typeof GenerationConfigSchema>;

// ---------------------------------------------------------------------------
// 2. Auth Schema
// ---------------------------------------------------------------------------
export const AuthSchema = z.object({
    apiKey: z.string().optional(),
});

export type Auth = z.infer<typeof AuthSchema>;

// ---------------------------------------------------------------------------
// 3. Model Config Schema
// ---------------------------------------------------------------------------
export const ModelConfigSchema = z.object({
    modelId: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    inputTokenLimit: z.number().optional(),
    outputTokenLimit: z.number().optional(),
    supportedGenerationMethods: z.array(z.string()).optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

// ---------------------------------------------------------------------------
// 4. A2A JSON-RPC Request Schema
// ---------------------------------------------------------------------------
export const ToolSchema = z.object({}).passthrough();
export type Tool = z.infer<typeof ToolSchema>;

export const A2AMessagePartSchema = z.discriminatedUnion('kind', [
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
]);

export type A2AMessagePart = z.infer<typeof A2AMessagePartSchema>;

export const A2AJsonRpcRequestSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]),
    method: z.literal('message/stream'),
    params: z.object({
        message: z.object({
            messageId: z.string(),
            role: z.enum(['user', 'assistant']),
            parts: z.array(A2AMessagePartSchema),
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
                parts: z.array(A2AMessagePartSchema),
            }).optional(),
            final: z.boolean().optional(),
            metadata: metadataSchema,
            usage: z.object({
                promptTokens: z.number().optional(),
                completionTokens: z.number().optional(),
            }).optional(),
        }),
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
    message: z.string(),
    sessionId: z.string().optional(),
    model: z.string().optional(),
});

export type CursorAgentMessageRequest = z.infer<typeof CursorAgentMessageRequestSchema>;

/**
 * POST /messages レスポンスボディ (非ストリーム)。
 */
export const CursorAgentMessageResponseSchema = z.object({
    response: z.string(),
    sessionId: z.string().optional(),
});

export type CursorAgentMessageResponse = z.infer<typeof CursorAgentMessageResponseSchema>;

/**
 * CursorCLI 互換のストリームイベントスキーマ
 */
export const CursorAgentStreamEventSchema = z.object({
    type: z.enum(['message', 'text', 'tool_use', 'thinking', 'result', 'error', 'done', 'info', 'warning']),
    content: z.string().optional(),
    subtype: z.string().optional(),
    text: z.string().optional(),
    sessionId: z.string().optional(),
    timestamp: z.number().default(() => Date.now()),
    data: z.any().optional(),
    logLevel: z.enum(['info', 'warn', 'error']).optional(),
}).refine(data => {
    if (data.type === 'text') return !!data.content;
    if (data.type === 'error') return !!data.content || !!data.data;
    return true;
}, {
    message: "Missing required fields for event type",
    path: ["content"]
});

export type CursorAgentStreamEvent = z.infer<typeof CursorAgentStreamEventSchema>;

/**
 * サポートされている Cursor エージェントモデルのリスト
 */
export const CURSOR_AGENT_MODELS = [
    'auto',
    'claude-4.6-sonnet-medium',
    'gpt-5.4-high',
    'composer-2',
    'claude-3-5-sonnet',
    'gpt-4o',
] as const;
