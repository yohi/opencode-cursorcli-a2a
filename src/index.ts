/**
 * OpenCode CursorCLI A2A Provider
 * 
 * Entry point for the OpenCode provider plugin.
 */

import { ServerManager, type AutoStartConfig } from './server-manager.js';

export interface CreateCursorA2AProviderOptions {
    /**
     * The host to connect to or start the server on.
     * @default '127.0.0.1'
     */
    host?: string;
    /**
     * The port to connect to or start the server on.
     * @default 4937
     */
    port?: number;
    /**
     * The default model ID to use for Cursor Agent.
     * @default 'auto'
     */
    modelId?: string;
    /**
     * Configuration for automatic server startup.
     */
    autoStart?: AutoStartConfig;
    /**
     * Whether to enable debug logging.
     * @default false
     */
    debug?: boolean;
}

/**
 * Creates a new Cursor A2A provider instance.
 */
export function createCursorA2AProvider(options: CreateCursorA2AProviderOptions = {}) {
    const manager = ServerManager.getInstance();
    const host = options.host || '127.0.0.1';
    const port = options.port || 4937;
    const modelId = options.modelId || 'auto';
    const autoStart = options.autoStart || {};
    const debug = options.debug || false;
    
    return {
        id: 'opencode-cursorcli-a2a',
        name: 'CursorCLI (A2A)',
        
        async generate(prompt: string, _config: any = {}) {
            // Ensure server is running
            const release = await manager.ensureRunning(port, host, modelId, autoStart, debug);
            
            try {
                // Normalize IPv6 literals for the URL
                const normalizedHost = (host.includes(':') && !host.startsWith('[') && !host.endsWith(']'))
                    ? `[${host}]`
                    : host;
                const url = `http://${normalizedHost}:${port}/fake-project/messages`;
                
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: prompt,
                        model: modelId
                    })
                });

                if (!response.ok) {
                    const error = await response.text();
                    throw new Error(`[CursorA2AProvider] Request failed (${response.status}): ${error}`);
                }

                const data = await response.json() as { response: string };
                return { text: data.response };
            } catch (err) {
                if (debug) console.error('[CursorA2AProvider] Generate error:', err);
                throw err;
            } finally {
                release();
            }
        },

        async dispose() {
            manager.dispose();
        }
    };
}

// Default export for the provider factory
export default createCursorA2AProvider;

// Support for CJS factory pattern as required by SPEC.md
export const provider = createCursorA2AProvider;
