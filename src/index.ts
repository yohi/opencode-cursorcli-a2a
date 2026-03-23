/**
 * OpenCode CursorCLI A2A Provider
 * 
 * Entry point for the OpenCode provider plugin.
 */

import { ServerManager } from './server-manager.js';

/**
 * Creates a new Cursor A2A provider instance.
 */
export function createCursorA2AProvider(options: any = {}) {
    const manager = ServerManager.getInstance();
    
    return {
        id: 'opencode-cursorcli-a2a',
        name: 'CursorCLI (A2A)',
        
        async generate(prompt: string, config: any = {}) {
            // Minimal implementation for now
            return { text: `Cursor A2A Response to: ${prompt}` };
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
