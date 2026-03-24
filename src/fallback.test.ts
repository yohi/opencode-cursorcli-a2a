// src/fallback.test.ts
import { describe, it, expect } from 'vitest';
import { APICallError } from '@ai-sdk/provider';
import {
    isQuotaError,
    getNextFallbackModel,
    resolveFallbackConfig,
    type FallbackConfig,
} from './fallback';

describe('isQuotaError', () => {
    const config: FallbackConfig = {
        enabled: true,
        fallbackChain: ['cursor-agent-fast'],
    };

    it('returns true for HTTP 429', () => {
        const err = new APICallError({
            message: 'Too Many Requests',
            url: 'http://localhost:3000',
            requestBodyValues: {},
            statusCode: 429,
            isRetryable: true,
        });
        expect(isQuotaError(err, config)).toBe(true);
    });

    it('returns true for "rate limit exceeded" message', () => {
        expect(isQuotaError(new Error('rate limit exceeded'), config)).toBe(true);
    });

    it('returns true for "quota exceeded" message', () => {
        expect(isQuotaError(new Error('quota exceeded for this model'), config)).toBe(true);
    });

    it('returns false for generic errors', () => {
        expect(isQuotaError(new Error('Something else went wrong'), config)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isQuotaError(undefined, config)).toBe(false);
    });

    it('respects custom quotaErrorPatterns', () => {
        const customConfig: FallbackConfig = {
            ...config,
            quotaErrorPatterns: ['custom limit hit'],
        };
        expect(isQuotaError(new Error('Custom Limit Hit from server'), customConfig)).toBe(true);
    });
});

describe('getNextFallbackModel', () => {
    const config: FallbackConfig = {
        enabled: true,
        fallbackChain: ['cursor-agent', 'cursor-agent-fast', 'cursor-agent-gpt-4o'],
    };

    it('returns the next model in the chain', () => {
        expect(getNextFallbackModel('cursor-agent', config)).toBe('cursor-agent-fast');
        expect(getNextFallbackModel('cursor-agent-fast', config)).toBe('cursor-agent-gpt-4o');
    });

    it('returns the first model when current is not in chain', () => {
        expect(getNextFallbackModel('cursor-agent-unknown', config)).toBe('cursor-agent');
    });

    it('returns undefined when at end of chain', () => {
        expect(getNextFallbackModel('cursor-agent-gpt-4o', config)).toBeUndefined();
    });

    it('returns undefined for empty chain', () => {
        expect(getNextFallbackModel('model-a', { enabled: true, fallbackChain: [] })).toBeUndefined();
    });
});

describe('resolveFallbackConfig', () => {
    it('returns undefined when disabled', () => {
        expect(resolveFallbackConfig({ enabled: false, fallbackChain: ['cursor-agent-fast'] })).toBeUndefined();
    });

    it('returns undefined for empty input', () => {
        expect(resolveFallbackConfig()).toBeUndefined();
    });

    it('deduplicates the fallback chain', () => {
        const result = resolveFallbackConfig({
            enabled: true,
            fallbackChain: ['cursor-agent-fast', 'cursor-agent-fast', 'cursor-agent-gpt-4o'],
        });
        expect(result?.fallbackChain).toEqual(['cursor-agent-fast', 'cursor-agent-gpt-4o']);
    });

    it('sets default maxRetries to 2', () => {
        const result = resolveFallbackConfig({ enabled: true, fallbackChain: ['cursor-agent-fast'] });
        expect(result?.maxRetries).toBe(2);
    });
});
