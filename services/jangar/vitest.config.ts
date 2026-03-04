import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('./src', import.meta.url))
const codexStub = fileURLToPath(new URL('./src/test-utils/codex-stub.ts', import.meta.url))
const bunStub = fileURLToPath(new URL('./src/test-utils/bun-stub.ts', import.meta.url))
const temporalBunSdkStub = fileURLToPath(new URL('./src/test-utils/temporal-bun-sdk-stub.ts', import.meta.url))
const discordSource = fileURLToPath(new URL('../../packages/discord/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '~': root,
      '@': root,
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
    },
  },
  test: {
    environment: 'node',
    alias: {
      '~': root,
      '@': root,
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
      bun: bunStub,
    },
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/ui/**', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      exclude: ['src/server/agents-controller/index.ts'],
    },
  },
})
