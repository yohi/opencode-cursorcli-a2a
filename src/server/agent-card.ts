// src/server/agent-card.ts
import type { A2AAgentCard } from './a2a-types.js';

export interface AgentCardOptions {
    port: number;
    host: string;
    protocol?: string;
    version?: string;
}

export function buildAgentCard(options: AgentCardOptions): A2AAgentCard {
    const { port, host, protocol = 'http', version = '1.0.0' } = options;
    return {
        name: 'Cursor Agent (A2A)',
        description: 'AI-powered code assistant via Cursor CLI, exposed as an A2A-compliant agent',
        version,
        supportedInterfaces: [
            {
                url: `${protocol}://${host}:${port}`,
                protocolBinding: 'HTTP+JSON',
                protocolVersion: '1.0',
            },
        ],
        capabilities: {
            streaming: true,
            pushNotifications: false,
            stateTransitionHistory: false,
        },
        securitySchemes: {
            bearerAuth: {
                httpAuthSecurityScheme: { scheme: 'bearer' },
            },
        },
        security: [{ bearerAuth: [] }],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [
            {
                id: 'code-assistant',
                name: 'Code Assistant',
                description: 'General-purpose AI coding assistant powered by Cursor',
                tags: ['coding', 'development', 'ai'],
                inputModes: ['text/plain'],
                outputModes: ['text/plain'],
            },
        ],
    };
}
