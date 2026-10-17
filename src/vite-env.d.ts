/// <reference types="vite/client" />

/** `PRODUCT_VERSION`: the package's version and the commit's hash (`vite.config.ts`). */
declare const __PRODUCT_VERSION__: string;
/** `PRODUCT_DATE`: the day of the build, as C's `__DATE__` writes it. */
declare const __PRODUCT_DATE__: string;
/** Where the build's source is: the repository at the commit it was built from. */
declare const __PRODUCT_SOURCE__: string;
/** The notices the build publishes beside `index.html`, by name (`scripts/notices.mjs`). */
declare const __PRODUCT_NOTICES__: readonly string[];

interface ImportMetaEnv {
  /** Where the port's own map pk3s are served, if not beside the page (`pak/mount.ts`). */
  readonly VITE_MAPS_URL?: string;
}
