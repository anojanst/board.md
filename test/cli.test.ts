import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.js';
import pkg from '../package.json' with { type: 'json' };

afterEach(() => vi.restoreAllMocks());

describe('boardmd', () => {
  it('prints its version', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--version'])).toBe(0);
    expect(log).toHaveBeenCalledWith(pkg.version);
  });

  it('prints help with no command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main([])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('boardmd serve');
  });

  it('rejects an unknown command', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['nope'])).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain('Unknown command: nope');
  });

  it('rejects unknown flags and bad ports', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['serve', '--nope'])).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain("Unknown option '--nope'");
    expect(await main(['serve', '--port', 'abc'])).toBe(1);
    expect(error.mock.calls[1]?.[0]).toContain('--port must be a number');
  });
});
