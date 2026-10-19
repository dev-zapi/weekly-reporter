// Test stub for the `server-only` marker package.
//
// The real package throws at import time outside a React Server Component, but
// vitest runs these modules in a plain node/jsdom environment. vitest.config.ts
// aliases `server-only` to this no-op so server modules stay importable under
// test. The production guard is enforced by Next.js at build time.
export {}
