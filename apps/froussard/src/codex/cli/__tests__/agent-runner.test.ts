import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildTemplateContext, loadAgentRunnerSpec, renderTemplate, resolveProviderSpec } from '../agent-runner'

describe('agent-runner', () => {
  afterEach(() => {
    delete process.env.AGENT_RUNNER_SPEC
    delete process.env.AGENT_RUNNER_SPEC_PATH
  })

  it('renders templates from inputs and payloads', () => {
    const spec = {
      provider: 'codex',
      inputs: { stage: 'implementation' },
      payloads: { eventFilePath: '/tmp/event.json' },
    }
    const context = buildTemplateContext(spec)
    const rendered = renderTemplate('{{inputs.stage}} {{payloads.eventFilePath}} {{inputs.missing}}', context)

    expect(rendered).toBe('implementation /tmp/event.json ')
  })

  it('merges provider overrides', () => {
    const provider = resolveProviderSpec({
      provider: 'codex',
      providerSpec: {
        argsTemplate: ['--override'],
      },
    })

    expect(provider.binary).toBe('/usr/local/bin/codex-implement')
    expect(provider.argsTemplate).toEqual(['--override'])
  })

  it('loads spec from env path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-runner-'))
    const specPath = join(tempDir, 'spec.json')
    await writeFile(specPath, JSON.stringify({ provider: 'codex' }), 'utf8')

    process.env.AGENT_RUNNER_SPEC_PATH = specPath

    const spec = await loadAgentRunnerSpec([])
    expect(spec.provider).toBe('codex')
  })
})
