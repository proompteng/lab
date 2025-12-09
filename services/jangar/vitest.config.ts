import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('./src', import.meta.url))
const codexStub = fileURLToPath(new URL('./src/test-utils/codex-stub.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '~': root,
      '@': root,
      '@proompteng/codex': codexStub,
      '@proompteng/codex/*': codexStub,
    },
  },
  test: {
    environment: 'node',
    alias: {
      '~': root,
      '@': root,
      '@proompteng/codex': codexStub,
      '@proompteng/codex/*': codexStub,
    },
  },
})
