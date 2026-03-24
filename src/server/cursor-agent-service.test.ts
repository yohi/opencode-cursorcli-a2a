import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as cursorAgentService from './cursor-agent-service';
import { exec, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

describe('cursor-agent-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cursorAgentService.__resetCachedCursorCmd();
    (exec as any).mockImplementation((_cmd: string, callback: any) => {
      callback(null, { stdout: '/usr/bin/cursor', stderr: '' });
    });
    (existsSync as any).mockReturnValue(true);
  });

  describe('findCursorCommand', () => {
    it('should be an asynchronous function and cache the result', async () => {
      (exec as any).mockImplementation((_cmd: string, callback: (err: Error | null, res: { stdout: string, stderr: string }) => void) => {
        callback(null, { stdout: '/usr/bin/cursor', stderr: '' });
      });
      (existsSync as any).mockReturnValue(false);

      const promise1 = cursorAgentService.findCursorCommand();
      expect(promise1).toBeInstanceOf(Promise);
      const result1 = await promise1;
      expect(result1).toBe('cursor');

      const result2 = await cursorAgentService.findCursorCommand();
      expect(result2).toBe('cursor');
      expect(exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeCursorAgentStream', () => {
    const createMockChild = () => {
      const callbacks: Record<string, any> = {};
      return {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn((_e, cb) => callbacks['stdout_data'] = cb) },
        stderr: { on: vi.fn((_e, cb) => callbacks['stderr_data'] = cb) },
        on: vi.fn((e, cb) => callbacks[e] = cb),
        once: vi.fn((e, cb) => callbacks[e] = cb),
        kill: vi.fn(),
        removeListener: vi.fn(),
        _emit: (e: string, ...args: any[]) => {
          if (callbacks[e]) callbacks[e](...args);
        }
      };
    };

    it('should call findCursorCommand and spawn the process', async () => {
      const mockChild: any = createMockChild();
      let resolveSpawn: any;
      const spawnPromise = new Promise(r => resolveSpawn = r);
      (spawn as any).mockImplementation(() => {
        resolveSpawn();
        return mockChild;
      });

      const promise = cursorAgentService.executeCursorAgentStream('hello', {}, () => {});
      
      await spawnPromise;
      mockChild._emit('close', 0);
      await promise;

      expect(spawn).toHaveBeenCalled();
    });

    it('should handle abort signal', async () => {
      const mockChild: any = createMockChild();
      let resolveSpawn: any;
      const spawnPromise = new Promise(r => resolveSpawn = r);
      (spawn as any).mockImplementation(() => {
        resolveSpawn();
        return mockChild;
      });

      const controller = new AbortController();
      const promise = cursorAgentService.executeCursorAgentStream('hello', { signal: controller.signal }, () => {});
      
      await spawnPromise;
      controller.abort();

      await expect(promise).rejects.toThrow('Cursor agent aborted');
      expect(mockChild.kill).toHaveBeenCalled();
    });

    it('should handle timeout', async () => {
      // Pre-cache to avoid async findCursorCommand logic with fake timers
      (exec as any).mockImplementation((_cmd: string, callback: any) => callback(null, { stdout: 'cursor', stderr: '' }));
      await cursorAgentService.findCursorCommand();

      vi.useFakeTimers();
      const mockChild: any = createMockChild();
      (spawn as any).mockImplementation(() => mockChild);

      const promise = cursorAgentService.executeCursorAgentStream('hello', { timeout: 1000 }, () => {});
      
      // vi.runAllTicks() might still be needed if there are other promises
      await vi.runAllTicks(); 
      
      vi.advanceTimersByTime(1100);

      await expect(promise).rejects.toThrow('Cursor agent command timed out');
      expect(mockChild.kill).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should handle stderr data', async () => {
      const mockChild: any = createMockChild();
      let resolveSpawn: any;
      const spawnPromise = new Promise(r => resolveSpawn = r);
      (spawn as any).mockImplementation(() => {
        resolveSpawn();
        return mockChild;
      });

      const events: any[] = [];
      const promise = cursorAgentService.executeCursorAgentStream('hello', {}, (e) => events.push(e));

      await spawnPromise;
      mockChild._emit('stderr_data', Buffer.from('Some error occurred'));
      mockChild._emit('close', 0);

      await promise;

      expect(events).toContainEqual(expect.objectContaining({
        type: 'error',
        content: 'Some error occurred'
      }));
    });

    it('should return sessionId from stdout JSON', async () => {
      const mockChild: any = createMockChild();
      let resolveSpawn: any;
      const spawnPromise = new Promise(r => resolveSpawn = r);
      (spawn as any).mockImplementation(() => {
        resolveSpawn();
        return mockChild;
      });

      const promise = cursorAgentService.executeCursorAgentStream('hello', {}, () => {});

      await spawnPromise;
      mockChild._emit('stdout_data', Buffer.from(JSON.stringify({ type: 'result', session_id: 'test-session-123' }) + '\n'));
      mockChild._emit('close', 0);

      const { sessionId } = await promise;
      expect(sessionId).toBe('test-session-123');
    });
  });
});
