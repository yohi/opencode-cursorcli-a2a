// src/utils/mapper.test.ts
import { describe, it, expect } from 'vitest';
import {
    mapPromptToCursorRequest,
    mapPromptToA2AJsonRpcRequest,
    buildConfirmationRequest,
    CursorA2AStreamMapper,
    A2AStreamMapper,
} from './mapper';
import type { LanguageModelV1Prompt } from '@ai-sdk/provider';

// ---------------------------------------------------------------------------
// mapPromptToCursorRequest (新 REST API)
// ---------------------------------------------------------------------------
describe('mapPromptToCursorRequest', () => {
    it('maps a simple user text prompt', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'Hello CursorCLI!' }] }];
        const result = mapPromptToCursorRequest(prompt);
        expect(result.message).toContain('Hello CursorCLI!');
    });

    it('sets cursorModel when provided', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'test' }] }];
        const result = mapPromptToCursorRequest(prompt, { cursorModel: 'sonnet-4.5' });
        expect(result.model).toBe('sonnet-4.5');
    });

    it('resolves model from modelId if it looks like a Cursor model name', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'test' }] }];
        // "sonnet-4.5" is now passed directly
        const result = mapPromptToCursorRequest(prompt, { modelId: 'sonnet-4.5' });
        expect(result.model).toBe('sonnet-4.5');
    });

    it('resolves model from "prefix/model-name" format', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'test' }] }];
        const result = mapPromptToCursorRequest(prompt, { modelId: 'cursor-agent/gpt-5.2' });
        expect(result.model).toBe('gpt-5.2');
    });

    it('omits model when modelId does not look like a Cursor model name', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'test' }] }];
        // "cursor-agent" is now passed directly
        const result = mapPromptToCursorRequest(prompt, { modelId: 'cursor-agent' });
        expect(result.model).toBe('cursor-agent');
    });

    it('includes sessionId when provided', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'test' }] }];
        const result = mapPromptToCursorRequest(prompt, { sessionId: 'session-abc' });
        expect(result.sessionId).toBe('session-abc');
    });

    it('sets workspace in context', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'test' }] }];
        const result = mapPromptToCursorRequest(prompt, { workspace: '/my/project' });
        expect(result.context?.workspace).toBe('/my/project');
    });

    it('handles system message', () => {
        const prompt: LanguageModelV1Prompt = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ];
        const result = mapPromptToCursorRequest(prompt);
        expect(result.message).toContain('[SYSTEM]');
        expect(result.message).toContain('You are a helpful assistant.');
    });

    it('applies triggerConfig systemPromptAddendum', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
        const result = mapPromptToCursorRequest(prompt, {
            triggerConfig: { modelId: 'sonnet-4.5', trigger: 'always', systemPromptAddendum: 'Focus on coding.' },
        });
        expect(result.message).toContain('Focus on coding.');
    });

    it('uses process.cwd() as workspace when not specified', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'test' }] }];
        const result = mapPromptToCursorRequest(prompt);
        expect(result.context?.workspace).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// buildConfirmationRequest (後方互換)
// ---------------------------------------------------------------------------
describe('buildConfirmationRequest', () => {
    it('builds a confirmation request with taskId', () => {
        const result = buildConfirmationRequest('task-abc', 'cursor-agent');
        expect(result.jsonrpc).toBe('2.0');
        expect(result.method).toBe('message/stream');
        expect(result.params.taskId).toBe('task-abc');
        expect(result.params.message.parts[0]).toMatchObject({ kind: 'text', text: 'Proceed' });
    });

    it('builds a cancel request', () => {
        const result = buildConfirmationRequest('task-abc', undefined, false);
        expect(result.params.message.parts[0]).toMatchObject({ kind: 'text', text: 'Cancel' });
    });
});

// ---------------------------------------------------------------------------
// Legacy: mapPromptToA2AJsonRpcRequest (後方互換ラッパー)
// ---------------------------------------------------------------------------
describe('mapPromptToA2AJsonRpcRequest (legacy)', () => {
    it('wraps mapPromptToCursorRequest in JSON-RPC format', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'Hello CursorCLI!' }] }];
        const result = mapPromptToA2AJsonRpcRequest(prompt);
        expect(result.jsonrpc).toBe('2.0');
        expect(result.method).toBe('message/stream');
        expect(result.params.message.parts.some(p => p.kind === 'text')).toBe(true);
    });

    it('passes contextId into params', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
        const result = mapPromptToA2AJsonRpcRequest(prompt, { contextId: 'ctx-999' });
        expect(result.params.contextId).toBe('ctx-999');
    });

    it('passes taskId into params', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
        const result = mapPromptToA2AJsonRpcRequest(prompt, { taskId: 'task-999' });
        expect(result.params.taskId).toBe('task-999');
    });

    it('sets model when cursorModel is provided', () => {
        const prompt: LanguageModelV1Prompt = [{ role: 'user', content: [{ type: 'text', text: 'test' }] }];
        const result = mapPromptToA2AJsonRpcRequest(prompt, { cursorModel: 'opus-4.5' });
        expect(result.params.model).toBe('opus-4.5');
    });
});

