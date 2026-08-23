// `defineConfig` comes from vitest/config rather than vite so the `test` key is
// typed; it is a superset of Vite's own config.
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// BUILD_PROMPT.md §2: the output must deploy to GitHub Pages under a repo
// subpath AND be openable from a local dev server. Pages serves a project site
// from /<repo>/, so `base` has to match the repo name; anything else and every
// asset URL 404s. Override with BASE_PATH when the repo is named differently.
//
// ASSUMPTION: repo name is "thegreatescape" (the working directory name). No
// git remote exists yet to confirm it.
const base = process.env.BASE_PATH ?? '/thegreatescape/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0, // keep data/*.json as fetchable files, not inlined
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@data': fileURLToPath(new URL('./data', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
