// src/a2a-client.ts
// cursor-agent-a2a (https://github.com/jeffkit/cursor-agent-a2a) REST API クライアント
import { ofetch, FetchError } from 'ofetch';
import { APICallError } from '@ai-sdk/provider';
import type { A2AConfig } from './schemas.js';
import { type CursorAgentMessageRequest } from './schemas.js';
import { Logger } from './utils/logger.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RETRY_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504];

export interface ChatStreamOptions {
    /** cursor-agent-a2a REST API リクエストボディ */
    request: CursorAgentMessageRequest;
    idempotencyKey?: string;
    abortSignal?: AbortSignal;
    traceId?: string;
    workspace?: string;
}

export interface ChatStreamResponse {
    stream: ReadableStream<Uint8Array>;
    status: number;
    headers: Record<string, string>;
}

/**
 * cursor-agent-a2a サーバーの REST API クライアント。
 *
 * - ストリーミング: `POST /messages?stream=true`（Accept: text/event-stream）
 * - モデル指定: リクエストボディの `model` フィールド（最高優先度）
 * - 認証: `Authorization: Bearer <api-key>`
 * - デフォルトポート: 4937
 */
export class A2AClient {
    private config: A2AConfig;
    private baseUrl: string;
    private resolvedToken: string | undefined;

    constructor(config: A2AConfig) {
        this.config = config;
        const hostPart = (config.host.includes(':') && !config.host.startsWith('[')) 
            ? `[${config.host}]` 
            : config.host;
        this.baseUrl = `${config.protocol ?? 'http'}://${hostPart}:${config.port}`;
    }

    private isSecureEndpoint(): boolean {
        const isSecure = this.baseUrl.startsWith('https://');
        const normalizedHost = this.config.host.replace(/^\[|\]$/g, '');
        // 0.0.0.0 is excluded for security reasons
        const isLocalhost = normalizedHost === '127.0.0.1' || normalizedHost === 'localhost' || normalizedHost === '::1';
        return isSecure || isLocalhost;
    }

    private getToken(): string | undefined {
        if (this.resolvedToken) return this.resolvedToken;
        
        if (this.config.token) {
            this.resolvedToken = this.config.token;
            return this.resolvedToken;
        }

        // 1. 環境変数
        if (process.env['CURSOR_AGENT_API_KEY']) {
            this.resolvedToken = process.env['CURSOR_AGENT_API_KEY'];
            return this.resolvedToken;
        }

        // 2. 設定ファイル (~/.cursor-agent-a2a/config.json)
        try {
            const configPath = path.join(os.homedir(), '.cursor-agent-a2a', 'config.json');
            if (fs.existsSync(configPath)) {
                const configContent = fs.readFileSync(configPath, 'utf8');
                const config = JSON.parse(configContent);
                if (typeof config.apiKey === 'string') {
                    this.resolvedToken = config.apiKey;
                    return this.resolvedToken;
                }
            }
        } catch (e) {
            Logger.warn('[A2AClient] Failed to read cursor-agent-a2a config.json', e);
        }

        // 3. フォールバックなし (Security gate を正しく機能させるため)
        return undefined;
    }

