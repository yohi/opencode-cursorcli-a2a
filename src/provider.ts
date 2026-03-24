import crypto from 'node:crypto';
import type {
    LanguageModelV1CallOptions,
    LanguageModelV1StreamPart,
    LanguageModelV1FunctionToolCall,
    LanguageModelV1FinishReason,
    LanguageModelV1StreamResult,
    LanguageModelV1CallResult,
    LanguageModelV1TextPart,
    LanguageModelV1ToolCallPart,
} from '@ai-sdk/provider';
import { resolveConfig, type OpenCodeProviderOptions, ConfigManager } from './config.js';
import { A2AClient } from './a2a-client.js';
import {
    mapPromptToCursorRequest,
    CursorA2AStreamMapper,
    type MapPromptOptions,
} from './utils/mapper.js';
import { parseCursorA2AStream } from './utils/stream.js';
import { type SessionStore, InMemorySessionStore } from './session.js';
import { isQuotaError, getNextFallbackModel, resolveFallbackConfig, type FallbackConfig } from './fallback.js';
import { DefaultMultiAgentRouter } from './router.js';
import { Logger } from './utils/logger.js';
import { ServerManager } from './server-manager.js';
import type { AutoStartConfig } from './server-manager.js';
import type { CursorAgentMessageRequest } from './schemas.js';

/**
 * OpenCode CursorCLI A2A Provider。
 * cursor-agent-a2a REST API (`POST /messages?stream=true`) を使用。
 * AI SDK Language Model Specification V2 互換。
 */
export class OpenCodeCursorA2AProvider {
    readonly specificationVersion = 'v1' as const;
    readonly provider = 'opencode-cursorcli-a2a';
    readonly providerId = 'opencode-cursorcli-a2a';
    readonly providerID = 'opencode-cursorcli-a2a';
    readonly id = 'opencode-cursorcli-a2a';
    readonly name = 'Cursor Agent A2A';
    readonly defaultObjectGenerationMode = undefined;
    readonly modelId: string;
    readonly modelID: string;

    private client: A2AClient | null = null;
    private sessionStore: SessionStore;
    private options?: OpenCodeProviderOptions;
    private resolvedOptions?: OpenCodeProviderOptions & {
        cursorModel?: string;
        workspace?: string;
    };
    private fallbackConfig?: FallbackConfig;
    private unregisterConfigWatcher?: () => void;
    /** autoStart 設定。初回 API 呼び出し時にサーバー起動を待機する。 */
    private _autoStartConfig?: Partial<AutoStartConfig>;
    /** サーバー起動が完了したかどうか（起動完了まで Promise を共有） */
    private _serverReady: Promise<void> | null = null;

    constructor(modelId: string, options?: OpenCodeProviderOptions) {
        this.modelId = modelId;
        this.modelID = modelId;
        this.options = options;
        this.sessionStore = options?.sessionStore ?? new InMemorySessionStore();
        this._autoStartConfig = options?.autoStart;
        this.init();

        if (options?.hotReload) {
            this.unregisterConfigWatcher = ConfigManager.getInstance().onChange(() => {
                Logger.info(`[Provider] Hot-reloading config for model ${this.modelId}`);
                this.init();
            });
        }
    }

