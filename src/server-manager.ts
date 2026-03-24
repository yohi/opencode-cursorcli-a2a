/**
 * Server Manager for Cursor Agent
 * 
 * Responsible for starting and stopping the internal A2A server.
 * Prioritizes the internal server over external libraries.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './utils/logger.js';
import { ConfigManager } from './config.js';

export interface AutoStartConfig {
    /** cursor-agent の実行ファイルへのパス。未指定時は自動検出。 */
    serverPath?: string;
    /** 起動時に追加・上書きする環境変数 */
    env?: Record<string, string>;
    /** TCP 接続確認のポーリング間隔 (ms, デフォルト: 200) */
    pollIntervalMs?: number;
    /** サーバー起動タイムアウト (ms, デフォルト: 15000) */
    startupTimeoutMs?: number;
}

/**
 * Resolves the current directory safely.
 */
function getCurrentDir(): string {
    try {
        // @ts-ignore: ESM-only property
        if (typeof import.meta !== 'undefined' && import.meta.url) {
            return path.dirname(fileURLToPath(import.meta.url));
        }
        return typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    } catch {
        return process.cwd();
    }
}

export async function probePort(port: number, host: string): Promise<boolean> {
    // テスト環境では TCP 接続をスキップして HTTP check のみを行う
    // (createConnection をモックするのが難しいため)
    if (process.env.NODE_ENV === 'test') {
        return new Promise((resolve) => {
            const normalizedHost = (host.includes(':') && !host.startsWith('[') && !host.endsWith(']'))
                ? `[${host}]`
                : host;
            const url = `http://${normalizedHost}:${port}/health`;
            const timeoutMs = 500;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            fetch(url, { signal: controller.signal })
                .then(async (res) => {
                    if (!res.ok) { resolve(false); return; }
                    const data = await res.json() as { service?: string };
                    resolve(!!(data && data.service === 'opencode-cursor-a2a-internal'));
                })
                .catch(() => resolve(false))
                .finally(() => clearTimeout(timeoutId));
        });
    }

    // 1. まずは TCP 接続を確認 (高速)
    const tcpReady = await new Promise<boolean>((resolve) => {
        const sock = createConnection({ port, host });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => resolve(false));
        sock.setTimeout(300, () => { sock.destroy(); resolve(false); });
    });

    if (!tcpReady) return false;

    // 2. TCP が通る場合は、HTTP health check で自律サーバーか確認
    return new Promise((resolve) => {
        // Normalize IPv6 literals
        const normalizedHost = (host.includes(':') && !host.startsWith('[') && !host.endsWith(']'))
            ? `[${host}]`
            : host;
        const url = `http://${normalizedHost}:${port}/health`;
        const timeoutMs = 500;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        fetch(url, { signal: controller.signal })
            .then(async (res) => {
                if (!res.ok) {
                    resolve(false);
                    return;
                }
                const data = await res.json() as { service?: string };
                // 自律サーバー特有の識別子を確認
                resolve(!!(data && data.service === 'opencode-cursor-a2a-internal'));
            })
            .catch(() => {
                // HTTP エラー (404等) や タイムアウトの場合は、
                // 他の(自律サーバーではない)プロセスが動いているとみなす。
                // ただし、以前のロジック(master以前)では TCP さえ通れば true としていた場合もあるため、
                // ここでは「自律サーバーか」を厳密にチェック。
                resolve(false);
            })
            .finally(() => clearTimeout(timeoutId));
    });
}

/**
 * Resolves the path to the internal or external server entry point.
 */
