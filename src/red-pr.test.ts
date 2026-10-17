import { expect, it } from 'vitest';

// Fails on purpose: a pull request whose required `ci` check is red, which `main` must refuse.
it('fails, so the ci check goes red', () => {
  expect(1).toBe(2);
});
