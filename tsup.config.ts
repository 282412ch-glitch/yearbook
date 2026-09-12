import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['apps/server/src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'apps/server/dist',
  noExternal: ['@yearbook/shared'],
  clean: true,
  sourcemap: true,
});
