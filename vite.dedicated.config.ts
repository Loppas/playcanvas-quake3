import { defineConfig } from 'vite';

import { productDate, productVersion } from './scripts/product-version.mjs';

/**
 * The dedicated server's bundle: `src/dedicated.ts` and everything it reaches, resolved as the
 * page's build resolves them — the sources' bundleless imports and `import.meta.glob`, which Node
 * alone cannot. The output is `build/dedicated.js`, and the entry finds the repo one folder up;
 * `npm run dedicated` builds it and then runs it (`package.json`).
 *
 * The two stamps are the page's own (`vite.config.ts`), because the host reads them for its
 * `version` cvar (`src/version.ts`) wherever it runs.
 */
export default defineConfig({
  define: {
    __PRODUCT_VERSION__: JSON.stringify(productVersion(import.meta.dirname)),
    __PRODUCT_DATE__: JSON.stringify(productDate())
  },
  build: {
    ssr: 'src/dedicated.ts',
    outDir: 'build',
    target: 'node20',
    emptyOutDir: true,
    // The server reads the map pk3s in `public/maps` where they sit.
    copyPublicDir: false
  }
});
