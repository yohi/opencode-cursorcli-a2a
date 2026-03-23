// src/router.ts
import type { AgentEndpoint, ModelConfig } from './schemas.js';

export interface MultiAgentRouter {
    resolve(modelId: string): { endpoint: AgentEndpoint; config?: ModelConfig } | undefined;
    getEndpoints(): AgentEndpoint[];
}

export class DefaultMultiAgentRouter implements MultiAgentRouter {
    private endpoints: AgentEndpoint[];

    constructor(endpoints: AgentEndpoint[]) {
        // Validate for duplicate model IDs across endpoints
        const modelToEndpoint = new Map<string, string>();
        for (let i = 0; i < endpoints.length; i++) {
            const endpoint = endpoints[i]!;
            const identity = endpoint.key || `index ${i}`;
            for (const modelId of this.getModelIds(endpoint)) {
                if (modelToEndpoint.has(modelId)) {
                    throw new Error(`Duplicate model ID '${modelId}' in endpoints '${modelToEndpoint.get(modelId)}' and '${identity}'`);
                }
                modelToEndpoint.set(modelId, identity);
            }
        }
        this.endpoints = [...endpoints];
    }

    private getModelIds(endpoint: AgentEndpoint): string[] {
        if (Array.isArray(endpoint.models)) return endpoint.models;
        return Object.entries(endpoint.models)
            .filter(([_, value]) => value !== false)
            .map(([key]) => key);
    }

    resolve(modelId: string): { endpoint: AgentEndpoint; config?: ModelConfig } | undefined {
        for (const endpoint of this.endpoints) {
            if (Array.isArray(endpoint.models)) {
                if (endpoint.models.includes(modelId)) return { endpoint };
            } else {
                const modelEntry = endpoint.models[modelId];
                if (modelEntry !== undefined) {
                    if (typeof modelEntry === 'boolean') {
                        return modelEntry ? { endpoint } : undefined;
                    }
                    return { endpoint, config: modelEntry };
                }
            }
        }
        return undefined;
    }

    getEndpoints(): AgentEndpoint[] {
        return [...this.endpoints];
    }
}
