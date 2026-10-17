import { describe, expect, it, vi } from 'vitest';

import { inShell, shellInstall, shellLaunch } from './shell';

describe('inShell', () => {
  it("is the shell's app: scheme alone", () => {
    expect(inShell({ protocol: 'app:' })).toBe(true);
    for (const protocol of ['http:', 'https:', 'file:']) {
      expect(inShell({ protocol }), protocol).toBe(false);
    }
  });
});

describe('shellInstall', () => {
  it('reads the installs with GET, and picks with POST', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ running: 'C:\\q3', next: null }))
      .mockResolvedValueOnce(Response.json({ running: 'C:\\q3', next: 'C:\\q3', refused: 'D:\\empty' }));
    const install = shellInstall(fetcher);

    expect(await install.read()).toEqual({ running: 'C:\\q3', next: undefined });
    expect(fetcher).toHaveBeenLastCalledWith('/install', { method: 'GET' });
    expect(await install.pick()).toEqual({ running: 'C:\\q3', next: 'C:\\q3', refused: 'D:\\empty' });
    expect(fetcher).toHaveBeenLastCalledWith('/install', { method: 'POST' });
  });

  it('fails where the route does', async () => {
    const install = shellInstall(async () => new Response(null, { status: 500 }));
    await expect(install.read()).rejects.toThrow('GET /install: 500');
  });
});

describe('shellLaunch', () => {
  it('reads the vertical sync the launch started Chromium with', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ vsync: false }));
    expect(await shellLaunch(fetcher)).toEqual({ vsync: false });
    expect(fetcher).toHaveBeenLastCalledWith('/launch');
    expect(await shellLaunch(async () => Response.json({ vsync: true }))).toEqual({ vsync: true });
  });

  it('fails where the route does', async () => {
    const launch = shellLaunch(async () => new Response(null, { status: 404 }));
    await expect(launch).rejects.toThrow('GET /launch: 404');
  });
});
