import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import { buildAgentRunYaml } from '../templates/agent-run'
import { buildImplementationSpecYaml } from '../templates/implementation-spec'

type ImplementationSpecManifest = {
  kind?: string
  metadata?: { name?: string }
  spec?: {
    summary?: string
    text?: string
    acceptanceCriteria?: string[]
    labels?: string[]
    source?: { provider?: string }
  }
}

type AgentRunManifest = {
  kind?: string
  metadata?: { generateName?: string }
  spec?: {
    agentRef?: { name?: string }
    implementationSpecRef?: { name?: string }
    runtime?: { type?: string; config?: { foo?: string } }
    parameters?: { task?: string }
  }
}

describe('templates', () => {
  it('builds ImplementationSpec yaml', () => {
    const yaml = buildImplementationSpecYaml({
      name: 'impl-demo',
      namespace: 'agents',
      summary: 'Ship docs',
      text: 'Write docs.',
      acceptanceCriteria: ['Doc page exists'],
      labels: ['docs'],
      source: { provider: 'manual', externalId: 'demo', url: 'https://example.com' },
    })
    const parsed = YAML.parse(yaml) as ImplementationSpecManifest
    expect(parsed.kind).toBe('ImplementationSpec')
    expect(parsed.metadata?.name).toBe('impl-demo')
    expect(parsed.spec?.summary).toBe('Ship docs')
    expect(parsed.spec?.text).toBe('Write docs.')
    expect(parsed.spec?.acceptanceCriteria).toEqual(['Doc page exists'])
    expect(parsed.spec?.labels).toEqual(['docs'])
    expect(parsed.spec?.source?.provider).toBe('manual')
  })

  it('builds AgentRun yaml', () => {
    const yaml = buildAgentRunYaml({
      generateName: 'agent-',
      namespace: 'agents',
      agentName: 'demo',
      implName: 'impl-demo',
      runtimeType: 'workflow',
      runtimeConfig: { foo: 'bar' },
      parameters: { task: 'docs' },
      memoryRef: 'mem-demo',
      workloadImage: 'ghcr.io/demo/agent:latest',
      cpu: '500m',
      memory: '512Mi',
    })
    const parsed = YAML.parse(yaml) as AgentRunManifest
    expect(parsed.kind).toBe('AgentRun')
    expect(parsed.metadata?.generateName).toBe('agent-')
    expect(parsed.spec?.agentRef?.name).toBe('demo')
    expect(parsed.spec?.implementationSpecRef?.name).toBe('impl-demo')
    expect(parsed.spec?.runtime?.type).toBe('workflow')
    expect(parsed.spec?.parameters?.task).toBe('docs')
    expect(parsed.spec?.runtime?.config?.foo).toBe('bar')
  })
})
