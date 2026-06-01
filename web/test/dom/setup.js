// setup.js — vitest setupFile, run once per test file BEFORE each suite.
//
// It is listed globally in vite.config.js, so it loads for BOTH the node-env
// helper tests and the jsdom-env DOM tests. Everything DOM-specific here is
// guarded on `typeof document !== 'undefined'` so the node tests stay pure and
// never pull in jest-dom / testing-library cleanup.

import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  // jest-dom custom matchers (toBeInTheDocument, toHaveTextContent, …) and the
  // automatic unmount-between-tests cleanup are only meaningful under jsdom.
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });
}
