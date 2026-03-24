/**
 * Simple Structured Logger
 */

function safeStringify(value: any): string {
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, (_key, val) => {
            if (typeof val === 'bigint') return val.toString();
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

export const logger = {
    info: (msg: string, context?: Record<string, any>) => {
        console.log(safeStringify({ ...context, level: 'info', message: msg, timestamp: new Date().toISOString() }));
    },
    warn: (msg: string, context?: Record<string, any>) => {
        console.warn(safeStringify({ ...context, level: 'warn', message: msg, timestamp: new Date().toISOString() }));
    },
    error: (msg: string, context?: Record<string, any>) => {
        console.error(safeStringify({ ...context, level: 'error', message: msg, timestamp: new Date().toISOString() }));
    },
    child: (baseContext: Record<string, any>) => ({
        info: (msg: string, context?: Record<string, any>) => logger.info(msg, { ...baseContext, ...context }),
        warn: (msg: string, context?: Record<string, any>) => logger.warn(msg, { ...baseContext, ...context }),
        error: (msg: string, context?: Record<string, any>) => logger.error(msg, { ...baseContext, ...context }),
    })
};
