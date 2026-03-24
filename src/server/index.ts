/**
 * Internal A2A Server for Cursor Agent
 * 
 * This server provides an A2A-compatible REST API for the Cursor Agent.
 * It uses the internal cursor-agent-service with native "thinking" support.
 */

import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { executeCursorAgentStream } from './cursor-agent-service.js';
import { logger } from '../utils/logger.js';

const app = express();
const PORT = Number(process.env['PORT']) || 4937;
const HOST = process.env['HOST'] || '127.0.0.1';
const ALLOWED_ORIGINS = process.env['ALLOWED_ORIGINS']?.split(',') || ['http://localhost:3000'];
const AUTH_TOKEN = process.env['A2A_AUTH_TOKEN'];

app.use(cors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));
app.use(express.json());

// Simple Auth Middleware
const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!AUTH_TOKEN) {
        return next();
    }
    
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logger.warn('Auth failed: Missing or invalid authorization header');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const providedToken = authHeader.substring(7); // "Bearer " is length 7
    
    // Timing-safe comparison
    try {
        const expectedBuffer = Buffer.from(AUTH_TOKEN, 'utf8');
        const providedBuffer = Buffer.from(providedToken, 'utf8');

        if (expectedBuffer.length === providedBuffer.length && 
            crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
            return next();
        }
    } catch (e) {
        logger.error('Error during token comparison', e);
    }

    logger.warn('Auth failed: Invalid token provided');
    res.status(401).json({ error: 'Unauthorized' });
};

// Health check
app.get('/health', (_req: express.Request, res: express.Response) => {
    res.json({
        status: 'ok',
        service: 'opencode-cursor-a2a-internal',
        timestamp: new Date().toISOString()
    });
});

/**
 * Projects API (Mock for A2A compatibility)
 */
const projects: Array<{ id: string; workspace: string; name: string }> = [
    { id: 'default', workspace: process.cwd(), name: 'default' }
];

app.get('/projects', authMiddleware, (_req: express.Request, res: express.Response) => {
    res.json({ projects });
});

app.post('/projects', authMiddleware, (req: express.Request, res: express.Response) => {
    const { name, workspace } = req.body;
    if (typeof workspace !== 'string' || workspace.trim().length === 0) {
        return res.status(400).json({ error: 'Missing or invalid workspace' });
    }
    const id = `p-${crypto.randomBytes(4).toString('hex')}`;
    const newProject = { id, workspace, name: name || id };
    projects.push(newProject);
    res.json(newProject);
});

// A2A Messages Endpoint (Streaming)
app.post('/:projectId/messages', authMiddleware, async (req: express.Request, res: express.Response) => {
    const { message, sessionId, model } = req.body;
    const { projectId } = req.params;
    const stream = req.query.stream === 'true' || req.headers.accept === 'text/event-stream';

    logger.info('Processing request', { projectId, sessionId: sessionId || 'new', stream });

    if (!message) {
        return res.status(400).json({ error: 'Missing message' });
    }

    const project = projects.find(p => p.id === projectId);
    if (!project) {
        return res.status(404).json({ error: `Project not found: ${projectId}` });
    }
    const workspace = project.workspace;
    let capturedSessionId = sessionId;

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.flushHeaders();
        
        // SSE Preamble/Ping to stabilize the stream for some clients (like undici/fetch)
        res.write(': connected\n\n');

        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded) {
                logger.warn('Response connection closed prematurely by client, aborting agent', { projectId, sessionId });
                controller.abort();
            }
        });

        try {
            await executeCursorAgentStream(message, { workspace, sessionId, model, signal: controller.signal }, (event) => {
                if (event.sessionId) capturedSessionId = event.sessionId;
                const chunk = `data: ${JSON.stringify(event)}\n\n`;
                res.write(chunk);
            });
            res.write(`data: ${JSON.stringify({ type: 'done', sessionId: capturedSessionId })}\n\n`);
            res.end();
            return;
        } catch (error) {
            if (controller.signal.aborted) {
                res.end();
                return;
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            res.write(`data: ${JSON.stringify({ type: 'error', error: errorMessage })}\n\n`);
            res.end();
            return;
        }
    } else {
        // Synchronous mode (simplified)
        let responseText = '';
        const controller = new AbortController();
        const cleanup = () => controller.abort();
        req.on('close', cleanup);

        try {
            await executeCursorAgentStream(message, { workspace, sessionId, model, signal: controller.signal }, (event) => {
                if (event.type === 'message' && event.content) {
                    responseText += event.content;
                }
                if (event.sessionId) capturedSessionId = event.sessionId;
            });
            res.json({
                response: responseText,
                sessionId: capturedSessionId
            });
            return;
        } catch (error) {
            if (controller.signal.aborted) {
                // If the request was already ended/closed, res.status/json might fail
                if (!res.writableEnded) res.end();
                return;
            }
            res.status(500).json({ error: String(error) });
            return;
        } finally {
            req.removeListener('close', cleanup);
        }
    }
});

// Start server
const server = app.listen(PORT, HOST, () => {
    logger.child({ host: HOST, port: PORT }).info('Internal Cursor A2A Server started');
});

const gracefulShutdown = (msg: string, err?: any) => {
    logger.error(msg, err);
    server.close(() => {
        logger.info('Server closed');
        process.exit(1);
    });
    // Force exit after 5s
    setTimeout(() => {
        logger.warn('Forced exit after timeout');
        process.exit(1);
    }, 5000);
};

server.on('error', (err) => {
    gracefulShutdown('SERVER ERROR:', err);
});

process.on('uncaughtException', (err) => {
    gracefulShutdown('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
    logger.error('UNHANDLED REJECTION:', reason);
});
