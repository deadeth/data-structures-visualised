import { defineConfig } from 'vite';

// Relative base so the build works at https://<user>.github.io/<repo>/ and from any sub-path.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as never);