    private init(): void {
        this._serverReady = null;
        try {
            const config = resolveConfig(this.options);
            const router = config.agents ? new DefaultMultiAgentRouter(config.agents) : undefined;
            const resolved = router?.resolve(this.modelId);
            const agentEndpoint = resolved?.endpoint;

            const finalConfig = {
                ...config,
                ...resolved?.config, // 個別モデル設定 (host, port 等が含まれる可能性あり)
                host: agentEndpoint?.host ?? resolved?.config?.host ?? config.host,
                port: agentEndpoint?.port ?? resolved?.config?.port ?? config.port,
                token: agentEndpoint?.token ?? resolved?.config?.token ?? config.token,
                protocol: agentEndpoint?.protocol ?? resolved?.config?.protocol ?? config.protocol,
            };

            const newSessionStore = this.options?.sessionStore ?? this.sessionStore ?? new InMemorySessionStore();
            const newFallbackConfig = resolveFallbackConfig(this.options?.fallback);

            this.client = new A2AClient(finalConfig);
            this.sessionStore = newSessionStore;
            this.fallbackConfig = newFallbackConfig;
            this.resolvedOptions = {
                ...this.options,
                ...resolved?.config,
                host: finalConfig.host,
                port: finalConfig.port,
                token: finalConfig.token,
                protocol: finalConfig.protocol,
                sessionStore: newSessionStore,
                fallback: newFallbackConfig,
                toolMapping: config.toolMapping,
                internalTools: config.internalTools,
                triggerConfig: config.triggerConfig,
                contextConfig: config.contextConfig,
                // 修正: モデル個別の options.cursorModel または root の cursorModel を優先
                cursorModel: resolved?.config?.options?.cursorModel ?? resolved?.config?.cursorModel ?? config.cursorModel,
                workspace: resolved?.config?.options?.workspace ?? resolved?.config?.workspace ?? config.workspace,
            };
        } catch (err) {
            Logger.error(`ERROR IN MODEL INIT (${this.modelId}):`, err);
            if (!this.client) throw err;
        }
    }

    public dispose(): void {
        if (this.unregisterConfigWatcher) this.unregisterConfigWatcher();
    }

    /**
     * 初回 API 呼び出し時に cursor-agent-a2a サーバーの起動を待機する。
     * サーバーが既に起動中ならスキップ。
     * autoStart 設定がなければ何もしない。
     */
    private async _ensureServer(): Promise<void> {
        if (!this._autoStartConfig) return;

        // 起動完了 Promise を共有して重複起動を防ぐ
        if (!this._serverReady) {
            const cfg = this.resolvedOptions!;
            const port = cfg.port ?? 4937;
            const host = cfg.host ?? '127.0.0.1';
            const debug = !!process.env['DEBUG_OPENCODE'];

            this._serverReady = ServerManager.getInstance()
                .ensureRunning(port, host, this.modelId, this._autoStartConfig, debug)
                .then(() => {
                    Logger.info(`[Provider] cursor-agent-a2a server ready on ${host}:${port}`);
                })
                .catch(err => {
                    // 起動失敗時は次回の呼び出しで再試行できるよう Promise をリセット
                    this._serverReady = null;
                    Logger.error(`[Provider] Failed to start cursor-agent-a2a server:`, err);
                    throw err;
                });
        }

        await this._serverReady;
    }

    /**
     * cursor-agent-a2a リクエストを構築する。
     *
     * モデル決定の優先順位:
     * 1. `resolvedOptions.cursorModel`（config/env 経由）
     * 2. `modelId` が Cursor モデル名形式の場合（例: "claude-4.6-sonnet-medium"）
     * 3. 省略（サーバー側 CURSOR_DEFAULT_MODEL → "auto" にフォールバック）
     */
    private createRequest(
        options: LanguageModelV1CallOptions,
        sessionId: string,
        sessionContextId?: string,
    ): CursorAgentMessageRequest {
        const triggerConfig = this.resolvedOptions?.triggerConfig?.find(t => t.modelId === this.modelId);

        const mapOptions: MapPromptOptions = {
            cursorModel: this.resolvedOptions?.cursorModel,
            workspace: this.resolvedOptions?.workspace,
            sessionId: sessionContextId, // セッション継続時のみ渡す
            toolMapping: this.resolvedOptions?.toolMapping,
            internalTools: this.resolvedOptions?.internalTools,
            cursorContext: this.resolvedOptions?.contextConfig,
            triggerConfig,
            modelId: this.modelId,
        };

        return mapPromptToCursorRequest(options.prompt, mapOptions);
    }

