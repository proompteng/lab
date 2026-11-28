import { describe, expect, it } from 'bun:test'
import YAML from 'yaml'
import { parseRunBatch, prepareRunBatch } from '../cli/run-batch'

const manifest = (name: string, spec: Record<string, unknown> = {}) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: { name },
  spec: {
    agentRef: { name: 'codex-agent' },
    runtime: { type: 'job' },
    implementation: { inline: { text: 'Implement a task on ${head}.' } },
    parameters: { head: `codex/${name}` },
    ...spec,
  },
})

describe('AgentRun batch preflight', () => {
  it('reads YAML documents, a JSON array, and a Kubernetes List', () => {
    const items = [manifest('first'), manifest('second')]
    const variants = [
      items.map((item) => YAML.stringify(item)).join('---\n'),
      JSON.stringify(items),
      JSON.stringify({ apiVersion: 'v1', kind: 'List', items }),
    ]
    for (const content of variants) {
      const entries = prepareRunBatch(parseRunBatch(content, 'fixture', true), new Map())
      expect(entries.map(({ manifest, prompts }) => [manifest.metadata.namespace, prompts[0]])).toEqual([
        ['fixture', 'Implement a task on codex/first.'],
        ['fixture', 'Implement a task on codex/second.'],
      ])
    }
  })

  it('rejects duplicate effective branches, including aliases and workflow step overrides', () => {
    const entries = parseRunBatch(
      JSON.stringify([
        manifest('first', { parameters: { headBranch: ' codex/shared ' } }),
        manifest('second', {
          runtime: { type: 'workflow' },
          workflow: { steps: [{ name: 'implement', parameters: { head: 'codex/shared' } }] },
        }),
      ]),
      'fixture',
      false,
    )
    expect(() => prepareRunBatch(entries, new Map())).toThrow('Batch entry 2: duplicate head branch')
  })

  it('rejects service account overrides even without --verify', () => {
    for (const spec of [
      { runtime: { type: 'job', config: { serviceAccountName: 'privileged' } } },
      { workload: { serviceAccountName: 'privileged' } },
      {
        runtime: { type: 'workflow' },
        workflow: { steps: [{ name: 'implement', workload: { serviceAccountName: null } }] },
      },
    ]) {
      expect(() =>
        parseRunBatch(JSON.stringify([manifest('first'), manifest('second', spec)]), 'fixture', false),
      ).toThrow('Batch entry 2: serviceAccountName overrides are forbidden')
    }
  })

  it('requires non-blank prompt sources and rejects run and workflow prompt overrides', () => {
    for (const [spec, error] of [
      [{ implementation: undefined }, 'provide a prompt'],
      [{ implementation: { inline: { text: ' \n ' } } }, 'non-empty prompt'],
      [{ parameters: { prompt: 'ignored' } }, 'parameters.prompt is forbidden'],
      [
        {
          runtime: { type: 'workflow' },
          workflow: { steps: [{ name: 'implement', parameters: { prompt: 'ignored' } }] },
        },
        'parameters.prompt is forbidden',
      ],
    ] as const) {
      expect(() => parseRunBatch(JSON.stringify([manifest('bad', spec)]), 'fixture', false)).toThrow(error)
    }
    const entries = parseRunBatch(
      JSON.stringify([manifest('ref', { implementation: undefined, implementationSpecRef: { name: 'task' } })]),
      'fixture',
      false,
    )
    expect(() => prepareRunBatch(entries, new Map([['task', { text: '  ' }]]))).toThrow(
      'ImplementationSpec must have non-empty spec.text',
    )
    expect(prepareRunBatch(entries, new Map([['task', { text: 'Build ${head}.' }]]))[0].prompts).toEqual([
      'Build codex/ref.',
    ])
  })

  it('rejects malformed documents, empty batches, duplicate names and a different namespace', () => {
    expect(() => parseRunBatch('[]', 'fixture', false)).toThrow('at least one AgentRun')
    expect(() => parseRunBatch(`${YAML.stringify(manifest('first'))}---\nkind: [invalid`, 'fixture', false)).toThrow(
      'Batch document 2: invalid YAML or JSON',
    )
    expect(() => parseRunBatch(JSON.stringify([manifest('same'), manifest('same')]), 'fixture', false)).toThrow(
      'duplicate metadata.name',
    )
    expect(() =>
      parseRunBatch(
        JSON.stringify({ ...manifest('outside'), metadata: { name: 'outside', namespace: 'other' } }),
        'fixture',
        false,
      ),
    ).toThrow('metadata.namespace must match')
  })
})
