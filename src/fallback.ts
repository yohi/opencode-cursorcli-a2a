// src/fallback.ts
import { APICallError } from '@ai-sdk/provider';

/**
 * フォールバック設定。
 * クォータ枯渇などのエラー時に代替モデルへ自動切替するための構成情報。
 */
export interface FallbackConfig {
    /** フォールバック機能を有効にするか (デフォルト: false) */
    enabled: boolean;
    /**
     * モデルIDの優先順位リスト。
     * リクエスト元のモデルが枯渇した場合、このリスト内でそれより後にあるモデルへ順に切り替わる。
     * 例: ['cursor-agent-claude-4-opus', 'cursor-agent-gpt-4o', 'cursor-agent-fast']
     */
    fallbackChain: string[];
    /** @deprecated fallbackChain を使用してください */
    models?: string[];
    /**
     * クォータエラーとして検知する追加のテキストパターン。
     */
    quotaErrorPatterns?: string[];
    /**
     * フォールバック時に同一リクエスト内で試行する最大回数。
     * デフォルト: 2
     */
    maxRetries?: number;
}

/** デフォルトのクォータエラー検知パターン */
const DEFAULT_QUOTA_PATTERNS = [
    'exhausted your capacity',
    'rate limit exceeded',
    'quota exceeded',
    'resource exhausted',
    'too many requests',
    'insufficient_quota',
];

/** クォータエラーと認識するベンダー固有の JSON-RPC エラーコード */
export const ALLOWED_VENDOR_QUOTA_CODES = new Set<number>();

/**
 * エラーがクォータ関連のエラーか判定する。
 */
export function isQuotaError(error: unknown, config?: FallbackConfig): boolean {
    let statusCode: number | undefined;
    let message: string | undefined;
    let code: number | undefined;
    let responseBody: string | undefined;

    if (error instanceof APICallError) {
        statusCode = error.statusCode;
        message = error.message;
        if (typeof error.responseBody === 'string') responseBody = error.responseBody;
    } else if (error instanceof Error) {
        message = error.message;
        if ('code' in error && typeof (error as Record<string, unknown>)['code'] === 'number') {
            code = (error as Record<string, unknown>)['code'] as number;
        }
    } else if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        if (typeof record['message'] === 'string') message = record['message'];
        if (typeof record['code'] === 'number') code = record['code'];
        if (record['isQuotaError'] === true) return true;
    } else if (typeof error === 'string') {
        message = error;
    }

    if (statusCode === 429) return true;
    if (responseBody && isQuotaErrorMessage(responseBody, config)) return true;
    if (message && isQuotaErrorMessage(message, config)) return true;
    if (code !== undefined && ALLOWED_VENDOR_QUOTA_CODES.has(code)) return true;

    return false;
}

function isQuotaErrorMessage(message: string, config?: FallbackConfig): boolean {
    const lower = message.toLowerCase();
    const patterns = [...DEFAULT_QUOTA_PATTERNS];
    if (config?.quotaErrorPatterns) {
        patterns.push(...config.quotaErrorPatterns.map(p => p.trim()).filter(p => p.length > 0));
    }
    return patterns.some(p => lower.includes(p.toLowerCase()));
}

export function getNextFallbackModel(
    currentModelId: string,
    config: FallbackConfig,
): string | undefined {
    const chain = config.fallbackChain;
    if (chain.length === 0) return undefined;
    const currentIndex = chain.indexOf(currentModelId);
    let searchIndex = currentIndex === -1 ? 0 : currentIndex + 1;
    const maxIterations = chain.length;
    let iterations = 0;
    while (searchIndex < chain.length && iterations < maxIterations) {
        iterations++;
        const nextModelId = chain[searchIndex];
        if (nextModelId !== currentModelId) return nextModelId;
        searchIndex++;
    }
    return undefined;
}

export function resolveFallbackConfig(config?: Partial<FallbackConfig>): FallbackConfig | undefined {
    if (!config || !config.enabled) return undefined;
    const chain = config.fallbackChain ?? config.models ?? [];
    return {
        enabled: true,
        fallbackChain: Array.from(new Set(chain)),
        quotaErrorPatterns: config.quotaErrorPatterns,
        maxRetries: config.maxRetries ?? 2,
    };
}