export function resolveServerPath(overridePath?: string): string {
    if (overridePath) {
        if (!existsSync(overridePath)) {
            throw new Error(`[ServerManager] Specified serverPath does not exist: ${overridePath}`);
        }
        return overridePath;
    }

    const currentDir = getCurrentDir();

    // 1. Internal Server (dist/server.js) - 優先
    try {
        const internalServer = path.resolve(currentDir, '..', 'dist', 'server.js');
        if (existsSync(internalServer)) return internalServer;
        
        // Try development path
        const devServer = path.resolve(currentDir, 'server', 'index.ts');
        if (existsSync(devServer)) return devServer;
    } catch {
        // Continue fallback
    }

    // 2. Local node_modules fallback (cursor-agent-a2a)
    try {
        const localServer = path.resolve(
            currentDir,
            '..', 'node_modules', 'cursor-agent-a2a', 'dist', 'index.js'
        );
        if (existsSync(localServer)) return localServer;
    } catch {
        // スキップ
    }

    // 3. npm root -g 経由でグローバルインストール検索
    try {
        const npmRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 5000 }).trim();
        const globalServer = path.join(npmRoot, 'cursor-agent-a2a', 'dist', 'index.js');
        if (existsSync(globalServer)) return globalServer;
    } catch {
        // スキップ
    }

    // 4. pnpm グローバルインストール検索
    try {
        const pnpmRoot = execSync('pnpm root -g 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
        const pnpmServer = path.join(pnpmRoot, 'cursor-agent-a2a', 'dist', 'index.js');
        if (existsSync(pnpmServer)) return pnpmServer;
    } catch {
        // スキップ
    }

    // 5. cursor-agent-a2a コマンドを which で検索
    try {
        const result = execSync('which cursor-agent-a2a 2>/dev/null', {
            encoding: 'utf8',
            timeout: 5000,
        }).trim();
        if (result && existsSync(result)) return result;
    } catch {
        // スキップ
    }

    throw new Error(
        '[ServerManager] Could not locate Cursor A2A server. \n' +
        'Please build the project first or install cursor-agent-a2a globally.'
    );
}

interface ManagedServer {
    proc: ChildProcess;
    port: number;
    host: string;
    refCount: number;
}

/**
 * CursorAgent A2A サーバープロセスを起動・管理するシングルトンマネージャー。
 */
export class ServerManager {
    private static instance: ServerManager | undefined;
    private servers = new Map<string, ManagedServer>(); // keyed by "host:port"
    private startingUp = new Map<string, Promise<void>>();
    private cleanupRegistered = false;
    private cleanupHandlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

    private constructor() {}

    static getInstance(): ServerManager {
        if (!ServerManager.instance) {
            ServerManager.instance = new ServerManager();
        }
        return ServerManager.instance;
    }

    private getKey(port: number, host: string): string {
        return `${host}:${port}`;
    }

