import path from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@bufbuild/protobuf/codegenv2': path.resolve(
        __dirname,
        '../../node_modules/@bufbuild/protobuf/dist/esm/codegenv2/index.js',
      ),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      exclude: [
        'scripts/**',
        'vitest.config.ts',
        'src/services/github/types.ts',
        'src/services/github/service.types.ts',
      ],
    },
  },
})
