import { cp } from 'node:fs/promises';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  // The page ships prebuilt: plain JS and CSS, served from dist/web.
  onSuccess: async () => {
    await cp('src/web', 'dist/web', { recursive: true });
  },
});
