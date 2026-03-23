/**
 * Simple Structured Logger
 */
export const logger = {
    info: (msg: string, context?: Record<string, any>) => {
        console.log(JSON.stringify({ level: 'info', message: msg, ...context, timestamp: new Date().toISOString() }));
    },
    warn: (msg: string, context?: Record<string, any>) => {
        console.warn(JSON.stringify({ level: 'warn', message: msg, ...context, timestamp: new Date().toISOString() }));
    },
    error: (msg: string, context?: Record<string, any>) => {
        console.error(JSON.stringify({ level: 'error', message: msg, ...context, timestamp: new Date().toISOString() }));
    },
    child: (baseContext: Record<string, any>) => ({
        info: (msg: string, context?: Record<string, any>) => logger.info(msg, { ...baseContext, ...context }),
        warn: (msg: string, context?: Record<string, any>) => logger.warn(msg, { ...baseContext, ...context }),
        error: (msg: string, context?: Record<string, any>) => logger.error(msg, { ...baseContext, ...context }),
    })
};
