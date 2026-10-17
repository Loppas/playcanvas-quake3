/**
 * The licence notices every copy of the port carries. The GPL asks for the licence and the
 * copyright notices with each copy, and the packages bundled into the web build ask for theirs,
 * which the minifier strips from the scripts.
 */

import { readFileSync } from 'node:fs';
import nodePath from 'node:path';

/** Where the web build writes the bundled packages' licences, beside `index.html`. */
export const THIRD_PARTY_NOTICES = 'THIRD-PARTY-NOTICES.md';

/** The repo's own notices: the licence, the copyright lines, and the credits. */
export const NOTICE_FILES = ['LICENSE', 'NOTICE', 'CREDITS.md'];

/**
 * A notice's name in the web build, beside `index.html`. A static host serves a name without an
 * extension as a download, so `LICENSE` goes in as `LICENSE.txt`.
 *
 * @param {string} file - One of {@link NOTICE_FILES}.
 */
export function publishedName(file) {
  return file.includes('.') ? file : `${file}.txt`;
}

/** Every notice the web build publishes, by the name it publishes it as, which the page links. */
export const PUBLISHED_NOTICES = [...NOTICE_FILES.map(publishedName), THIRD_PARTY_NOTICES];

/**
 * The comment each of the web build's scripts opens with, after minifying: the port's licence,
 * its source, and where the bundled packages' licences are.
 *
 * @param {string} root - The repo root, where `package.json` lives.
 */
export function banner(root) {
  const pkg = JSON.parse(readFileSync(nodePath.join(root, 'package.json'), 'utf8'));
  const packages = `the bundled packages' licences: ${THIRD_PARTY_NOTICES}`;
  return `/*! ${pkg.name} | ${pkg.license} | ${pkg.homepage} | ${packages} */`;
}
