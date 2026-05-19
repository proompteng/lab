import { describe, expect, it } from 'vitest'

import {
  AGENT_RUNNER_SCHEMA_VERSION,
  buildTemplateContext,
  renderOutputArtifacts,
  renderTemplate,
  resolveAdapter,
  type AgentRunnerSpec,
} from './spec'

describe('agent-runner spec', () => {
  it('defaults Codex providers to the app-server adapter', () => {
    const adapter = resolveAdapter({ provider: 'codex-runner' })

    expect(adapter).toEqual({
      type: 'codex-app-server',
      codex: {},
    })
  })

  it('preserves legacy binary providers through the exec adapter', () => {
    const spec: AgentRunnerSpec = {
      provider: 'smoke-runner',
      providerSpec: {
        binary: '/bin/sh',
        argsTemplate: ['-c', 'echo {{inputs.stage}}'],
      },
      inputs: {
        stage: 'verify',
      },
    }

    const adapter = resolveAdapter(spec)
    expect(adapter.type).toBe('exec')
    if (adapter.type !== 'exec') throw new Error('expected exec adapter')

    const args = adapter.provider.argsTemplate?.map((arg) => renderTemplate(arg, buildTemplateContext(spec)))
    expect(adapter.provider.binary).toBe('/bin/sh')
    expect(args).toEqual(['-c', 'echo verify'])
  })

  it('requires a supported schema version', () => {
    expect(() =>
      resolveAdapter({
        schemaVersion: 'agents.proompteng.ai/runner/v0',
        provider: 'codex',
      }),
    ).toThrow('Unsupported agent-runner schemaVersion')

    expect(resolveAdapter({ schemaVersion: AGENT_RUNNER_SCHEMA_VERSION, provider: 'codex' }).type).toBe(
      'codex-app-server',
    )
  })

  it('renders outputArtifact path, key, and url templates', () => {
    expect(
      renderOutputArtifacts(
        [
          {
            name: 'codex-artifact',
            path: '/workspace/{{ inputs.stage }}/artifact.json',
            key: 'codex-research/{{ inputs.run }}/artifact.json',
            url: 's3://{{ inputs.bucket }}/codex-research/{{ inputs.run }}/artifact.json',
          },
        ],
        buildTemplateContext({
          provider: 'codex',
          inputs: {
            stage: 'research',
            run: 'run-1',
            bucket: 'argo-workflows',
          },
        }),
      ),
    ).toEqual([
      {
        name: 'codex-artifact',
        path: '/workspace/research/artifact.json',
        key: 'codex-research/run-1/artifact.json',
        url: 's3://argo-workflows/codex-research/run-1/artifact.json',
      },
    ])
  })
})
