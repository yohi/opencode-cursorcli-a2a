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

function formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
    const ts = new Date().toISOString();
    const extra = args.length > 0 ? ' ' + args.map(a =>
        a instanceof Error ? `${a.message}${a.stack ? '\n' + a.stack : ''}` : JSON.stringify(a)
    ).join(' ') : '';
    return `${ts} ${LOG_PREFIX} [${level.toUpperCase()}] ${message}${extra}`;
}

export const Logger = {
    debug(message: string, ...args: unknown[]): void {
        if (shouldLog('debug')) console.debug(formatMessage('debug', message, ...args));
    },
    info(message: string, ...args: unknown[]): void {
        if (shouldLog('info')) console.info(formatMessage('info', message, ...args));
    },
    warn(message: string, ...args: unknown[]): void {
        if (shouldLog('warn')) console.warn(formatMessage('warn', message, ...args));
    },
    error(message: string, ...args: unknown[]): void {
        if (shouldLog('error')) console.error(formatMessage('error', message, ...args));
    },
};
