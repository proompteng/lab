import path from 'node:path'
import { createRequire } from 'node:module'

import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const codegenv2Path = require.resolve('@bufbuild/protobuf/codegenv2')

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@bufbuild/protobuf/codegenv2': codegenv2Path,
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
