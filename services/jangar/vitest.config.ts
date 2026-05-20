import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('./src', import.meta.url))
const codexStub = fileURLToPath(new URL('./src/test-utils/codex-stub.ts', import.meta.url))
const bunStub = fileURLToPath(new URL('./src/test-utils/bun-stub.ts', import.meta.url))
const temporalBunSdkStub = fileURLToPath(new URL('./src/test-utils/temporal-bun-sdk-stub.ts', import.meta.url))
const jsdomEnvSetup = fileURLToPath(new URL('./src/test-utils/vitest-jsdom-env.ts', import.meta.url))
const agentContractsControlPlaneStatusSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/control-plane-status.ts', import.meta.url),
)
const agentContractsHealthClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agents-health-client.ts', import.meta.url),
)
const agentContractsAgentRunsClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agent-runs-client.ts', import.meta.url),
)
const agentContractsAgentMessagesClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agent-messages-client.ts', import.meta.url),
)
const agentContractsAgentJobsClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agent-jobs-client.ts', import.meta.url),
)
const agentContractsMemoryClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/memory-client.ts', import.meta.url),
)
const agentContractsOrchestrationRunsClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/orchestration-runs-client.ts', import.meta.url),
)
const agentContractsPolicyReferenceClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/policy-reference-client.ts', import.meta.url),
)
const agentContractsSignalsClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/signals-client.ts', import.meta.url),
)
const agentContractsSwarmReadClientSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/swarm-read-client.ts', import.meta.url),
)
const agentContractsReadySource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agents-ready.ts', import.meta.url),
)
const agentContractsMessageArtifactsSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agent-message-artifacts.ts', import.meta.url),
)
const agentContractsRunCallbacksSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/agent-run-callbacks.ts', import.meta.url),
)
const agentContractsCodexOrchestrationParametersSource = fileURLToPath(
  new URL('../../packages/agent-contracts/src/codex-orchestration-parameters.ts', import.meta.url),
)
const discordSource = fileURLToPath(new URL('../../packages/discord/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '~': root,
      '@': root,
      '@proompteng/agent-contracts/agents-ready': agentContractsReadySource,
      '@proompteng/agent-contracts/agent-message-artifacts': agentContractsMessageArtifactsSource,
      '@proompteng/agent-contracts/agent-run-callbacks': agentContractsRunCallbacksSource,
      '@proompteng/agent-contracts/agents-health-client': agentContractsHealthClientSource,
      '@proompteng/agent-contracts/agent-runs-client': agentContractsAgentRunsClientSource,
      '@proompteng/agent-contracts/agent-messages-client': agentContractsAgentMessagesClientSource,
      '@proompteng/agent-contracts/agent-jobs-client': agentContractsAgentJobsClientSource,
      '@proompteng/agent-contracts/codex-orchestration-parameters': agentContractsCodexOrchestrationParametersSource,
      '@proompteng/agent-contracts/control-plane-status': agentContractsControlPlaneStatusSource,
      '@proompteng/agent-contracts/memory-client': agentContractsMemoryClientSource,
      '@proompteng/agent-contracts/orchestration-runs-client': agentContractsOrchestrationRunsClientSource,
      '@proompteng/agent-contracts/policy-reference-client': agentContractsPolicyReferenceClientSource,
      '@proompteng/agent-contracts/signals-client': agentContractsSignalsClientSource,
      '@proompteng/agent-contracts/swarm-read-client': agentContractsSwarmReadClientSource,
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
      '@proompteng/agent-contracts/agents-ready': agentContractsReadySource,
      '@proompteng/agent-contracts/agent-message-artifacts': agentContractsMessageArtifactsSource,
      '@proompteng/agent-contracts/agent-run-callbacks': agentContractsRunCallbacksSource,
      '@proompteng/agent-contracts/agents-health-client': agentContractsHealthClientSource,
      '@proompteng/agent-contracts/agent-runs-client': agentContractsAgentRunsClientSource,
      '@proompteng/agent-contracts/agent-messages-client': agentContractsAgentMessagesClientSource,
      '@proompteng/agent-contracts/agent-jobs-client': agentContractsAgentJobsClientSource,
      '@proompteng/agent-contracts/codex-orchestration-parameters': agentContractsCodexOrchestrationParametersSource,
      '@proompteng/agent-contracts/control-plane-status': agentContractsControlPlaneStatusSource,
      '@proompteng/agent-contracts/memory-client': agentContractsMemoryClientSource,
      '@proompteng/agent-contracts/orchestration-runs-client': agentContractsOrchestrationRunsClientSource,
      '@proompteng/agent-contracts/policy-reference-client': agentContractsPolicyReferenceClientSource,
      '@proompteng/agent-contracts/signals-client': agentContractsSignalsClientSource,
      '@proompteng/agent-contracts/swarm-read-client': agentContractsSwarmReadClientSource,
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
    setupFiles: [jsdomEnvSetup],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/ui/**', '**/node_modules/**'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      exclude: ['src/server/agents-controller/index.ts'],
    },
  },
})
