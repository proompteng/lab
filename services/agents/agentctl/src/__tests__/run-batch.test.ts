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
      expect(entries.map(({ manifest, tasks }) => [manifest.metadata.namespace, tasks[0].prompt])).toEqual([
        ['fixture', 'Implement a task on codex/first.'],
        ['fixture', 'Implement a task on codex/second.'],
      ])
    }
  })

  it('allows the same head branch in different repositories', () => {
    const entries = parseRunBatch(
      JSON.stringify([
        manifest('frontend', { parameters: { repository: 'owner/frontend', head: 'codex/update' } }),
        manifest('backend', { parameters: { repository: 'owner/backend', head: 'codex/update' } }),
      ]),
      'fixture',
      false,
    )
    expect(prepareRunBatch(entries, new Map())).toHaveLength(2)
  })

  it('rejects duplicate effective branches in the same repository, including aliases and workflow step overrides', () => {
    const entries = parseRunBatch(
      JSON.stringify([
        manifest('first', { parameters: { repository: ' Owner/Repo ', headBranch: ' codex/shared ' } }),
        manifest('second', {
          runtime: { type: 'workflow' },
          parameters: { repo: 'owner/other' },
          workflow: { steps: [{ name: 'implement', parameters: { repo: 'owner/repo', head: 'codex/shared' } }] },
        }),
      ]),
      'fixture',
      false,
    )
    expect(() => prepareRunBatch(entries, new Map())).toThrow('Batch entry 2: duplicate head branch')
  })

  it('allows workflows with a shared default head when every step overrides it', () => {
    const manifests = ['first', 'second'].map((name) =>
      manifest(name, {
        runtime: { type: 'workflow' },
        parameters: { head: 'codex/shared' },
        workflow: {
          steps: [
            { name: 'implement', parameters: { head: `codex/${name}-implement` } },
            { name: 'verify', parameters: { head: `codex/${name}-verify` } },
          ],
        },
      }),
    )
    const entries = parseRunBatch(JSON.stringify(manifests), 'fixture', false)
    expect(prepareRunBatch(entries, new Map()).map(({ tasks }) => tasks.map(({ prompt }) => prompt))).toEqual([
      ['Implement a task on codex/first-implement.', 'Implement a task on codex/first-verify.'],
      ['Implement a task on codex/second-implement.', 'Implement a task on codex/second-verify.'],
    ])
  })

  it('rejects collisions between steps that inherit the same default head', () => {
    const manifests = ['first', 'second'].map((name) =>
      manifest(name, {
        runtime: { type: 'workflow' },
        parameters: { head: 'codex/shared' },
        workflow: {
          steps: [{ name: 'implement', parameters: { head: `codex/${name}` } }, { name: 'verify' }],
        },
      }),
    )
    const entries = parseRunBatch(JSON.stringify(manifests), 'fixture', false)
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

  it('rejects the runtime serviceAccount alias even without --verify', () => {
    const overridden = manifest('second', { runtime: { type: 'job', config: { serviceAccount: 'other-sa' } } })
    expect(() => parseRunBatch(JSON.stringify([manifest('first'), overridden]), 'fixture', false)).toThrow(
      'Batch entry 2: serviceAccount overrides are forbidden',
    )
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
    expect(prepareRunBatch(entries, new Map([['task', { text: 'Build ${head}.' }]]))[0].tasks[0].prompt).toBe(
      'Build codex/ref.',
    )
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
