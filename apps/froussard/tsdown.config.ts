import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  sourcemap: true,
  clean: true,
  platform: 'node',
  target: 'node22',
  treeshake: true,
  shims: false,
  minify: false,
  unbundle: true,
  skipNodeModulesBundle: true,
  env: {
    NODE_ENV: 'production',
  },
})
