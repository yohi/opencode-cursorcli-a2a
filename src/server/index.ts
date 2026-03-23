/**
 * Internal A2A Server for Cursor Agent
 * 
 * This server provides an A2A-compatible REST API for the Cursor Agent.
 * It uses the internal cursor-agent-service with native "thinking" support.
 */

import express from 'express';
import cors from 'cors';
import { executeCursorAgentStream } from './cursor-agent-service.js';

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
    if (!AUTH_TOKEN) return next();
    
    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${AUTH_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Health check
app.get('/health', (_req: express.Request, res: express.Response) => {
    res.json({
        status: 'ok',
        service: 'opencode-cursor-a2a-internal',
        timestamp: new Date().toISOString()
    });
});

// A2A Messages Endpoint (Streaming)
app.post('/:projectId/messages', authMiddleware, async (req: express.Request, res: express.Response) => {
    const { message, sessionId, model } = req.body;
    const { projectId } = req.params;
    const stream = req.query.stream === 'true' || req.headers.accept === 'text/event-stream';

    console.log(`[A2A] Processing request for project ${projectId} (sessionId: ${sessionId || 'new'})`);

    if (!message) {
        return res.status(400).json({ error: 'Missing message' });
    }

    const workspace = process.env['CURSOR_WORKSPACE'] || process.cwd();
    let capturedSessionId = sessionId;

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const controller = new AbortController();
        req.on('close', () => {
            controller.abort();
        });

        try {
            await executeCursorAgentStream(message, { workspace, sessionId, model, signal: controller.signal }, (event) => {
                if (event.sessionId) capturedSessionId = event.sessionId;
                res.write(`data: ${JSON.stringify(event)}\n\n`);
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

        try {
            await executeCursorAgentStream(message, { workspace, sessionId, model }, (event) => {
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
            res.status(500).json({ error: String(error) });
            return;
        }
    }
});

// Start server
app.listen(PORT, HOST, () => {
    console.log(`🚀 Internal Cursor A2A Server running on http://${HOST}:${PORT}`);
});