    /** `/projects` エンドポイントを使用して projectId を取得または作成する */
    private async resolveProjectId(workspace: string = process.cwd()): Promise<string> {
        const token = this.getToken();
        const isSecure = this.isSecureEndpoint();

        if (token && !isSecure) {
            throw new APICallError({
                message: 'A2AClient: Token cannot be sent over an insecure non-localhost connection.',
                url: `${this.baseUrl}/projects`,
                isRetryable: false,
            });
        }

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        
        if (token && isSecure) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            // 1. 既存のプロジェクト一覧を取得して一致する workspace を探す
            const response = await ofetch(`${this.baseUrl}/projects`, { headers, retry: 1 });
            const projects = response.projects || [];
            const existing = projects.find((p: any) => p.workspace === workspace);
            if (existing) {
                return existing.id;
            }

            // 2. 存在しなければ新しく作成する
            const projectName = `opencode-${crypto.randomBytes(4).toString('hex')}`;
            const createRes = await ofetch(`${this.baseUrl}/projects`, {
                method: 'POST',
                headers,
                body: { name: projectName, workspace }
            });
            return createRes.id;
        } catch (error) {
            Logger.warn('[A2AClient] Failed to resolve or create project ID. Falling back to "default":', {
                message: error instanceof Error ? error.message : String(error)
            });
            // サーバー起動直後や DB アクセスエラーなどの場合のフォールバック（動作しない可能性が高いが念のため）
            return 'default';
        }
    }

    /** `/:projectId/messages?stream=true` エンドポイントにストリーミングリクエストを送信する */
    async chatStream({ request, idempotencyKey, abortSignal, traceId, workspace }: ChatStreamOptions): Promise<ChatStreamResponse> {
        const finalTraceId = traceId || crypto.randomUUID();
        const token = this.getToken();
        const isSecure = this.isSecureEndpoint();

        if (token && !isSecure) {
            throw new APICallError({
                message: 'A2AClient: Token cannot be sent over an insecure non-localhost connection.',
                url: `${this.baseUrl}/(projectId)/messages?stream=true`,
                requestBodyValues: request,
                isRetryable: false,
            });
        }

        const effectiveWorkspace = request.context?.workspace || workspace || process.cwd();
        const projectId = await this.resolveProjectId(effectiveWorkspace);
        const url = `${this.baseUrl}/${projectId}/messages?stream=true`;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'x-a2a-trace-id': finalTraceId,
        };

        if (idempotencyKey) {
            headers['Idempotency-Key'] = idempotencyKey;
        }

        if (token && isSecure) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const retryCount = idempotencyKey ? 3 : 0;

        const redactedRequest = {
            model: request.model ?? '(default)',
            traceId: finalTraceId,
            workspace: effectiveWorkspace,
            messageLength: request.message.length,
            selectedCodeLength: request.context?.selectedCode?.length ?? 0
        };
        Logger.debug(`POST ${url}`, JSON.stringify(redactedRequest));

        try {
            const response = await ofetch.raw(url, {
                method: 'POST',
                headers,
                body: request,
                retry: retryCount,
                retryDelay: 1000,
                retryStatusCodes: RETRY_STATUS_CODES,
                signal: abortSignal,
                ignoreResponseError: true,
                responseType: 'stream',
            });

            Logger.debug(`Response ${response.status} ${response.statusText}`);

            if (!response.ok) {
                throw new APICallError({
                    message: `HTTP error ${response.status}: ${response.statusText}`,
                    url,
                    requestBodyValues: request,
                    statusCode: response.status,
                    isRetryable: RETRY_STATUS_CODES.includes(response.status),
                });
            }

            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => { responseHeaders[key] = value; });

            return {
                stream: response._data as ReadableStream<Uint8Array>,
                status: response.status,
                headers: responseHeaders,
            };
        } catch (error) {
            if (error instanceof APICallError) throw error;

            let statusCode: number | undefined;
            let responseBody: string | undefined;
            let errorCode: string | undefined;

            if (error instanceof FetchError) {
                statusCode = error.response?.status;
                errorCode = (error as any).code;
                try { responseBody = await error.response?.text(); } catch { /**/ }
            } else if (error instanceof Error) {
                errorCode = (error as any).code;
            }

            const errMsg = error instanceof Error ? error.message : String(error);

            // cursor-agent-a2a が未インストールまたはサーバー未起動の判定
            if (errMsg.includes('ECONNREFUSED')) {
                Logger.warn(
                    `cursor-agent-a2a server connection refused at ${url}. ` +
                    `Is the server running? Try: cursor-agent-a2a start --port ${this.config.port}`
                );
            }

            const isTransient = statusCode 
                ? RETRY_STATUS_CODES.includes(statusCode)
                : (errorCode ? ['ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET'].includes(errorCode) : false);

            throw new APICallError({
                message: errMsg,
                url,
                requestBodyValues: request,
                statusCode,
                responseBody,
                cause: error,
                isRetryable: isTransient,
            });
        }
    }
}
