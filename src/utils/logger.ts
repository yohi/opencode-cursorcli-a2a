// src/utils/logger.ts

/** ログレベル */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_PREFIX = '[opencode-cursorcli-a2a]';

function shouldLog(level: LogLevel): boolean {
    if (level === 'error' || level === 'warn') return true;
    if (level === 'info') return !!process.env['DEBUG_OPENCODE'] || !!process.env['CURSOR_A2A_VERBOSE'];
    if (level === 'debug') return !!process.env['DEBUG_OPENCODE'];
    return false;
}

function safeStringify(value: any): string {
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, (_key, val) => {
            if (typeof val === 'bigint') return val.toString();
            if (val instanceof Error) {
                const { message, name, stack, ...rest } = val;
                return { message, name, stack, ...rest };
            }
            if (typeof val === 'object' && val !== null) {
                if (seen.has(val)) return '[Circular]';
                seen.add(val);
            }
            return val;
        });
    } catch {
        try {
            return String(value);
        } catch {
            return '[Unserializable]';
        }
    }
}

function extractContext(...args: any[]): Record<string, any> {
    if (args.length === 0) return {};
    if (args.length === 1) {
        const arg = args[0];
        if (arg instanceof Error) {
            return { error: arg };
        }
        if (typeof arg === 'object' && arg !== null && !Array.isArray(arg)) {
            return arg;
        }
    }
    return { args };
}

export const logger = {
    debug: (msg: string, ...args: any[]) => {
        if (!shouldLog('debug')) return;
        const context = extractContext(...args);
        console.debug(safeStringify({ ...context, level: 'debug', prefix: LOG_PREFIX, message: msg, timestamp: new Date().toISOString() }));
    },
    info: (msg: string, ...args: any[]) => {
        if (!shouldLog('info')) return;
        const context = extractContext(...args);
        console.info(safeStringify({ ...context, level: 'info', prefix: LOG_PREFIX, message: msg, timestamp: new Date().toISOString() }));
    },
    warn: (msg: string, ...args: any[]) => {
        if (!shouldLog('warn')) return;
        const context = extractContext(...args);
        console.warn(safeStringify({ ...context, level: 'warn', prefix: LOG_PREFIX, message: msg, timestamp: new Date().toISOString() }));
    },
    error: (msg: string, ...args: any[]) => {
        if (!shouldLog('error')) return;
        const context = extractContext(...args);
        console.error(safeStringify({ ...context, level: 'error', prefix: LOG_PREFIX, message: msg, timestamp: new Date().toISOString() }));
    },
    child: (baseContext: Record<string, any>) => ({
        debug: (msg: string, context?: Record<string, any>) => logger.debug(msg, { ...baseContext, ...context }),
        info: (msg: string, context?: Record<string, any>) => logger.info(msg, { ...baseContext, ...context }),
        warn: (msg: string, context?: Record<string, any>) => logger.warn(msg, { ...baseContext, ...context }),
        error: (msg: string, context?: Record<string, any>) => logger.error(msg, { ...baseContext, ...context }),
    })
};

// a2a-client.ts などのために Logger (大文字) もエクスポート
export const Logger = logger;
