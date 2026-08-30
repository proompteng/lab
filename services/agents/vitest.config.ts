import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('./src', import.meta.url))
const agentContractsSource = fileURLToPath(new URL('../../packages/agent-contracts/src/index.ts', import.meta.url))
const codexSource = fileURLToPath(new URL('../../packages/codex/src/index.ts', import.meta.url))
const otelApiSource = fileURLToPath(new URL('../../packages/otel/src/api.ts', import.meta.url))
const temporalSdkSource = fileURLToPath(new URL('../../packages/temporal-bun-sdk/src/index.ts', import.meta.url))

const alias = {
  '~': root,
  '@': root,
  '@proompteng/agent-contracts': agentContractsSource,
  '@proompteng/codex': codexSource,
  '@proompteng/otel/api': otelApiSource,
  '@proompteng/temporal-bun-sdk': temporalSdkSource,
}

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    alias,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**'],
    testTimeout: 10_000,
  },
})
