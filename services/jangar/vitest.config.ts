import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('./src', import.meta.url))
const codexStub = fileURLToPath(new URL('./src/test-utils/codex-stub.ts', import.meta.url))
const bunStub = fileURLToPath(new URL('./src/test-utils/bun-stub.ts', import.meta.url))
const temporalBunSdkStub = fileURLToPath(new URL('./src/test-utils/temporal-bun-sdk-stub.ts', import.meta.url))
const jsdomEnvSetup = fileURLToPath(new URL('./src/test-utils/vitest-jsdom-env.ts', import.meta.url))
const agentContractsSource = fileURLToPath(new URL('../../packages/agent-contracts/src/index.ts', import.meta.url))
const discordSource = fileURLToPath(new URL('../../packages/discord/src/index.ts', import.meta.url))

const alias = {
  '~': root,
  '@': root,
  '@proompteng/agent-contracts': agentContractsSource,
  '@proompteng/codex': codexStub,
  '@proompteng/codex/*': codexStub,
  '@proompteng/discord': discordSource,
  '@proompteng/temporal-bun-sdk': temporalBunSdkStub,
  '@proompteng/temporal-bun-sdk/client': temporalBunSdkStub,
  '@proompteng/temporal-bun-sdk/config': temporalBunSdkStub,
  '@proompteng/temporal-bun-sdk/worker': temporalBunSdkStub,
  '@proompteng/temporal-bun-sdk/testing': temporalBunSdkStub,
  '@proompteng/temporal-bun-sdk/workflow': temporalBunSdkStub,
  '@proompteng/temporal-bun-sdk/*': temporalBunSdkStub,
}

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    alias: {
      ...alias,
      bun: bunStub,
    },
    setupFiles: [jsdomEnvSetup],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/ui/**', '**/node_modules/**'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
    },
  },
})