    async doStream(options: LanguageModelV1CallOptions): Promise<LanguageModelV1StreamResult> {
        if (!this.client) throw new Error('A2AClient is not initialized.');

        try {
            return await this._doStreamInternal(options);
        } catch (error) {
            if (this.fallbackConfig && isQuotaError(error, this.fallbackConfig)) {
                return this._attemptFallback(options, error);
            }
            throw error;
        }
    }

    private async _attemptFallback(
        callOptions: LanguageModelV1CallOptions,
        originalError: unknown,
    ): Promise<LanguageModelV1StreamResult> {
        if (!this.fallbackConfig) throw originalError;
        const fallbackCount = (callOptions as Record<string, unknown>)['_fallbackCount'] as number ?? 0;
        const maxRetries = this.fallbackConfig.maxRetries ?? 2;
        if (fallbackCount >= maxRetries) throw originalError;

        const nextModelId = getNextFallbackModel(this.modelId, this.fallbackConfig);
        if (!nextModelId) throw originalError;

        Logger.warn(`Falling back from ${this.modelId} to ${nextModelId} (level ${fallbackCount + 1})`);

        const fallbackProvider = new OpenCodeCursorA2AProvider(nextModelId, {
            ...this.options,
            sessionStore: this.sessionStore,
            hotReload: false,
        });
        return fallbackProvider.doStream({
            ...callOptions,
            _fallbackCount: fallbackCount + 1,
        } as LanguageModelV1CallOptions & { _fallbackCount: number });
    }

