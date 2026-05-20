import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('codex runner image layout', () => {
  it('keeps runtime admission dependencies but excludes legacy Codex runner payloads from the Jangar app image', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
    const controlPlaneStage = dockerfile.match(
      /FROM \$\{BUN_BASE_IMAGE\}:\$\{BUN_VERSION\} AS control-plane[\s\S]*?FROM tools AS runtime/,
    )?.[0]
    const runtimeStage = dockerfile.match(/FROM tools AS runtime[\s\S]*$/)?.[0]
    const helperSymlinkLines = [
      'ln -sf /app/packages/cx-tools/dist/codex-nats-publish.js /usr/local/bin/codex-nats-publish',
      'ln -sf /app/packages/cx-tools/dist/codex-nats-soak.js /usr/local/bin/codex-nats-soak',
    ]

    expect(controlPlaneStage).toBeDefined()
    expect(runtimeStage).toBeDefined()
    expect(runtimeStage).toContain(
      'COPY --from=jangar-build /app/services/jangar/src/server/control-plane-runtime-admission.ts ./src/server/control-plane-runtime-admission.ts',
    )
    expect(runtimeStage).toContain(
      'COPY --from=agent-contracts-build /app/packages/agent-contracts/dist /app/packages/agent-contracts/dist',
    )
    expect(runtimeStage).toContain(
      'COPY --from=jangar-build /app/services/jangar/src/server/runtime-tooling-config.ts ./src/server/runtime-tooling-config.ts',
    )
    expect(runtimeStage).not.toContain('control-plane-runtime-proof-surface.ts')
    for (const line of helperSymlinkLines) {
      expect(controlPlaneStage).toContain(line)
      expect(runtimeStage).toContain(line)
    }
    expect(dockerfile).not.toContain('/app/services/agents/scripts/codex/codex-nats-publish.ts')
    expect(dockerfile).not.toContain('/app/services/agents/scripts/codex/codex-nats-soak.ts')
    expect(dockerfile).not.toContain('/app/services/jangar/scripts/codex-nats-publish.ts')
    expect(dockerfile).not.toContain('/app/services/jangar/scripts/codex-nats-soak.ts')
    expect(runtimeStage).not.toContain('COPY --from=jangar-build /app/services/jangar/scripts/codex ./scripts/codex')
    expect(runtimeStage).not.toContain(
      'COPY --from=jangar-build /app/services/jangar/scripts/agent-runner.ts /usr/local/bin/agent-runner',
    )
    expect(runtimeStage).not.toContain('/usr/local/bin/codex-implement')
  })
})