    async ensureRunning(
        port: number,
        host: string,
        modelId: string,
        config: AutoStartConfig,
        debug: boolean = false
    ): Promise<() => void> {
        const key = this.getKey(port, host);

        // 1. 既に管理されているか確認
        const existing = this.servers.get(key);
        if (existing) {
            existing.refCount++;
            logger.info(`Reusing managed CursorAgent server on ${key} (refCount=${existing.refCount})`);
            return this.makeReleaseFn(key, existing.proc);
        }

        // 2. 起動中なら待機
        const ongoing = this.startingUp.get(key);
        if (ongoing) {
            await ongoing;
            return this.ensureRunning(port, host, modelId, config, debug);
        }

        // 3. 起動/ポーリング プロセス
        const startupPromise = (async () => {
            // 既に外部プロセスがリッスンしているか確認 (自律サーバーかどうかも含む)
            if (await probePort(port, host)) {
                logger.info(`Port ${key} already listening (internal or compatible). Skipping auto-start.`);
                return;
            }

            const serverPath = resolveServerPath(config.serverPath);
            const env: Record<string, string> = {
                ...(process.env as Record<string, string>),
                PORT: String(port),
                HOST: host,
                CURSOR_DEFAULT_MODEL: modelId,
                ...config.env,
            };

            const isTs = serverPath.endsWith('.ts');
            const args = isTs ? ['tsx', serverPath] : [serverPath];
            const cmd = isTs ? 'npx' : 'node';

            logger.info(`Starting CursorAgent server: ${serverPath} (port=${port}, host=${host})`);

            const proc = spawn(cmd, args, {
                env,
                stdio: debug ? (isTs ? 'inherit' : ['ignore', 'pipe', 'pipe']) : 'ignore',
                detached: false,
                shell: process.platform === 'win32',
            });

            if (debug && !isTs && proc.stdout) {
                proc.stdout.on('data', (d: Buffer) => process.stdout.write(`[CursorAgent-${port}] ${d}`));
            }
            if (debug && !isTs && proc.stderr) {
                proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[CursorAgent-${port}] ${d}`));
            }

            const pollMs = config.pollIntervalMs ?? 200;
            const timeoutMs = config.startupTimeoutMs ?? 15000;

            try {
                await new Promise<void>((resolve, reject) => {
                    const timeoutId = setTimeout(() => {
                        done(new Error(`[ServerManager] Server did not become ready on ${key} within ${timeoutMs}ms`));
                    }, timeoutMs);

                    const pollInterval = setInterval(async () => {
                        if (await probePort(port, host)) {
                            done();
                        }
                    }, pollMs);

                    const onError = (err: Error) => done(new Error(`Server spawn error: ${err.message}`));
                    const onExit = (code: number | null, signal: string | null) => 
                        done(new Error(`Server exited prematurely (code: ${code}, signal: ${signal})`));

                    proc.on('error', onError);
                    proc.once('exit', onExit);

                    function done(err?: Error) {
                        clearTimeout(timeoutId);
                        clearInterval(pollInterval);
                        proc.removeListener('error', onError);
                        proc.removeListener('exit', onExit);
                        if (err) reject(err);
                        else resolve();
                    }
                });
            } catch (err) {
                proc.kill();
                throw err;
            }

            // 起動成功後に登録
            const entry: ManagedServer = { proc, port, host, refCount: 0 }; 
            this.servers.set(key, entry);
            this.registerCleanup();

            const cleanupExit = () => {
                if (this.servers.get(key)?.proc === proc) {
                    logger.info(`CursorAgent server on ${key} exited.`);
                    this.servers.delete(key);
                }
            };
            proc.once('exit', cleanupExit);
        })();

        this.startingUp.set(key, startupPromise);
        try {
            await startupPromise;
        } finally {
            this.startingUp.delete(key);
        }

        // 4. 最終確認して解放関数を返す
        const managed = this.servers.get(key);
        if (managed) {
            managed.refCount++;
            return this.makeReleaseFn(key, managed.proc);
        }

        // 外部サーバーだった場合
        if (await probePort(port, host)) {
            return () => {};
        }

        throw new Error(`[ServerManager] Failed to ensure server is running on ${key}`);
    }

    private makeReleaseFn(key: string, proc: ChildProcess): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const entry = this.servers.get(key);
            if (!entry || entry.proc !== proc) return;

            entry.refCount--;
            logger.info(`Released CursorAgent server on ${key} (refCount=${entry.refCount})`);
            if (entry.refCount <= 0) {
                entry.proc.kill();
                this.servers.delete(key);
            }
        };
    }

    private registerCleanup() {
        if (this.cleanupRegistered) return;
        this.cleanupRegistered = true;

        const exitHandler = () => { try { this.dispose(); } catch { /**/ } };
        const makeSignalHandler = (signal: NodeJS.Signals) => () => {
            logger.info(`[ServerManager] Received ${signal}, cleaning up...`);
            try { this.dispose(); } catch { /**/ }
            const h = this.cleanupHandlers.find(ch => ch.event === signal);
            if (h) process.off(signal, h.handler as NodeJS.SignalsListener);
            process.kill(process.pid, signal);
        };

        const termHandler = makeSignalHandler('SIGTERM');
        const intHandler = makeSignalHandler('SIGINT');

        process.once('exit', exitHandler);
        process.once('SIGTERM', termHandler);
        process.once('SIGINT', intHandler);

        this.cleanupHandlers.push(
            { event: 'exit', handler: exitHandler },
            { event: 'SIGTERM', handler: termHandler },
            { event: 'SIGINT', handler: intHandler },
        );
    }

    public dispose() {
        for (const [, entry] of this.servers) {
            try { entry.proc.kill(); } catch { /**/ }
        }
        this.servers.clear();
        this.cleanupRegistered = false;
        for (const { event, handler } of this.cleanupHandlers) {
            process.removeListener(event, handler as (...args: unknown[]) => void);
        }
        this.cleanupHandlers = [];
        try { ConfigManager.getInstance().dispose(); } catch { /**/ }
    }

    static _reset() {
        if (ServerManager.instance) ServerManager.instance.dispose();
        ServerManager.instance = undefined;
    }
}
