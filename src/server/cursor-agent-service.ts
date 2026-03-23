/**
 * Internal Cursor Agent Service (A2A compatible)
 * 
 * This service is responsible for spawning the Cursor Agent CLI
 * and parsing its output into A2A events.
 * 
 * Based on cursor-agent-a2a (https://github.com/jeffkit/cursor-agent-a2a)
 * but with native support for "thinking" events and improved durability.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

export interface CursorAgentConfig {
    workspace?: string;
    timeout?: number;
    model?: string;
    sessionId?: string;
    apiKey?: string;
}

export interface CursorAgentEvent {
    type: 'message' | 'tool_use' | 'thinking' | 'result' | 'error' | 'done';
    content?: string;
    subtype?: string;
    text?: string;
    sessionId?: string;
    timestamp: number;
    data?: any;
}

/**
 * Finds the cursor command path.
 */
export function findCursorCommand(): string {
    const possiblePaths = [
        'cursor', // In PATH
        '/usr/local/bin/cursor',
        '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
        process.env['CURSOR_CLI_PATH'],
    ];

    for (const p of possiblePaths) {
        if (!p) continue;
        if (p === 'cursor') {
            try {
                execSync('which cursor', { stdio: 'pipe' });
                return p;
            } catch {
                continue;
            }
        } else if (existsSync(p)) {
            return p;
        }
    }

    return 'cursor'; // Default to 'cursor' and let it fail if not found
}

/**
 * Executes the Cursor Agent command with streaming output.
 * Handles "thinking" events natively.
 */
export async function executeCursorAgentStream(
    message: string,
    config: CursorAgentConfig = {},
    onEvent: (event: CursorAgentEvent) => void
): Promise<{ sessionId?: string }> {
    const workspace = config.workspace || process.cwd();
    const timeout = config.timeout || 600000; // 10 minutes default

    return new Promise((resolve, reject) => {
        // Build command arguments
        const args = [
            'agent',
            '--print',
            '--output-format',
            'stream-json',
            '--stream-partial-output',
            '--workspace',
            workspace,
            '--force',
        ];

        // Add model if specified
        const model = config.model || process.env['CURSOR_DEFAULT_MODEL'] || 'sonnet-4.5';
        args.push('--model', model);

        // Add session resume if sessionId is provided
        if (config.sessionId) {
            args.push('--resume', config.sessionId);
        }

        // Set up environment
        const env = {
            ...process.env,
            ...(config.apiKey && { CURSOR_API_KEY: config.apiKey }),
        };

        // Find cursor command
        const cursorCmd = findCursorCommand();

        // Spawn cursor process
        const child = spawn(cursorCmd, args, {
            cwd: workspace,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Set up timeout
        const timeoutId = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error('Cursor agent command timed out'));
        }, timeout);

        // Write message to stdin
        if (child.stdin) {
            child.stdin.write(message);
            child.stdin.end();
        }

        let sessionId: string | undefined;
        let buffer = '';

        // Process stdout line by line
        child.stdout?.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const json = JSON.parse(line);
                    const timestamp = Date.now();

                    // Extract session ID
                    if (json.session_id && !sessionId) {
                        sessionId = json.session_id;
                    }

                    // Map Cursor output to stream events
                    if (json.type === 'result') {
                        if (json.result) {
                            onEvent({
                                type: 'message',
                                content: json.result,
                                sessionId,
                                timestamp,
                                data: json,
                            });
                        }
                        onEvent({
                            type: 'result',
                            sessionId,
                            timestamp,
                            data: json,
                        });
                    } else if (json.type === 'assistant' && json.message?.content) {
                        for (const block of json.message.content) {
                            if (block.type === 'text') {
                                onEvent({
                                    type: 'message',
                                    content: block.text,
                                    sessionId,
                                    timestamp,
                                    data: json,
                                });
                            } else if (block.type === 'tool_use') {
                                onEvent({
                                    type: 'tool_use',
                                    sessionId,
                                    timestamp,
                                    data: block,
                                });
                            }
                        }
                    } else if (json.type === 'thinking') {
                        // Native support for thinking events
                        onEvent({
                            type: 'thinking',
                            subtype: json.subtype,
                            text: json.text,
                            sessionId,
                            timestamp,
                            data: json,
                        });
                    }
                } catch (parseError) {
                    // If JSON parsing fails, send as raw message
                    onEvent({
                        type: 'message',
                        content: line,
                        sessionId,
                        timestamp: Date.now(),
                    });
                }
            }
        });

        // Process stderr
        child.stderr?.on('data', (data) => {
            const errorText = data.toString();
            onEvent({
                type: 'error',
                content: errorText,
                sessionId,
                timestamp: Date.now(),
            });
        });

        // Handle process completion
        child.on('close', (code) => {
            clearTimeout(timeoutId);
            if (code === 0) {
                resolve({ sessionId });
            } else {
                reject(new Error(`Cursor agent exited with code ${code}`));
            }
        });

        child.on('error', (error) => {
            clearTimeout(timeoutId);
            reject(error);
        });
    });
}
