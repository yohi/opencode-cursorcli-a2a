// src/config.ts
import { z } from 'zod';
import { ConfigSchema, type A2AConfig, type AgentEndpoint, AgentEndpointSchema } from './schemas.js';
import type { SessionStore } from './session.js';
import type { FallbackConfig } from './fallback.js';
import { readFileSync, watch, existsSync } from 'node:fs';
import path from 'node:path';
import { logger as Logger } from './utils/logger.js';

// ---------------------------------------------------------------------------
// CursorCLI 固有のコンテキスト設定
// ---------------------------------------------------------------------------
export interface CursorContextConfig {
    /** アクティブファイルパスをペイロードに含めるか (デフォルト: true) */
    includeActiveFile?: boolean;
    /** 選択コードスニペットをペイロードに含めるか (デフォルト: true) */
    includeSelectedCode?: boolean;
    /** ワークスペースルートをペイロードに含めるか (デフォルト: true) */
    includeWorkspaceRoot?: boolean;
    /** ユーザーインテント（カスタムプロンプト前置き） */
    userIntent?: string;
}

// ---------------------------------------------------------------------------
// エージェント固有のトリガー設定
// ---------------------------------------------------------------------------
export interface AgentTriggerConfig {
    /** このトリガー設定を適用するモデルID */
    modelId: string;
    /**
     * A2A リクエストを送信するトリガー条件。
     * 'always': 常にこのエージェントへ送信
     * 'keyword': キーワードが含まれている場合のみ
     * 'manual': ユーザーが明示的に選択した場合のみ
     */
    trigger: 'always' | 'keyword' | 'manual';
    /** trigger が 'keyword' の場合に使用するキーワードリスト */
    keywords?: string[];
    /** このエージェントに送る際のカスタムシステムプロンプト追加文 */
    systemPromptAddendum?: string;
}

// ---------------------------------------------------------------------------
// プロバイダーオプション
// ---------------------------------------------------------------------------
export interface OpenCodeProviderOptions {
    host?: string;
    port?: number;
    token?: string;
    protocol?: 'http' | 'https';
    sessionStore?: SessionStore;
    /**
     * cursor-agent-a2a に渡す Cursor モデル名（最高優先度）。
     * 例: "auto", "claude-4.6-sonnet-medium", "gpt-5.4-high"
     * 未指定時はサーバー側の CURSOR_DEFAULT_MODEL → "auto" にフォールバック。
     * モデル ID に cursor-agent-a2a のモデル名を埋め込む場合は省略可。
     */
    cursorModel?: string;
    /**
     * CursorAgent が操作するデフォルトワークスペースパス。
     * セッションの最初のリクエストで `context.workspace` に設定される。
     * 未指定時は process.cwd() を使用。
     */
    workspace?: string;
    /** モデル生成パラメータ */
    generationConfig?: {
        temperature?: number;
        topP?: number;
        topK?: number;
        maxOutputTokens?: number;
        stopSequences?: string[];
        presencePenalty?: number;
        frequencyPenalty?: number;
        seed?: number;
        responseFormat?: unknown;
    };
    /**
     * ツール名マッピング (OpenCode → CursorAgent サーバー名)
     * 例: { "read_file": "read", "run_shell_command": "bash" }
     */
    toolMapping?: Record<string, string>;
    /** 自動承認する内部ツールリスト (OpenCode 側には公開しない) */
    internalTools?: string[];
    /** カスタムモデルレジストリ */
    modelRegistry?: unknown;
    /** エラー時フォールバック設定 */
    fallback?: Partial<FallbackConfig>;
    /** マルチエージェント構成 */
    agents?: AgentEndpoint[];
    /** cursor-agent-a2a サーバー自動起動設定 */
    autoStart?: Partial<import('./server-manager.js').AutoStartConfig>;
    /** 外部設定ファイルパス */
    configPath?: string;
    /** ホットリロードを有効にするか */
    hotReload?: boolean;
    /**
     * エージェント固有のトリガー設定リスト。
     * OpenCode 設定 UI からユーザーが構成できる。
     */
    triggerConfig?: AgentTriggerConfig[];
    /**
     * CursorCLI 向けのコンテキスト設定。
     * ペイロードに含める動的コンテキスト（ファイルパス、選択コード等）を制御する。
     */
    contextConfig?: CursorContextConfig;
}

