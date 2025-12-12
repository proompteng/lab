import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '~': root,
      '@': root,
    },
  },
  test: {
    environment: 'node',
    alias: {
      '~': root,
      '@': root,
    },
  },
})
