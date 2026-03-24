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
        const onAbortOuter = () => {
            Logger.warn(`[A2AClient] Request aborted by client signal during execution! Reason: ${abortSignal?.reason}`);
        };
        if (abortSignal) {
            if (abortSignal.aborted) {
                Logger.warn(`[A2AClient] Signal already aborted before fetch! Reason: ${abortSignal.reason}`);
                throw abortSignal.reason || new Error('AbortError');
            }
            abortSignal.addEventListener('abort', onAbortOuter, { once: true });
        }

        const finalTraceId = traceId || crypto.randomUUID();
        const token = this.getToken();
        const isSecure = this.isSecureEndpoint();

        if (token && !isSecure) {
            if (abortSignal) abortSignal.removeEventListener('abort', onAbortOuter);
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
            
            // resolveProjectId の後にアボートされていないか再チェック
            if (abortSignal?.aborted) {
                throw abortSignal.reason || new Error('AbortError');
            }

            const url = `${this.baseUrl}/${projectId}/messages?stream=true`;

            // 変数宣言 (指摘の順序: headers -> retryCount -> error-tracking locals)
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
            
            let lastError: Error | undefined = undefined;
            let statusCode: number | undefined = undefined;
            let responseBody: string | undefined = undefined;

            const redactedRequest = {
                model: request.model ?? '(default)',
                traceId: finalTraceId,
                workspace: effectiveWorkspace,
                messageLength: request.message.length,
                selectedCodeLength: request.context?.selectedCode?.length ?? 0
            };
            Logger.info(`POST ${url}`, JSON.stringify(redactedRequest));

            for (let attempt = 0; attempt <= retryCount; attempt++) {
                // リトライ開始前にアボートされていないかチェック
                if (abortSignal?.aborted) {
                    throw abortSignal.reason || new Error('AbortError');
                }

                try {
                    const response = await new Promise<ChatStreamResponse>((resolve, reject) => {
                        const parsedUrl = new URL(url);
                        const client = parsedUrl.protocol === 'https:' ? https : http;
                        const requestBody = JSON.stringify(request);
                        const reqOptions = {
                            method: 'POST',
                            headers: {
                                ...headers,
                                'Content-Length': Buffer.byteLength(requestBody)
                            },
                        };

                        const req = client.request(parsedUrl, reqOptions, (res) => {
                            clearTimeout(connectTimer);
                            const status = res.statusCode || 500;
                            Logger.info(`Response ${status} ${res.statusMessage}`);

                            if (status >= 400) {
                                let body = '';
                                res.on('data', chunk => { body += chunk; });
                                res.on('end', () => {
                                    const err = new Error(`HTTP error ${status}: ${res.statusMessage}`);
                                    (err as any).status = status;
                                    (err as any).body = body;
                                    reject(err);
                                });
                                return;
                            }

                            const responseHeaders: Record<string, string> = {};
                            for (const [key, value] of Object.entries(res.headers)) {
                                if (Array.isArray(value)) {
                                    responseHeaders[key] = value.join(', ');
                                } else if (value) {
                                    responseHeaders[key] = value;
                                }
                            }

                            const stream = new ReadableStream<Uint8Array>({
                                start(controller) {
                                    const onAbortReq = () => {
                                        res.destroy();
                                    };
                                    res.on('data', chunk => controller.enqueue(chunk));
                                    res.on('end', () => {
                                        abortSignal?.removeEventListener('abort', onAbortReq);
                                        controller.close();
                                    });
                                    res.on('error', err => {
                                        abortSignal?.removeEventListener('abort', onAbortReq);
                                        controller.error(err);
                                    });
                                    if (abortSignal) {
                                        abortSignal.addEventListener('abort', onAbortReq, { once: true });
                                    }
                                },
                                cancel() {
                                    res.destroy();
                                }
                            });

                            resolve({
                                stream,
                                status,
                                headers: responseHeaders
                            });
                        });

                        const onAbortReq = () => {
                            clearTimeout(connectTimer);
                            req.destroy(new Error('AbortError'));
                        };

                        // 接続確立 (TTFB) までのタイムアウト
                        const connectTimer = setTimeout(() => {
                            req.destroy(new Error('TimeoutError'));
                            reject(new Error('TimeoutError'));
                        }, 30000);

                        req.on('error', err => {
                            clearTimeout(connectTimer);
                            abortSignal?.removeEventListener('abort', onAbortReq);
                            reject(err);
                        });

                        if (abortSignal) {
                            abortSignal.addEventListener('abort', onAbortReq, { once: true });
                        }

                        req.write(requestBody);
                        req.end();
                    });

                    return response;
                } catch (error) {
                    if (error instanceof APICallError) throw error;
                    lastError = error as Error;
                    
                    statusCode = (error as any).status;
                    responseBody = (error as any).body;
                    const errorCode = (error as any).cause?.code || (error as any).code || (error instanceof Error && (error.message === 'AbortError' || error.message === 'TimeoutError') ? error.message : undefined);
                    
                    const isTransient = 
                        (statusCode !== undefined && RETRY_STATUS_CODES.includes(statusCode)) ||
                        (errorCode !== undefined && ['ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'TimeoutError'].includes(errorCode));

                    if (isTransient && attempt < retryCount) {
                        Logger.warn(`Retrying request due to network error/status ${statusCode || errorCode} (attempt ${attempt + 1}/${retryCount})`);
                        
                        // アボート可能なバックオフ待機
                        await new Promise<void>((resolveWait, rejectWait) => {
                            const timer = setTimeout(() => {
                                if (abortSignal) abortSignal.removeEventListener('abort', onAbortWait);
                                resolveWait();
                            }, 1000);

                            const onAbortWait = () => {
                                clearTimeout(timer);
                                rejectWait(abortSignal?.reason || new Error('AbortError'));
                            };

                            if (abortSignal) {
                                abortSignal.addEventListener('abort', onAbortWait, { once: true });
                            }
                        });
                        continue;
                    }

                    const errMsg = error instanceof Error ? error.message : String(error);
                    if (errMsg.includes('ECONNREFUSED')) {
                        Logger.warn(
                            `cursor-agent-a2a server connection refused at ${url}. ` +
                            `Is the server running? Try: cursor-agent-a2a start --port ${this.config.port}`
                        );
                    }

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
            throw lastError || new Error('Unknown error during fetch');
        } finally {
            if (abortSignal) {
                abortSignal.removeEventListener('abort', onAbortOuter);
            }
        }
    }
}
