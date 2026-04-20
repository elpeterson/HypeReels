import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Override CSS/PostCSS to prevent Vite from walking up to the repo-root
  // postcss.config.js (which requires tailwindcss, not installed here).
  // The server is a pure Node.js app — no CSS processing needed.
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Anchor the root to this directory, not the repo root.
    root: '.',
  },
});
