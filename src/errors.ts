// src/errors.ts

/**
 * CursorCLI が未インストールまたは検出不能な場合に throw するエラー。
 */
export class CursorCLINotFoundError extends Error {
    constructor(message = 'cursor-agent-a2a is not installed or could not be found. Please install it and ensure it is in your PATH.') {
        super(message);
        this.name = 'CursorCLINotFoundError';
    }
}

/**
 * A2A 通信がタイムアウトした場合に throw するエラー。
 */
export class A2ATimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number, endpoint: string) {
        super(`A2A request timed out after ${timeoutMs}ms waiting for cursor-agent-a2a at ${endpoint}`);
        this.name = 'A2ATimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

/**
 * A2A プロトコルレベルのエラー（JSON-RPC エラーレスポンス等）。
 */
export class A2AProtocolError extends Error {
    readonly code: number;
    readonly data?: unknown;
    constructor(code: number, message: string, data?: unknown) {
        super(`A2A Protocol Error [${code}]: ${message}`);
        this.name = 'A2AProtocolError';
        this.code = code;
        this.data = data;
    }
}

/**
 * エラーを OpenCode UI 向けの通知メッセージ文字列に変換する。
 */
export function formatErrorForUI(error: unknown): string {
    if (error instanceof CursorCLINotFoundError) {
        return `⚠️ cursor-agent-a2a Not Found\n\n${error.message}\n\nPlease install cursor-agent-a2a and ensure it is available in PATH, then restart OpenCode.`;
    }
    if (error instanceof A2ATimeoutError) {
        return `⏱️ A2A Connection Timeout\n\n${error.message}\n\nCheck that the cursor-agent-a2a server is running and accessible.`;
    }
    if (error instanceof A2AProtocolError) {
        return `🔴 A2A Protocol Error\n\nCode: ${error.code}\n${error.message}`;
    }
    if (error instanceof Error) {
        // ECONNREFUSED — サーバー未起動の可能性
        if (error.message.includes('ECONNREFUSED') || error.message.includes('Unable to connect')) {
            return `🔴 Cannot Connect to cursor-agent-a2a\n\nFailed to connect to the cursor-agent-a2a server.\nPlease ensure the server is running and the host/port is correctly configured.\n\nDetail: ${error.message}`;
        }
        // 401 / 403 — 認証エラー
        if (error.message.includes('401') || error.message.includes('403') || error.message.includes('Unauthorized')) {
            return `🔒 Authentication Error\n\nFailed to authenticate with cursor-agent-a2a. Check your API token configuration.\n\nDetail: ${error.message}`;
        }
        return `❌ cursor-agent-a2a Error\n\n${error.message}`;
    }
    return `❌ Unknown Error\n\n${String(error)}`;
}
