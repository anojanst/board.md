import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';
import pkg from '../package.json' with { type: 'json' };

afterEach(() => vi.restoreAllMocks());

describe('boardmd', () => {
  it('prints its version', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['--version'])).toBe(0);
    expect(log).toHaveBeenCalledWith(pkg.version);
  });

  it('prints help with no command', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main([])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('boardmd serve');
  });

  it('rejects an unknown command', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(main(['nope'])).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain('Unknown command: nope');
  });
});
