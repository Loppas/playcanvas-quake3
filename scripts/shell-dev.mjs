/**
 * `npm run shell`: the desktop shell over the Vite dev server, so it runs the sources as the
 * browser does. The shell takes each page request from the server and answers the pak and config
 * routes itself (`electron/app-protocol.mjs`), as a packaged build does.
 */

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import electron from 'electron';
import { createServer } from 'vite';

/**
 * A port nothing on this machine listens on, so the shell never shares `npm run dev`'s server.
 *
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, 'localhost', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const server = await createServer({
  server: {
    // Only the shell on this machine asks it for anything.
    host: 'localhost',
    port,
    strictPort: true,
    // The page is on the shell's `app:` origin, which names no server for the HMR client to reach.
    ws: { host: 'localhost', clientPort: port }
  }
});
await server.listen();
const origin = `http://localhost:${port}`;
server.config.logger.info(`  shell: the page from ${origin}`);

const shell = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, PCQ_SHELL_DEV_SERVER: origin }
});
shell.on('exit', (code) => {
  void server.close().finally(() => process.exit(code ?? 0));
});
