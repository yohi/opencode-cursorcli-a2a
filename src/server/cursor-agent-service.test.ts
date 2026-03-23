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
    // No easy way to reset _cachedCursorCmd if it's not exported
  });

  describe('findCursorCommand', () => {
    it('should be an asynchronous function and cache the result', async () => {
      // Mock exec to succeed for 'which cursor'
      (exec as any).mockImplementation((_cmd: string, callback: (err: Error | null, res: { stdout: string, stderr: string }) => void) => {
        callback(null, { stdout: '/usr/bin/cursor', stderr: '' });
      });

      // Mock existsSync to return false for all paths to force it to use 'which cursor'
      (existsSync as any).mockReturnValue(false);

      // First call
      const promise1 = cursorAgentService.findCursorCommand();
      expect(promise1).toBeInstanceOf(Promise);
      const result1 = await promise1;
      expect(result1).toBe('cursor');

      // Second call
      const result2 = await cursorAgentService.findCursorCommand();
      expect(result2).toBe('cursor');

      // Detection logic (like exec) should only be called once if cached
      expect(exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeCursorAgentStream', () => {
    it('should call findCursorCommand and spawn the process', async () => {
      const mockChild = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, callback: any) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 0);
          }
          return mockChild;
        }),
        kill: vi.fn(),
      };
      (spawn as any).mockReturnValue(mockChild);

      await cursorAgentService.executeCursorAgentStream('hello', {}, () => {});

      expect(spawn).toHaveBeenCalledWith(
        expect.stringContaining('cursor'),
        expect.any(Array),
        expect.any(Object)
      );
    });
  });
});