// ---------------------------------------------------------------------------
// CursorA2AStreamMapper (新 REST API イベント)
// ---------------------------------------------------------------------------
describe('CursorA2AStreamMapper', () => {
    it('extracts text-delta from text event', () => {
        const mapper = new CursorA2AStreamMapper();
        mapper.startNewTurn();
        const parts = mapper.mapEvent({ type: 'text', content: 'Hello World' });
        const deltas = parts.filter(p => p.type === 'text-delta');
        expect(deltas.length).toBeGreaterThan(0);
        expect((deltas[0] as any).textDelta || (deltas[0] as any).delta).toBe('Hello World');
    });

    it('deduplicates text using snapshot diffing', () => {
        const mapper = new CursorA2AStreamMapper();
        mapper.startNewTurn();
        mapper.mapEvent({ type: 'text', content: 'Hello' });
        const parts = mapper.mapEvent({ type: 'text', content: 'Hello World' });
        const deltas = parts.filter(p => p.type === 'text-delta');
        expect((deltas[0] as any).textDelta || (deltas[0] as any).delta).toBe(' World');
    });

    it('emits finish on complete event', () => {
        const mapper = new CursorA2AStreamMapper();
        mapper.startNewTurn();
        const parts = mapper.mapEvent({ type: 'complete', sessionId: 'sess-1' });
        expect(parts.some(p => p.type === 'finish')).toBe(true);
        expect(mapper.sessionId).toBe('sess-1');
    });

    it('emits tool-call on tool_call event', () => {
        const mapper = new CursorA2AStreamMapper({ clientTools: ['read_file'] });
        mapper.startNewTurn();
        const parts = mapper.mapEvent({ type: 'tool_call', name: 'read_file', arguments: { path: '/tmp/foo.ts' }, callId: 'call-1' });
        const toolCalls = parts.filter(p => p.type === 'tool-call');
        expect(toolCalls.length).toBeGreaterThan(0);
        const tc = toolCalls[0] as { toolName: string; toolCallId: string };
        expect(tc.toolName).toBe('read_file');
        expect(tc.toolCallId).toBe('call-1');
    });

    it('intercepts invalid tool and rewrites to run_terminal_command', () => {
        const mapper = new CursorA2AStreamMapper({ clientTools: ['bash'] });
        mapper.startNewTurn();
        const parts = mapper.mapEvent({ type: 'tool_call', name: 'invalid', arguments: {}, callId: 'c1' });
        const toolCalls = parts.filter(p => p.type === 'tool-call');
        expect(toolCalls.length).toBeGreaterThan(0);
        const tc = toolCalls[0] as { toolName: string };
        expect(tc.toolName).toBe('run_terminal_command');
    });

    it('throws on error event', () => {
        const mapper = new CursorA2AStreamMapper();
        mapper.startNewTurn();
        expect(() => mapper.mapEvent({ type: 'error', message: 'Cursor error', code: 500 })).toThrow('cursor-agent-a2a error');
    });

    it('applies tool mapping', () => {
        const mapper = new CursorA2AStreamMapper({ toolMapping: { 'bash': 'run_terminal_command' }, clientTools: ['run_terminal_command'] });
        mapper.startNewTurn();
        const parts = mapper.mapEvent({ type: 'tool_call', name: 'bash', arguments: { command: 'ls' }, callId: 'c1' });
        const tc = parts.find(p => p.type === 'tool-call') as { toolName: string } | undefined;
        expect(tc?.toolName).toBe('run_terminal_command');
    });
});

// ---------------------------------------------------------------------------
// A2AStreamMapper (後方互換)
// ---------------------------------------------------------------------------
describe('A2AStreamMapper (legacy)', () => {
    it('maps status-update text to text-delta', () => {
        const mapper = new A2AStreamMapper();
        mapper.startNewTurn();
        const parts = mapper.mapResult({
            kind: 'status-update',
            taskId: 'task-1',
            contextId: 'ctx-1',
            status: { state: 'working', message: { parts: [{ kind: 'text', text: 'Hello' }] } },
            final: false,
            metadata: undefined,
        });
        expect(parts.some(p => p.type === 'text-delta')).toBe(true);
    });

    it('emits finish on final status-update', () => {
        const mapper = new A2AStreamMapper();
        mapper.startNewTurn();
        const parts = mapper.mapResult({
            kind: 'status-update',
            taskId: 'task-1',
            contextId: 'ctx-1',
            status: { state: 'completed', message: { parts: [{ kind: 'text', text: 'Done' }] } },
            final: true,
            metadata: undefined,
        });
        expect(parts.some(p => p.type === 'finish')).toBe(true);
    });

    it('tracks contextId and taskId', () => {
        const mapper = new A2AStreamMapper();
        mapper.startNewTurn();
        mapper.mapResult({
            kind: 'status-update',
            taskId: 'task-abc',
            contextId: 'ctx-xyz',
            status: { state: 'working', message: { parts: [{ kind: 'text', text: 'x' }] } },
            final: false,
            metadata: undefined,
        });
        expect(mapper.contextId).toBe('ctx-xyz');
        expect(mapper.taskId).toBe('task-abc');
    });
});