    private async _doStreamInternal(options: LanguageModelV1CallOptions): Promise<LanguageModelV1StreamResult> {
        // cursor-agent-a2a サーバー起動を待機（起動済みならスキップ）
        await this._ensureServer();

        // セッション ID 決定
        let sessionId: string | undefined;
        const opencodeMetadata = options.providerMetadata?.['opencode'];
        if (opencodeMetadata && typeof opencodeMetadata === 'object' && 'sessionId' in opencodeMetadata) {
            const raw = opencodeMetadata['sessionId'];
            if (raw !== null && raw !== undefined) {
                const s = String(raw).trim();
                if (s !== '') sessionId = s;
            }
        }
        if (!sessionId) sessionId = `cursor-session-${crypto.randomUUID()}`;

        const session = await this.sessionStore.get(sessionId) ?? {};

        // セッションリセット
        if (opencodeMetadata && typeof opencodeMetadata === 'object' && 'resetContext' in opencodeMetadata
            && opencodeMetadata['resetContext'] === true) {
            await this.sessionStore.resetSession(sessionId);
            delete session.contextId;
        }

        // cursor-agent-a2a の sessionId は最初のレスポンスで返却される
        // 2 ターン目以降は session.contextId（= cursor-agent-a2a の sessionId）を渡す
        const request = this.createRequest(options, sessionId, session.contextId);

        const rawToolsInput = options.mode?.type === 'regular' ? options.mode.tools : undefined;
        const clientTools = Array.isArray(rawToolsInput)
            ? (rawToolsInput as Array<{ name?: string }>).map(t => t.name).filter((x): x is string => Boolean(x))
            : undefined;

        const mapper = new CursorA2AStreamMapper({
            toolMapping: this.resolvedOptions?.toolMapping,
            internalTools: this.resolvedOptions?.internalTools,
            clientTools,
        });

        let idempotencyKey: string | undefined;
        if (opencodeMetadata && typeof opencodeMetadata === 'object' && 'idempotencyKey' in opencodeMetadata) {
            const raw = opencodeMetadata['idempotencyKey'];
            if (raw !== null && raw !== undefined) {
                const s = String(raw).trim();
                if (s !== '') idempotencyKey = s;
            }
        }

        let responseStream: ReadableStream<Uint8Array>;
        let responseHeaders: Record<string, string>;
        try {
            const resp = await this.client!.chatStream({ request, idempotencyKey, abortSignal: options.abortSignal });
            responseStream = resp.stream;
            responseHeaders = resp.headers;
        } catch (error) {
            await this.sessionStore.update(sessionId, { lastFinishReason: undefined });
            throw error;
        }

        let activeTextId: string | undefined;
        let textPartCounter = 0;
        let reasoningPartCounter = 0;
        const self = this;

        const stream = new ReadableStream<LanguageModelV1StreamPart>({
            start: async (controller) => {
                try {
                    controller.enqueue({ type: 'stream-start' } as unknown as LanguageModelV1StreamPart);
                    mapper.startNewTurn();

                    let finishedNormally = false;

                    Logger.info('[Provider] Starting to consume response stream');
                    for await (const event of parseCursorA2AStream(responseStream)) {
                        Logger.debug('[Provider] Received event', event.type);
                        const parts = mapper.mapEvent(event);

                        for (const part of parts) {
                            const p = part as Record<string, unknown>;
                            switch (p['type']) {
                                case 'text-delta': {
                                    if (activeTextId === undefined) {
                                        activeTextId = `text-${textPartCounter++}`;
                                        controller.enqueue({ type: 'text-start', id: activeTextId } as unknown as LanguageModelV1StreamPart);
                                    }
                                    controller.enqueue({ type: 'text-delta', id: activeTextId, delta: p['delta'] } as unknown as LanguageModelV1StreamPart);
                                    break;
                                }
                                case 'reasoning': {
                                    if (activeTextId !== undefined) {
                                        controller.enqueue({ type: 'text-end', id: activeTextId } as unknown as LanguageModelV1StreamPart);
                                        activeTextId = undefined;
                                    }
                                    const reasoningId = `reasoning-${reasoningPartCounter++}`;
                                    controller.enqueue({ type: 'reasoning-start', id: reasoningId } as unknown as LanguageModelV1StreamPart);
                                    controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: p['text'] } as unknown as LanguageModelV1StreamPart);
                                    controller.enqueue({ type: 'reasoning-end', id: reasoningId } as unknown as LanguageModelV1StreamPart);
                                    break;
                                }
                                case 'tool-call': {
                                    if (activeTextId !== undefined) {
                                        controller.enqueue({ type: 'text-end', id: activeTextId } as unknown as LanguageModelV1StreamPart);
                                        activeTextId = undefined;
                                    }
                                    const toolId = p['toolCallId'] as string;
                                    controller.enqueue({ type: 'tool-input-start', id: toolId, toolCallId: toolId, toolName: p['toolName'] } as unknown as LanguageModelV1StreamPart);
                                    controller.enqueue({ type: 'tool-input-delta', id: toolId, delta: p['input'] } as unknown as LanguageModelV1StreamPart);
                                    controller.enqueue({ type: 'tool-input-end', id: toolId } as unknown as LanguageModelV1StreamPart);
                                    controller.enqueue(part as LanguageModelV1StreamPart);
                                    break;
                                }
                                case 'finish': {
                                    finishedNormally = true;
                                    if (activeTextId !== undefined) {
                                        controller.enqueue({ type: 'text-end', id: activeTextId } as unknown as LanguageModelV1StreamPart);
                                        activeTextId = undefined;
                                    }

                                    const finishPart = p as { finishReason: LanguageModelV1FinishReason; usage: { inputTokens: { total: number }; outputTokens: { total: number } }; providerMetadata?: Record<string, unknown> };
                                    controller.enqueue({
                                        type: 'finish',
                                        finishReason: finishPart.finishReason,
                                        usage: {
                                            promptTokens: finishPart.usage.inputTokens.total,
                                            completionTokens: finishPart.usage.outputTokens.total,
                                        },
                                        ...(finishPart.providerMetadata ? { providerMetadata: finishPart.providerMetadata } : {}),
                                    } as unknown as LanguageModelV1StreamPart);
                                    break;
                                }
                                default:
                                    controller.enqueue(part as LanguageModelV1StreamPart);
                            }
                        }
                    }
                    Logger.info('[Provider] Response stream consumed completely', { finishedNormally });

                    if (!finishedNormally) {
                        // ストリーム終了でも complete イベントが来なかった場合
                        if (activeTextId !== undefined) {
                            controller.enqueue({ type: 'text-end', id: activeTextId } as unknown as LanguageModelV1StreamPart);
                            activeTextId = undefined;
                        }
                        controller.enqueue({
                            type: 'finish',
                            finishReason: 'stop',
                            usage: { promptTokens: 0, completionTokens: 0 },
                        } as unknown as LanguageModelV1StreamPart);
                    }

                    // セッション状態を保存 (cursor-agent-a2a の sessionId を contextId として保持)
                    await self.sessionStore.update(sessionId!, {
                        contextId: mapper.sessionId ?? session.contextId,
                        lastFinishReason: mapper.lastFinishReason,
                        processedMessagesCount: options.prompt.length,
                    });

                    controller.close();
                } catch (error) {
                    await self.sessionStore.update(sessionId!, { lastFinishReason: undefined });
                    controller.error(error);
                }
            },
            cancel(reason) {
                Logger.warn(`[Provider] AI SDK cancelled the generation stream! Reason:`, reason);
                try { responseStream.cancel(reason).catch(() => {}); } catch {}
            }
        });

        return {
            stream,
            rawCall: { rawPrompt: options.prompt, rawSettings: options },
            rawResponse: { headers: responseHeaders },
            request: { body: JSON.stringify(request) },
            warnings: [],
        };
    }

    async doGenerate(options: LanguageModelV1CallOptions): Promise<LanguageModelV1CallResult> {
        const { stream: sdkStream, rawCall, rawResponse, request, warnings } = await this.doStream(options);
        const reader = sdkStream.getReader();
        let text = '';
        let reasoning = '';
        const toolCalls: LanguageModelV1FunctionToolCall[] = [];
        const content: (LanguageModelV1TextPart | LanguageModelV1ToolCallPart)[] = [];
        let finishReason: LanguageModelV1FinishReason = 'other';
        const usage = { promptTokens: 0, completionTokens: 0 };
        let providerMetadata: Record<string, unknown> = {};

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const v = value as Record<string, unknown>;
                switch (v['type']) {
                    case 'text-delta':
                        text += v['delta'];
                        if (content.length > 0 && content[content.length - 1]?.type === 'text') {
                            (content[content.length - 1] as LanguageModelV1TextPart).text += v['delta'];
                        } else {
                            content.push({ type: 'text', text: v['delta'] as string });
                        }
                        break;
                    case 'reasoning-delta':
                        reasoning += v['delta'] as string;
                        break;
                    case 'tool-call':
                        toolCalls.push({ toolCallType: 'function', toolCallId: v['toolCallId'] as string, toolName: v['toolName'] as string, args: v['input'] as string });
                        content.push({ type: 'tool-call', toolCallId: v['toolCallId'] as string, toolName: v['toolName'] as string, args: v['input'] as string });
                        break;
                    case 'finish':
                        finishReason = v['finishReason'] as LanguageModelV1FinishReason;
                        if (v['usage']) {
                            const u = v['usage'] as { promptTokens?: number; completionTokens?: number };
                            usage.promptTokens = u.promptTokens ?? 0;
                            usage.completionTokens = u.completionTokens ?? 0;
                        }
                        if (v['providerMetadata']) {
                            providerMetadata = { ...providerMetadata, ...(v['providerMetadata'] as Record<string, unknown>) };
                        }
                        break;
                }
            }
        } finally {
            reader.releaseLock();
        }

        return {
            text: text.length > 0 ? text : undefined,
            reasoning: reasoning.length > 0 ? reasoning : undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            finishReason,
            usage,
            rawCall,
            rawResponse,
            request,
            warnings,
            providerMetadata: Object.keys(providerMetadata).length > 0 ? providerMetadata : undefined,
        };
    }
}
