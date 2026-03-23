// src/router.test.ts
import { describe, it, expect } from 'vitest';
import { DefaultMultiAgentRouter } from './router';
import type { AgentEndpoint } from './schemas';

const makeEndpoint = (overrides: Partial<AgentEndpoint> = {}): AgentEndpoint => ({
    key: 'ep-1',
    host: '127.0.0.1',
    port: 3000,
    protocol: 'http',
    models: [],
    ...overrides,
});

describe('DefaultMultiAgentRouter', () => {
    it('resolves a model by array', () => {
        const router = new DefaultMultiAgentRouter([
            makeEndpoint({ key: 'fast', port: 3001, models: ['cursor-agent-fast'] }),
            makeEndpoint({ key: 'pro', port: 3002, models: ['cursor-agent'] }),
        ]);
        expect(router.resolve('cursor-agent-fast')?.endpoint.port).toBe(3001);
        expect(router.resolve('cursor-agent')?.endpoint.port).toBe(3002);
    });

    it('returns undefined for unknown model', () => {
        const router = new DefaultMultiAgentRouter([makeEndpoint({ models: ['cursor-agent-fast'] })]);
        expect(router.resolve('cursor-agent-unknown')).toBeUndefined();
    });

    it('resolves model by record with true value', () => {
        const router = new DefaultMultiAgentRouter([
            makeEndpoint({ key: 'main', models: { 'cursor-agent': true } }),
        ]);
        expect(router.resolve('cursor-agent')?.endpoint.key).toBe('main');
    });

    it('returns undefined for model with false value in record', () => {
        const router = new DefaultMultiAgentRouter([
            makeEndpoint({ models: { 'cursor-agent': false } }),
        ]);
        expect(router.resolve('cursor-agent')).toBeUndefined();
    });

    it('throws for duplicate model IDs across endpoints', () => {
        expect(() => new DefaultMultiAgentRouter([
            makeEndpoint({ key: 'ep1', models: ['cursor-agent-fast'] }),
            makeEndpoint({ key: 'ep2', models: ['cursor-agent-fast'] }),
        ])).toThrow(/Duplicate model ID/);
    });

    it('returns all endpoints', () => {
        const router = new DefaultMultiAgentRouter([
            makeEndpoint({ key: 'ep1', models: ['cursor-agent'] }),
            makeEndpoint({ key: 'ep2', port: 3001, models: ['cursor-agent-fast'] }),
        ]);
        expect(router.getEndpoints()).toHaveLength(2);
    });
});
