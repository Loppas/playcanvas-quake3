/**
 * The build's two stamps, as ioquake3's CMake makes them.
 *
 * `PRODUCT_VERSION` is the package's version and the commit's short hash: the page's `vite.config.ts`
 * and the dedicated server's `vite.dedicated.config.ts` both define it, so the `version` cvar
 * (`host.ts`, set at start) reports the same thing wherever the server runs. `PRODUCT_DATE` is the
 * day of the build, as C's `__DATE__` writes it.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import nodePath from 'node:path';

/**
 * `PRODUCT_VERSION`. A tree with no git to ask has the version alone.
 *
 * @param root - The repo root, where `package.json` lives.
 */
export function productVersion(root) {
  const pkg = JSON.parse(readFileSync(nodePath.join(root, 'package.json'), 'utf8'));
  try {
    const hash = execSync('git rev-parse --short HEAD', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return `${pkg.version}_g${hash}`;
  } catch {
    return pkg.version;
  }
}

/**
 * Where the build's source is: the repository at the commit built, which the web build links, as
 * the GPL has a build offer its source from where the build is offered. A tree with no git to ask
 * has the repository alone.
 *
 * @param root - The repo root, where `package.json` lives.
 */
export function productSource(root) {
  const pkg = JSON.parse(readFileSync(nodePath.join(root, 'package.json'), 'utf8'));
  try {
    const hash = execSync('git rev-parse HEAD', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return `${pkg.homepage}/tree/${hash}`;
  } catch {
    return pkg.homepage;
  }
}

const MONTHS =['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `PRODUCT_DATE`: `Sep  7 2026`.
 *
 * @param date - The day to write; today's by default.
 */
export function productDate(date = new Date()) {
  return `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2)} ${date.getFullYear()}`;
}
