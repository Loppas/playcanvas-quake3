import { defineConfig } from 'vite';

/**
 * The master's bundle: `master/master.ts` and the parts of `src/net` it reaches, resolved as the
 * page's build resolves them, which Node alone cannot. The output is `build/master.js`, which
 * `npm run master` builds and then runs (`package.json`).
 *
 * As a Node build it leaves its dependencies outside, `ws` and node-datachannel's native code
 * among them, to be found in `node_modules`. The dedicated server's bundle shares the folder and
 * empties it, so this one leaves it as it is.
 */
export default defineConfig({
  build: {
    ssr: 'master/master.ts',
    outDir: 'build',
    target: 'node20',
    emptyOutDir: false,
    copyPublicDir: false
  }
});
