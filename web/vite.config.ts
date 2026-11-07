// Vite config for the Weekly Reporter SPA (React Router v7 library mode).
//
// Alias strategy: pages and shared components are mirrored 1:1 under
// web/src/{app,components} with their Next dependencies truly replaced (no
// next-compat shim layer, ADR-0028). Client libraries that never touch Next
// (`src/lib/**`) are consumed in place from the repo root.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const webDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(webDir, '..')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // pnpm layout + Vite dep pre-bundling can pull a second React copy in via
    // next-themes et al.; two instances mean "Invalid hook call".
    dedupe: ['react', 'react-dom'],
    alias: [
      // Order-sensitive: exact matches must precede the generic prefixes.
      { find: /^@\/lib\/build-info$/, replacement: path.resolve(webDir, 'src/build-info.ts') },
      { find: '@/app', replacement: path.resolve(webDir, 'src/app') },
      { find: '@/components', replacement: path.resolve(webDir, 'src/components') },
      { find: '@', replacement: path.resolve(repoRoot, 'src') },
    ],
  },
  build: {
    // The tracked web/dist/.gitkeep keeps `//go:embed all:dist` compiling on a
    // fresh clone before the first Vite build; do not wipe it.
    emptyOutDir: false,
  },
  server: {
    // Dev recipe: `pnpm -C web dev --port <port> --strictPort`; /api is proxied
    // to the local `wr serve` (Go API). VITE_API_TARGET overrides the target so
    // the auth-enabled server (a second XDG root + no WR_AUTH_DISABLED) can be
    // exercised without editing this file.
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:6868', changeOrigin: true },
    },
    fs: { allow: [repoRoot] },
  },
})
