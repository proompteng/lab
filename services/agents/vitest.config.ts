import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('./src', import.meta.url))
const agentContractsPolicyValidationSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/policy-validation.ts', import.meta.url),
)
const agentContractsAgentRunProjectionAuthorityClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agent-run-projection-authority-client.ts', import.meta.url),
)
const agentContractsAgentRunTerminalEventsClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agent-run-terminal-events-client.ts', import.meta.url),
)
const agentContractsRunCallbacksSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agent-run-callbacks.ts', import.meta.url),
)
const agentContractsRunCallbacksClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agent-run-callbacks-client.ts', import.meta.url),
)
const agentContractsRunRerunsClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agent-run-reruns-client.ts', import.meta.url),
)
const agentContractsCodexOrchestrationParametersSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/codex-orchestration-parameters.ts', import.meta.url),
)
const agentContractsExecutionTrustSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/execution-trust.ts', import.meta.url),
)
const agentContractsControllerWitnessSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/controller-witness.ts', import.meta.url),
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
      '@proompteng/agent-contracts/agent-run-projection-authority-client':
        agentContractsAgentRunProjectionAuthorityClientSource,
      '@proompteng/agent-contracts/agent-run-callbacks': agentContractsRunCallbacksSource,
      '@proompteng/agent-contracts/agent-run-callbacks-client': agentContractsRunCallbacksClientSource,
      '@proompteng/agent-contracts/agent-run-reruns-client': agentContractsRunRerunsClientSource,
      '@proompteng/agent-contracts/agent-run-terminal-events-client': agentContractsAgentRunTerminalEventsClientSource,
      '@proompteng/agent-contracts/controller-witness': agentContractsControllerWitnessSource,
      '@proompteng/agent-contracts/codex-orchestration-parameters': agentContractsCodexOrchestrationParametersSource,
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
      '@proompteng/agent-contracts/agent-run-projection-authority-client':
        agentContractsAgentRunProjectionAuthorityClientSource,
      '@proompteng/agent-contracts/agent-run-callbacks': agentContractsRunCallbacksSource,
      '@proompteng/agent-contracts/agent-run-callbacks-client': agentContractsRunCallbacksClientSource,
      '@proompteng/agent-contracts/agent-run-reruns-client': agentContractsRunRerunsClientSource,
      '@proompteng/agent-contracts/agent-run-terminal-events-client': agentContractsAgentRunTerminalEventsClientSource,
      '@proompteng/agent-contracts/controller-witness': agentContractsControllerWitnessSource,
      '@proompteng/agent-contracts/codex-orchestration-parameters': agentContractsCodexOrchestrationParametersSource,
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