// ---------------------------------------------------------------------------
// 外部設定ファイルのスキーマ
// ---------------------------------------------------------------------------
const ExternalConfigSchema = z.object({
    host: z.string().optional(),
    port: z.number().optional(),
    token: z.string().optional(),
    protocol: z.enum(['http', 'https']).optional(),
    /** cursor-agent-a2a に渡す Cursor モデル名 */
    cursorModel: z.string().optional(),
    /** CursorAgent のデフォルトワークスペースパス */
    workspace: z.string().optional(),
    agents: z.array(AgentEndpointSchema).optional(),
    toolMapping: z.record(z.string()).optional(),
    internalTools: z.array(z.string()).optional(),
    triggerConfig: z.array(z.object({
        modelId: z.string(),
        trigger: z.enum(['always', 'keyword', 'manual']),
        keywords: z.array(z.string()).optional(),
        systemPromptAddendum: z.string().optional(),
    })).optional(),
    contextConfig: z.object({
        includeActiveFile: z.boolean().optional(),
        includeSelectedCode: z.boolean().optional(),
        includeWorkspaceRoot: z.boolean().optional(),
        userIntent: z.string().optional(),
    }).optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// ConfigManager — シングルトン
// ---------------------------------------------------------------------------
export class ConfigManager {
    private static instance: ConfigManager | undefined;
    private externalConfig: z.infer<typeof ExternalConfigSchema> = {};
    private configPath: string = path.resolve(process.cwd(), 'cursor-a2a-config.json');
    private watchers: Set<() => void> = new Set();
    private isWatching: boolean = false;
    private configWatcher: import('node:fs').FSWatcher | null = null;
    private _changeTimer: NodeJS.Timeout | null = null;

    private constructor() {
        this.load();
    }

    static getInstance(): ConfigManager {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager();
        }
        return ConfigManager.instance;
    }

    public setConfigPath(p: string): void {
        const newPath = path.resolve(p);
        if (this.configPath !== newPath) {
            this.stopWatch();
            this.configPath = newPath;
            this.load();
        }
    }

    public getExternalConfig() {
        return this.externalConfig;
    }

    public load(): void {
        if (!existsSync(this.configPath)) return;
        try {
            const content = readFileSync(this.configPath, 'utf8');
            const parsed = JSON.parse(content);
            const validated = ExternalConfigSchema.parse(parsed);
            this.externalConfig = validated;
            Logger.info(`[ConfigManager] Loaded config from ${this.configPath}`);
        } catch (err) {
            Logger.error(`[ConfigManager] Failed to load config from ${this.configPath}:`, err);
        }
    }

    public watch(enable: boolean): void {
        if (!enable) {
            this.stopWatch();
            return;
        }
        if (this.isWatching || !existsSync(this.configPath)) return;
        this.isWatching = true;
        try {
            this.configWatcher = watch(this.configPath, (event) => {
                if (event === 'change' || event === 'rename') {
                    if (this._changeTimer) clearTimeout(this._changeTimer);
                    
                    const fileExists = existsSync(this.configPath);
                    
                    this._changeTimer = setTimeout(() => {
                        Logger.info(`[ConfigManager] Config file ${event}, reloading...`);
                        
                        let loadSuccess = false;
                        try {
                            // If it's a rename and the file doesn't exist, we skip load to avoid errors
                            if (event !== 'rename' || fileExists || existsSync(this.configPath)) {
                                this.load();
                                loadSuccess = true;
                            }
                        } catch (err) {
                            Logger.error(`[ConfigManager] Error during config reload:`, err);
                        }

                        if (event === 'rename') {
                            if (loadSuccess && existsSync(this.configPath)) {
                                this.stopWatch();
                                // wait slightly before re-watching to avoid loops
                                setTimeout(() => this.watch(true), 50);
                            } else {
                                this.stopWatch();
                            }
                        }
                        
                        if (loadSuccess) {
                            for (const cb of this.watchers) cb();
                        }
                    }, 300);
                }
            });
        } catch (err) {
            Logger.error(`[ConfigManager] Failed to watch config file:`, err);
            this.isWatching = false;
        }
    }

    public stopWatch(): void {
        if (this._changeTimer) { clearTimeout(this._changeTimer); this._changeTimer = null; }
        if (this.configWatcher) { this.configWatcher.close(); this.configWatcher = null; }
        this.isWatching = false;
    }

    public dispose(): void {
        this.stopWatch();
        this.watchers.clear();
        if (ConfigManager.instance === this) {
            ConfigManager.instance = undefined;
        }
    }

    static disposeIfExists(): void {
        ConfigManager.instance?.dispose();
        ConfigManager.instance = undefined;
    }

    public onChange(cb: () => void): () => void {
    this.watchers.add(cb);
    return () => this.watchers.delete(cb);
}
}

// ---------------------------------------------------------------------------
// ユーティリティ: 空文字・"null"・"undefined" 文字列を undefined 化
// ---------------------------------------------------------------------------
function getNormalizedValue(val: string | null | undefined): string | undefined {
if (typeof val !== 'string') return undefined;
const trimmed = val.trim();
if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') return undefined;
return trimmed;
}

const parseSchema = z.object({
    host: z.string().optional(),
    port: z.coerce.number().int().refine(n => Number.isFinite(n) && n > 0 && n <= 65535, 'invalid port').optional(),
    token: z.string().optional(),
    protocol: z.enum(['http', 'https']).optional(),
    generationConfig: z.object({
        temperature: z.coerce.number().optional(),
        topP: z.coerce.number().optional(),
        topK: z.coerce.number().optional(),
        maxOutputTokens: z.coerce.number().int().optional(),
        stopSequences: z.array(z.string()).optional(),
        presencePenalty: z.coerce.number().optional(),
        frequencyPenalty: z.coerce.number().optional(),
        seed: z.coerce.number().int().optional(),
        responseFormat: z.unknown().optional(),
    }).optional(),
});

/** CursorCLI 向けデフォルトツールマッピング */
const DEFAULT_TOOL_MAPPING: Record<string, string> = {
    'read_file': 'read_file',
    'write_file': 'write_file',
    'run_shell_command': 'run_terminal_command',
    'bash': 'run_terminal_command',
    'list_directory': 'list_dir',
    'search_files': 'codebase_search',
    'edit_file': 'edit_file',
    'run_terminal_command': 'run_terminal_command',
    'codebase_search': 'codebase_search',
};

export function resolveConfig(options?: OpenCodeProviderOptions): A2AConfig & {
    generationConfig?: OpenCodeProviderOptions['generationConfig'];
    toolMapping?: Record<string, string>;
    internalTools?: string[];
    agents?: AgentEndpoint[];
    triggerConfig?: AgentTriggerConfig[];
    contextConfig?: CursorContextConfig;
    cursorModel?: string;
    workspace?: string;
} {
    const manager = ConfigManager.getInstance();
    if (options?.configPath) manager.setConfigPath(options.configPath);
    if (options?.hotReload) manager.watch(true);

    const external = manager.getExternalConfig() as z.infer<typeof ExternalConfigSchema>;

    const envHost = getNormalizedValue(process.env['CURSOR_A2A_HOST']);
    const envPortRaw = getNormalizedValue(process.env['CURSOR_A2A_PORT'] ?? process.env['PORT']);
    const envPort = envPortRaw ? Number(envPortRaw) : undefined;
    // cursor-agent-a2a の認証トークン (CURSOR_AGENT_API_KEY が正式)
    const envToken = getNormalizedValue(
        process.env['CURSOR_AGENT_API_KEY'] ?? process.env['CURSOR_A2A_TOKEN']
    );
    const envProtocol = getNormalizedValue(process.env['CURSOR_A2A_PROTOCOL']);
    const envCursorModel = getNormalizedValue(process.env['CURSOR_DEFAULT_MODEL']);
    const envWorkspace = getNormalizedValue(process.env['CURSOR_A2A_WORKSPACE']);

    const mergedConfig = {
        host: getNormalizedValue(options?.host) ?? external.host ?? envHost,
        port: options?.port ?? external.port ?? envPort,
        token: getNormalizedValue(options?.token) ?? external.token ?? envToken,
        protocol: (getNormalizedValue(options?.protocol) ?? external.protocol ?? envProtocol) as 'http' | 'https' | undefined,
        generationConfig: options?.generationConfig,
    };

    const parsedData = parseSchema.parse(mergedConfig);
    const baseConfig = ConfigSchema.parse(parsedData);

    return {
        ...baseConfig,
        generationConfig: parsedData.generationConfig,
        toolMapping: {
            ...DEFAULT_TOOL_MAPPING,
            ...external.toolMapping,
            ...options?.toolMapping,
        },
        internalTools: options?.internalTools ?? external.internalTools,
        agents: options?.agents ?? external.agents,
        triggerConfig: options?.triggerConfig ?? external.triggerConfig,
        contextConfig: options?.contextConfig ?? external.contextConfig,
        cursorModel: getNormalizedValue(options?.cursorModel) ?? external.cursorModel ?? envCursorModel,
        workspace: getNormalizedValue(options?.workspace) ?? external.workspace ?? envWorkspace,
    };
}
