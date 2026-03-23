// src/server-manager.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { Logger } from './utils/logger.js';
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

function probePort(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = createConnection({ port, host });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => resolve(false));
        sock.setTimeout(300, () => { sock.destroy(); resolve(false); });
    });
}

function waitForPort(port: number, host: string, timeoutMs: number, pollMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = async () => {
            if (await probePort(port, host)) { resolve(); return; }
            if (Date.now() >= deadline) {
                reject(new Error(`[ServerManager] CursorAgent did not become ready on ${host}:${port} within ${timeoutMs}ms`));
                return;
            }
            setTimeout(poll, pollMs);
        };
        poll();
    });
}

export function resolveServerPath(overridePath?: string): string {
    if (overridePath) {
        if (!existsSync(overridePath)) {
            throw new Error(`[ServerManager] Specified serverPath does not exist: ${overridePath}`);
        }
        return overridePath;
    }

    // 1. ローカル node_modules/cursor-agent-a2a/dist/index.js
    try {
        let currentDir: string;
        if (typeof __dirname !== 'undefined') {
            currentDir = __dirname;
        } else {
            // @ts-ignore: ESM context
            currentDir = path.dirname(new URL(import.meta.url).pathname);
        }
        const localServer = path.resolve(
            currentDir,
            '..', 'node_modules', 'cursor-agent-a2a', 'dist', 'index.js'
        );
        if (existsSync(localServer)) return localServer;
    } catch {
        // パス解決に失敗した場合はスキップ
    }

    // 2. npm root -g 経由でグローバルインストール検索 (dist/index.js を直接実行)
    try {
        const npmRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 5000 }).trim();
        const globalServer = path.join(npmRoot, 'cursor-agent-a2a', 'dist', 'index.js');
        if (existsSync(globalServer)) return globalServer;
    } catch {
        // npm が使えない場合はスキップ
    }

    // 3. pnpm グローバルインストール検索
    try {
        const pnpmRoot = execSync('pnpm root -g 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
        const pnpmServer = path.join(pnpmRoot, 'cursor-agent-a2a', 'dist', 'index.js');
        if (existsSync(pnpmServer)) return pnpmServer;
    } catch {
        // pnpm が使えない場合はスキップ
    }

    // 4. cursor-agent-a2a コマンドを which で検索した結果から実体を推測
    try {
        const result = execSync('which cursor-agent-a2a 2>/dev/null', {
            encoding: 'utf8',
            timeout: 5000,
        }).trim();
        if (result && existsSync(result)) {
            // which で見つかったものは bin スクリプトの可能性があるため、そのまま返す。
            // ただし、直接実行すると install を要求される可能性がある。
            return result;
        }
    } catch {
        // コマンドが見つからない場合はスキップ
    }

    throw new Error(
        '[ServerManager] Could not locate cursor-agent-a2a. \n' +
        'Install locally:  npm install cursor-agent-a2a\n' +
        'Install globally: npm install -g cursor-agent-a2a\n' +
        'Or specify `autoStart.serverPath` in your configuration.'
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
    private servers = new Map<number, ManagedServer>(); // keyed by port
    private cleanupRegistered = false;
    private cleanupHandlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

    private constructor() {}

    static getInstance(): ServerManager {
        if (!ServerManager.instance) {
            ServerManager.instance = new ServerManager();
        }
        return ServerManager.instance;
    }

    async ensureRunning(
        port: number,
        host: string,
        modelId: string,
        config: AutoStartConfig,
        debug: boolean
    ): Promise<() => void> {
        // 既に外部プロセスがリッスンしているか確認
        if (await probePort(port, host)) {
            Logger.info(`Port ${host}:${port} already listening. Skipping auto-start.`);
            return () => {};
        }

        // 既に本マネージャーが管理しているプロセスが存在するか確認
        const existing = this.servers.get(port);
        if (existing) {
            existing.refCount++;
            Logger.info(`Reusing managed CursorAgent server on ${host}:${port} (refCount=${existing.refCount})`);
            return this.makeReleaseFn(port);
        }

        // 新規起動
        const serverPath = resolveServerPath(config.serverPath);
        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            PORT: String(port),
            HOST: host,
            // CURSOR_AGENT_API_KEY が cursor-agent-a2a の正式な認証環境変数
            ...config.env,
        };

        // デフォルトモデルが指定されている場合
        if (modelId) {
            env['CURSOR_DEFAULT_MODEL'] = modelId;
        }

        Logger.info(`Starting cursor-agent-a2a server: ${serverPath} (port=${port}, host=${host}, model=${modelId})`);

        // cursor-agent-a2a CLI コマンドで直接起動を試みる
        // グローバル: cursor-agent-a2a start, またはスクリプト: node <path>
        const args = serverPath.endsWith('.js') || serverPath.endsWith('.mjs')
            ? [serverPath]
            : [];
        const cmd = args.length > 0 ? 'node' : serverPath;

        const proc = spawn(cmd, args, {
            env,
            stdio: debug ? ['ignore', 'pipe', 'pipe'] : 'ignore',
            detached: false,
        });

        if (debug && proc.stdout) {
            proc.stdout.on('data', (d: Buffer) => process.stdout.write(`[CursorAgent-${port}] ${d}`));
        }
        if (debug && proc.stderr) {
            proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[CursorAgent-${port}] ${d}`));
        }

        const entry: ManagedServer = { proc, port, host, refCount: 1 };
        this.servers.set(port, entry);
        this.registerCleanup();

        const pollMs = config.pollIntervalMs ?? 200;
        const timeoutMs = config.startupTimeoutMs ?? 15000;
        try {
            await Promise.race([
                waitForPort(port, host, timeoutMs, pollMs),
                new Promise<void>((_, reject) => {
                    proc.on('error', (err) => reject(new Error(`CursorAgent spawn error: ${err.message}`)));
                    proc.once('exit', (code) => {
                        if (code !== 0 && code !== null) {
                            reject(new Error(`CursorAgent exited early with code ${code}`));
                        }
                    });
                }),
            ]);
        } catch (err) {
            proc.kill();
            this.servers.delete(port);
            throw err;
        }

        proc.once('exit', (code) => {
            Logger.info(`CursorAgent server on port ${port} exited (code=${code})`);
            this.servers.delete(port);
        });

        Logger.info(`CursorAgent server on ${host}:${port} is ready.`);
        return this.makeReleaseFn(port);
    }

    private makeReleaseFn(port: number): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const entry = this.servers.get(port);
            if (!entry) return;
            entry.refCount--;
            Logger.debug(`Released CursorAgent server on port ${port} (refCount=${entry.refCount})`);
            if (entry.refCount <= 0) {
                entry.proc.kill();
                this.servers.delete(port);
            }
        };
    }

    private registerCleanup() {
        if (this.cleanupRegistered) return;
        this.cleanupRegistered = true;

        const exitHandler = () => { try { this.dispose(); } catch { /**/ } };
        const makeSignalHandler = (signal: NodeJS.Signals) => () => {
            Logger.info(`[ServerManager] Received ${signal}, cleaning up...`);
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
