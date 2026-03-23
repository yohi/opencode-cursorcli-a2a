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

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'opencode-cursor-a2a-internal',
        timestamp: new Date().toISOString()
    });
});

// A2A Messages Endpoint (Streaming)
app.post('/:projectId/messages', async (req, res) => {
    const { message, sessionId, model } = req.body;
    const { projectId } = req.params;
    const stream = req.query.stream === 'true' || req.headers.accept === 'text/event-stream';

    if (!message) {
        return res.status(400).json({ error: 'Missing message' });
    }

    // Note: In this internal version, we simplified project handling.
    // In a real scenario, we might want to resolve workspace from projectId.
    // For now, we assume workspace is passed or defaults to CWD.
    const workspace = process.env['CURSOR_WORKSPACE'] || process.cwd();

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        try {
            await executeCursorAgentStream(message, { workspace, sessionId, model }, (event) => {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            });
            res.write(`data: ${JSON.stringify({ type: 'done', sessionId })}\n\n`);
            res.end();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            res.write(`data: ${JSON.stringify({ type: 'error', error: errorMessage })}\n\n`);
            res.end();
        }
    } else {
        // Synchronous mode (simplified)
        let responseText = '';
        let capturedSessionId = sessionId;

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
        } catch (error) {
            res.status(500).json({ error: String(error) });
        }
    }
});

// Start server
app.listen(PORT, HOST, () => {
    console.log(`🚀 Internal Cursor A2A Server running on http://${HOST}:${PORT}`);
});
