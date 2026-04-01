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
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

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
    private async resolveProjectId(workspace: string = process.cwd(), abortSignal?: AbortSignal): Promise<string> {
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
            const response = await ofetch(`${this.baseUrl}/projects`, { headers, retry: 1, signal: abortSignal });
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
                body: { name: projectName, workspace },
                signal: abortSignal
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
                url: `${this.baseUrl}/:projectId/messages?stream=true`,
                requestBodyValues: request,
                isRetryable: false,
            });
        }

        try {
            const effectiveWorkspace = request.context?.workspace || workspace || process.cwd();
            const projectId = await this.resolveProjectId(effectiveWorkspace, abortSignal);
            
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
            Logger.info(`POST ${url}`, JSON.stringify(redactedRequest));

            const response = await ofetch.raw(url, {
                method: 'POST',
                headers,
                body: request,
                signal: abortSignal,
                retry: retryCount,
                retryDelay: 1000,
                // AI SDK はストリームを期待している
                responseType: 'stream',
                // ofetch のエラーハンドリングを無効化して自前で APICallError に包む
                ignoreResponseError: true,
            });

            const status = response.status;
            if (status >= 400) {
                const errMsg = `HTTP error ${status}: ${response.statusText}`;
                Logger.warn(`[A2AClient] ${errMsg} at ${url}`);
                
                if (errMsg.includes('ECONNREFUSED') || status === 503) {
                    Logger.warn(
                        `cursor-agent-a2a server connection refused at ${url}. ` +
                        `Is the server running? Try: cursor-agent-a2a start --port ${this.config.port}`
                    );
                }

                throw new APICallError({
                    message: errMsg,
                    url,
                    requestBodyValues: request,
                    statusCode: status,
                    isRetryable: RETRY_STATUS_CODES.includes(status),
                });
            }

            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
            });

            return {
                stream: response._data as ReadableStream<Uint8Array>,
                status,
                headers: responseHeaders,
            };
        } catch (error) {
            if (error instanceof APICallError) throw error;

            const errMsg = error instanceof Error ? error.message : String(error);
            const isRetryable = error instanceof FetchError && 
                (error.status !== undefined && RETRY_STATUS_CODES.includes(error.status));

            if (errMsg.includes('ECONNREFUSED')) {
                Logger.warn(
                    `cursor-agent-a2a server connection refused. ` +
                    `Is the server running? Try: cursor-agent-a2a start --port ${this.config.port}`
                );
            }

            throw new APICallError({
                message: errMsg,
                url: `${this.baseUrl}/:projectId/messages?stream=true`,
                requestBodyValues: request,
                cause: error,
                isRetryable,
            });
        }
    }
}
