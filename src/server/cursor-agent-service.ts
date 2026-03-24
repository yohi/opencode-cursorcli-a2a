/**
 * Internal Cursor Agent Service (A2A compatible)
 * 
 * This service is responsible for spawning the Cursor Agent CLI
 * and parsing its output into A2A events.
 * 
 * Based on cursor-agent-a2a (https://github.com/jeffkit/cursor-agent-a2a)
 * but with native support for "thinking" events and improved durability.
 */

import { spawn, exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);
let _cachedCursorCmd: string | null = null;

/**
 * Reset the cached cursor command path.
 * Primarily for testing purposes.
 */
export function __resetCachedCursorCmd(): void {
    _cachedCursorCmd = null;
}

export interface CursorAgentConfig {
    workspace?: string;
    timeout?: number;
    model?: string;
    sessionId?: string;
    apiKey?: string;
    signal?: AbortSignal;
}

export interface CursorAgentEvent {
    type: 'message' | 'tool_use' | 'thinking' | 'result' | 'error' | 'done' | 'info' | 'warning';
    content?: string;
    subtype?: string;
    text?: string;
    sessionId?: string;
    timestamp: number;
    data?: any;
    logLevel?: 'info' | 'warn' | 'error';
}

/**
 * Finds the cursor command path.
 */
export async function findCursorCommand(): Promise<string> {
    if (_cachedCursorCmd) {
        return _cachedCursorCmd;
    }

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
                const checkCmd = process.platform === 'win32' ? 'where cursor' : 'which cursor';
                await execAsync(checkCmd);
                _cachedCursorCmd = p;
                return p;
            } catch {
                continue;
            }
        } else if (existsSync(p)) {
            _cachedCursorCmd = p;
            return p;
        }
    }

    _cachedCursorCmd = 'cursor'; // Default to 'cursor' and let it fail if not found
    return _cachedCursorCmd;
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

    // Find cursor command asynchronously
    const cursorCmd = await findCursorCommand();

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
            '--trust',
        ];

        // Add model if specified
        const model = config.model || process.env['CURSOR_DEFAULT_MODEL'] || 'auto';
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

        logger.info(`Spawning cursor agent: ${cursorCmd} ${args.join(' ')}`, { workspace });

        // Spawn cursor process
        const child = spawn(cursorCmd, args, {
            cwd: workspace,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let sessionId: string | undefined;
        let buffer = '';

        const processLine = (line: string) => {
            if (!line.trim()) return;
            logger.debug(`[Cursor Output] ${line}`);
            try {
                const json = JSON.parse(line);
                const timestamp = Date.now();

                // Extract session ID
                if (json.session_id && !sessionId) {
                    sessionId = json.session_id;
                    logger.debug(`Detected Session ID: ${sessionId}`);
                }

                // Map Cursor output to stream events
                if (json.type === 'result') {
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
                logger.debug(`[Raw Output] ${line}`);
                onEvent({
                    type: 'message',
                    content: line,
                    sessionId,
                    timestamp: Date.now(),
                });
            }
        };

        // Handle abort signal
        const onAbort = () => {
            logger.warn('Aborting cursor agent process...');
            child.kill('SIGTERM');
            reject(new Error('Cursor agent aborted'));
        };

        if (config.signal) {
            if (config.signal.aborted) {
                onAbort();
                return;
            }
            config.signal.addEventListener('abort', onAbort);
        }

        // Set up timeout
        const timeoutId = setTimeout(() => {
            logger.error(`Cursor agent command timed out after ${timeout}ms`);
            if (config.signal) {
                config.signal.removeEventListener('abort', onAbort);
            }
            child.kill('SIGTERM');
            reject(new Error('Cursor agent command timed out'));
        }, timeout);

        // Write message to stdin
        if (child.stdin) {
            logger.debug(`Sending message to cursor agent: ${message.substring(0, 50)}...`);
            child.stdin.write(message + '\n');
            child.stdin.end();
        }

        // Process stdout line by line
        child.stdout?.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
                processLine(line);
            }
        });

        // Process stderr
        child.stderr?.on('data', (data) => {
            const stderrText = data.toString().trim();
            if (!stderrText) return;

            logger.debug(`[Cursor Stderr] ${stderrText}`);

            let type: 'info' | 'warning' | 'error' = 'info';
            let logLevel: 'info' | 'warn' | 'error' = 'info';

            const lowerText = stderrText.toLowerCase();
            if (lowerText.includes('error') || lowerText.includes('fail')) {
                type = 'error';
                logLevel = 'error';
            } else if (lowerText.includes('warn')) {
                type = 'warning';
                logLevel = 'warn';
            }

            onEvent({
                type,
                content: stderrText,
                sessionId,
                timestamp: Date.now(),
                logLevel,
            });
        });

        // Handle process completion
        child.on('close', (code) => {
            logger.info(`Cursor agent process exited with code ${code}`, { sessionId });
            clearTimeout(timeoutId);
            if (config.signal) {
                config.signal.removeEventListener('abort', onAbort);
            }

            // Flush remaining buffer
            if (buffer.trim()) {
                processLine(buffer);
                buffer = '';
            }

            if (code === 0) {
                resolve({ sessionId });
            } else {
                reject(new Error(`Cursor agent exited with code ${code}`));
            }
        });

        child.on('error', (error) => {
            logger.error(`Failed to start cursor agent: ${error.message}`, error);
            clearTimeout(timeoutId);
            if (config.signal) {
                config.signal.removeEventListener('abort', onAbort);
            }
            reject(error);
        });
    });
}
