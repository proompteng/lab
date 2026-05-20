import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('./src', import.meta.url))
const agentContractsPolicyValidationSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/policy-validation.ts', import.meta.url),
)
const agentContractsExecutionTrustSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/execution-trust.ts', import.meta.url),
)
const agentContractsSwarmMaterialReentrySource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/swarm-material-reentry.ts', import.meta.url),
)
const codexSource = fileURLToPath(new URL('../../packages/codex/src/index.ts', import.meta.url))
const otelApiSource = fileURLToPath(new URL('../../packages/otel/src/api.ts', import.meta.url))
const temporalSdkSource = fileURLToPath(new URL('../../packages/temporal-bun-sdk/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '~': root,
      '@': root,
      '@proompteng/agent-contracts/execution-trust': agentContractsExecutionTrustSource,
      '@proompteng/agent-contracts/policy-validation': agentContractsPolicyValidationSource,
      '@proompteng/agent-contracts/swarm-material-reentry': agentContractsSwarmMaterialReentrySource,
      '@proompteng/codex': codexSource,
      '@proompteng/otel/api': otelApiSource,
      '@proompteng/temporal-bun-sdk': temporalSdkSource,
    },
  },
  test: {
    environment: 'node',
    alias: {
      '~': root,
      '@': root,
      '@proompteng/agent-contracts/execution-trust': agentContractsExecutionTrustSource,
      '@proompteng/agent-contracts/policy-validation': agentContractsPolicyValidationSource,
      '@proompteng/agent-contracts/swarm-material-reentry': agentContractsSwarmMaterialReentrySource,
      '@proompteng/codex': codexSource,
      '@proompteng/otel/api': otelApiSource,
      '@proompteng/temporal-bun-sdk': temporalSdkSource,
    },
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**'],
    testTimeout: 10_000,
  },
})
