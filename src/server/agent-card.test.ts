// src/server/agent-card.test.ts
import { describe, it, expect } from 'vitest';
import { buildAgentCard } from './agent-card.js';
import { A2AAgentCardSchema } from './a2a-types.js';

describe('Agent Card', () => {
    it('should build a valid A2A agent card', () => {
        const card = buildAgentCard({ port: 4937, host: '127.0.0.1' });
        expect(() => A2AAgentCardSchema.parse(card)).not.toThrow();
        expect(card.name).toBe('Cursor Agent (A2A)');
        expect(card.capabilities.streaming).toBe(true);
    });

    it('should include the correct URL', () => {
        const card = buildAgentCard({ port: 8080, host: 'localhost' });
        expect(card.supportedInterfaces[0].url).toBe('http://localhost:8080');
    });

    it('should include code-assistant skill', () => {
        const card = buildAgentCard({ port: 4937, host: '127.0.0.1' });
        expect(card.skills).toHaveLength(1);
        expect(card.skills[0].id).toBe('code-assistant');
    });
});
