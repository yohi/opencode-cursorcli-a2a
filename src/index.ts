// src/index.ts
import { OpenCodeCursorA2AProvider } from './provider.js';
import type { OpenCodeProviderOptions } from './config.js';
import { ConfigManager, resolveConfig } from './config.js';
import { ServerManager, type AutoStartConfig } from './server-manager.js';
import type { LanguageModelV1 } from '@ai-sdk/provider';

// Re-exports
export { OpenCodeCursorA2AProvider } from './provider.js';
export { ConfigManager, resolveConfig } from './config.js';
export { InMemorySessionStore } from './session.js';
export { A2AClient } from './a2a-client.js';
export { ServerManager } from './server-manager.js';
export { 
    mapPromptToA2AJsonRpcRequest, 
    mapPromptToCursorRequest, 
    CursorA2AStreamMapper, 
    A2AStreamMapper, 
    DEFAULT_INTERNAL_TOOLS 
} from './utils/mapper.js';
export { parseA2AStream, parseCursorA2AStream } from './utils/stream.js';
export { isQuotaError, getNextFallbackModel, resolveFallbackConfig } from './fallback.js';
export { DefaultMultiAgentRouter } from './router.js';
export { CursorCLINotFoundError, A2ATimeoutError, A2AProtocolError, formatErrorForUI } from './errors.js';

// Types
export type { OpenCodeProviderOptions } from './config.js';
export type { CursorContextConfig, AgentTriggerConfig } from './config.js';
export type { 
    A2AConfig, 
    A2AJsonRpcRequest, 
    A2AJsonRpcResponse, 
    CursorAgentMessageRequest, 
    CursorAgentStreamEvent, 
    CursorAgentModelName 
} from './schemas.js';
export { CURSOR_AGENT_MODELS } from './schemas.js';
export type { SessionStore, A2ASession } from './session.js';
export type { FallbackConfig } from './fallback.js';
export type { AutoStartConfig } from './server-manager.js';
export type { MultiAgentRouter } from './router.js';
export type { MapPromptOptions } from './utils/mapper.js';

/**
 * OpenCode CursorCLI A2A Provider Interface
 */
export interface CursorA2AProvider {
    (modelId: string, options?: OpenCodeProviderOptions): LanguageModelV1;
    chat: (modelId: string, options?: OpenCodeProviderOptions) => LanguageModelV1;
    languageModel: (modelId: string, options?: OpenCodeProviderOptions) => LanguageModelV1;
    provider: string;
    providerId: string;
    // For simple usage
    generate?: (prompt: string, config?: any) => Promise<{ text: string }>;
    dispose?: () => Promise<void>;
}

/**
 * Factory Function
 */
export function createCursorA2AProvider(options?: OpenCodeProviderOptions): CursorA2AProvider {
    const providers = new Map<string, OpenCodeCursorA2AProvider>();

    function createModel(modelId: string, modelOptions?: OpenCodeProviderOptions): LanguageModelV1 {
        const cacheKey = modelId;
        const existing = providers.get(cacheKey);
        if (existing && !modelOptions) return existing as unknown as LanguageModelV1;

        const merged: OpenCodeProviderOptions = { ...options, ...modelOptions };

        const provider = new OpenCodeCursorA2AProvider(modelId, merged);
        if (!modelOptions) providers.set(cacheKey, provider);
        return provider as unknown as LanguageModelV1;
    }

    const fn = (modelId: string, modelOptions?: OpenCodeProviderOptions) => createModel(modelId, modelOptions);
    fn.chat = createModel;
    fn.languageModel = createModel;
    fn.provider = 'opencode-cursorcli-a2a';
    fn.providerId = 'opencode-cursorcli-a2a';

    // Support for simple generate/dispose interface if needed
    fn.generate = async (prompt: string, config: any = {}) => {
        const model = createModel(options?.cursorModel || 'auto', config);
        const result = await (model as any).doGenerate({
            inputFormat: 'prompt',
            mode: { type: 'regular' },
            prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        });
        return { text: result.text || '' };
    };
    fn.dispose = async () => {
        ServerManager.getInstance().dispose();
    };

    return fn as unknown as CursorA2AProvider;
}

// ---------------------------------------------------------------------------
// Default provider singleton (plugin entry point)
// ---------------------------------------------------------------------------
let _provider: CursorA2AProvider | null = null;

function initProvider(options?: OpenCodeProviderOptions): CursorA2AProvider {
    if (!_provider) {
        _provider = createCursorA2AProvider(options);
    }
    return _provider;
}

function resetProvider(): void {
    try { ConfigManager.getInstance().dispose(); } catch { /**/ }
    try { ServerManager._reset(); } catch { /**/ }
    _provider = null;
}

/** OpenCode が require() でロードした際のデフォルトエクスポート */
const provider = new Proxy((() => {}) as unknown as CursorA2AProvider, {
    apply(_target, _thisArg, args) {
        const p = initProvider();
        return (p as unknown as (...a: unknown[]) => unknown)(...args);
    },
    get(_target, prop, _receiver) {
        if (prop === 'prototype') return undefined; // Avoid issues with inheritance checks
        const p = initProvider();
        const val = (p as Record<string | symbol, unknown>)[prop];
        if (typeof val === 'function') return val.bind(p);
        return val;
    },
});

export { provider, initProvider, resetProvider, createCursorA2AProvider as createProvider };
export default createCursorA2AProvider;
