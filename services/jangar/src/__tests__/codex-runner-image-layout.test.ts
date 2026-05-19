import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('codex runner image layout', () => {
  it('keeps runtime admission dependencies but excludes legacy Codex runner payloads from the Jangar app image', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
    const runtimeStage = dockerfile.match(/FROM tools AS runtime[\s\S]*$/)?.[0]

    expect(runtimeStage).toBeDefined()
    expect(runtimeStage).toContain(
      'COPY --from=jangar-build /app/services/jangar/src/server/control-plane-runtime-admission.ts ./src/server/control-plane-runtime-admission.ts',
    )
    expect(runtimeStage).toContain(
      'COPY --from=jangar-build /app/services/jangar/src/server/control-plane-runtime-proof-surface.ts ./src/server/control-plane-runtime-proof-surface.ts',
    )
    expect(runtimeStage).toContain(
      'COPY --from=jangar-build /app/services/jangar/src/server/runtime-tooling-config.ts ./src/server/runtime-tooling-config.ts',
    )
    expect(runtimeStage).toContain(
      'COPY --from=jangar-build /app/services/jangar/scripts/codex-nats-publish.ts /usr/local/bin/codex-nats-publish',
    )
    expect(runtimeStage).toContain(
      'COPY --from=jangar-build /app/services/jangar/scripts/codex-nats-soak.ts /usr/local/bin/codex-nats-soak',
    )
    expect(runtimeStage).not.toContain('COPY --from=jangar-build /app/services/jangar/scripts/codex ./scripts/codex')
    expect(runtimeStage).not.toContain(
      'COPY --from=jangar-build /app/services/jangar/scripts/agent-runner.ts /usr/local/bin/agent-runner',
    )
    expect(runtimeStage).not.toContain('/usr/local/bin/codex-implement')
  })

  it('keeps the standalone codex image entrypoint in the same relative layout as its source imports', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile.codex', import.meta.url), 'utf8')

    expect(dockerfile).toContain('COPY services/jangar/scripts/codex /app/services/jangar/scripts/codex')
    expect(dockerfile).toContain(
      'COPY services/jangar/src/server/control-plane-runtime-admission.ts /app/services/jangar/src/server/control-plane-runtime-admission.ts',
    )
    expect(dockerfile).toContain(
      'COPY services/jangar/src/server/control-plane-runtime-proof-surface.ts /app/services/jangar/src/server/control-plane-runtime-proof-surface.ts',
    )
    expect(dockerfile).toContain(
      'COPY services/jangar/src/server/runtime-tooling-config.ts /app/services/jangar/src/server/runtime-tooling-config.ts',
    )
    expect(dockerfile).toContain(
      'ln -sf /app/services/jangar/scripts/codex/codex-implement.ts /usr/local/bin/codex-implement',
    )
  })
})
