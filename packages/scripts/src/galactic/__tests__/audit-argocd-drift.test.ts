import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

import { audit, renderMarkdown, snapshotSchema } from '../audit-argocd-drift-core'

const authorizedStage = 'kargo.akuity.io/authorized-stage'
const trackingId = 'argocd.argoproj.io/tracking-id'
const syncOptions = 'argocd.argoproj.io/sync-options'
const compareOptions = 'argocd.argoproj.io/compare-options'
const secretMarker = 'private-fixture-marker-not-for-output'

const source = { repoURL: 'https://example.test/config.git', path: 'apps', targetRevision: 'main' }
const app = (
  name: string,
  status: Record<string, unknown> = {},
  spec: Record<string, unknown> = {},
  annotations: Record<string, string> = {},
) => ({
  apiVersion: 'argoproj.io/v1alpha1',
  kind: 'Application',
  metadata: { name, namespace: 'argocd', annotations },
  spec: {
    source,
    destination: { server: 'https://kubernetes.default.svc' },
    syncPolicy: { automated: {} },
    ...spec,
  },
  status: { sync: { status: 'OutOfSync' }, health: { status: 'Healthy' }, ...status },
})
const claim = {
  version: 'v1',
  kind: 'PersistentVolumeClaim',
  namespace: 'forgejo',
  name: 'upgrade-backup',
  status: 'OutOfSync',
  requiresPruning: true,
}
const differentDeployment = {
  group: 'apps',
  version: 'v1',
  kind: 'Deployment',
  namespace: 'forgejo',
  name: 'web',
  status: 'OutOfSync',
}
const liveClaim = (annotations: Record<string, string> = {}) => ({
  apiVersion: 'v1',
  kind: claim.kind,
  metadata: {
    namespace: claim.namespace,
    name: claim.name,
    annotations: {
      [trackingId]: 'forgejo:/PersistentVolumeClaim:forgejo/upgrade-backup',
      [syncOptions]: 'Prune=false, Delete=false',
      ...annotations,
    },
  },
})
const report = (items: unknown[], liveResources: unknown[] = []) =>
  audit(snapshotSchema.parse({ items, liveResources }))

describe('retained tracking-ID drift', () => {
  test('confirms only the reported live-only differences with current, self-referencing Prune=false evidence', () => {
    const [entry] = report(
      [
        app('forgejo', {
          resources: [
            claim,
            { ...differentDeployment, status: 'Synced' },
            { ...differentDeployment, name: 'hook', hook: true },
          ],
        }),
      ],
      [liveClaim()],
    )

    expect(entry?.finding?.classification).toBe('retained_prune_false_orphan')
    expect(entry?.resources).toEqual([
      {
        group: '',
        kind: 'PersistentVolumeClaim',
        namespace: 'forgejo',
        name: 'upgrade-backup',
        status: 'OutOfSync',
        retention: 'confirmed',
      },
    ])
  })

  test('handles the destination namespace in the tracking ID of a cluster-scoped object', () => {
    const [entry] = report(
      [app('root', { resources: [{ ...claim, kind: 'Namespace', namespace: '', name: 'retained-project' }] })],
      [
        {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: 'retained-project',
            annotations: { [trackingId]: 'root:/Namespace:argocd/retained-project', [syncOptions]: 'Prune=false' },
          },
        },
      ],
    )

    expect(entry?.finding?.classification).toBe('retained_prune_false_orphan')
  })

  test('keeps mixed desired-state drift actionable even when one orphan is verified', () => {
    const items = [app('forgejo', { resources: [differentDeployment, claim] })]
    const result = report(items, [liveClaim()])

    expect(result[0]?.finding?.classification).toBe('degraded_workload')
    expect(result[0]?.resources.map(({ retention }) => retention)).toEqual(['confirmed', 'not_applicable'])
  })

  test('does not infer retention from plain Application status, even for a backup-named PVC', () => {
    const [entry] = report([app('forgejo', { resources: [claim] })])

    expect(entry?.finding?.classification).toBe('degraded_workload')
    expect(entry?.resources[0]?.retention).toBe('metadata_unavailable')
  })

  const nonRetainingAnnotations: Record<string, string>[] = [
    { [trackingId]: 'other-app:/PersistentVolumeClaim:forgejo/upgrade-backup' },
    { [trackingId]: 'forgejo:/PersistentVolumeClaim:forgejo/copied-from' },
    { [trackingId]: 'forgejo:/PersistentVolumeClaim:wrong-namespace/upgrade-backup' },
    { [syncOptions]: 'Delete=false,Prune=confirm' },
    { [syncOptions]: 'NotPrune=false' },
  ]
  test.each(nonRetainingAnnotations)(
    'does not confirm nonmatching tracking or a different sync option: %j',
    (annotations) => {
      const [entry] = report([app('forgejo', { resources: [claim] })], [liveClaim(annotations)])

      expect(entry?.finding?.classification).toBe('degraded_workload')
      expect(entry?.resources[0]?.retention).toBe('not_confirmed')
    },
  )

  test('does not attribute application drift to an ignored extra or a resource still desired in Git', () => {
    const [ignored, stillDesired] = [
      report([app('forgejo', { resources: [claim] })], [liveClaim({ [compareOptions]: 'IgnoreExtraneous' })])[0],
      report([app('forgejo', { resources: [{ ...claim, requiresPruning: false }] })], [liveClaim()])[0],
    ]

    expect(ignored?.resources[0]?.retention).toBe('ignored_extraneous')
    expect(stillDesired?.resources[0]?.retention).toBe('not_applicable')
    expect(ignored?.finding?.classification).toBe('degraded_workload')
    expect(stillDesired?.finding?.classification).toBe('degraded_workload')
  })
})

describe('application triage', () => {
  test('classifies missing state, progressing, running, and failed workloads without treating health as sync', () => {
    const results = report(
      [
        app('initial', { sync: undefined, health: undefined }),
        app('healthy', { sync: { status: 'Synced' } }),
        app('rolling', { sync: { status: 'Synced' }, health: { status: 'Progressing' } }),
        app('updating', { operationState: { phase: 'Running' } }),
        app('broken', { health: { status: 'Degraded' }, operationState: { phase: 'Running' } }),
        app('compare-error', { resources: [claim], conditions: [{ type: 'ComparisonError', message: secretMarker }] }),
      ],
      [liveClaim({ [trackingId]: 'compare-error:/PersistentVolumeClaim:forgejo/upgrade-backup' })],
    )

    expect(results.map(({ name, finding }) => [name, finding?.classification ?? null])).toEqual([
      ['broken', 'degraded_workload'],
      ['compare-error', 'degraded_workload'],
      ['healthy', null],
      ['initial', 'degraded_workload'],
      ['rolling', 'rollout_progressing'],
      ['updating', 'rollout_progressing'],
    ])
    expect(results.find(({ name }) => name === 'initial')).toMatchObject({ sync: 'Unknown', health: 'Unknown' })
  })

  test.each([
    [undefined, false],
    [null, false],
    [{ enabled: false, selfHeal: true }, false],
    [{}, true],
    [{ enabled: null }, true],
    [{ enabled: true }, true],
  ] as const)('interprets Argo sync policy automated=%j as enabled=%j', (automated, enabled) => {
    const [entry] = report([app('manual-policy', {}, { syncPolicy: { automated } })])

    expect(entry?.autoSync).toBe(enabled)
    expect(entry?.finding?.classification).toBe(enabled ? 'degraded_workload' : 'manual_autosync_disabled')
    expect(entry?.management).toEqual({ kind: 'static_gitops' })
  })
})

describe('Kargo branch and revision evidence', () => {
  const authorization = { [authorizedStage]: 'product-release:inventory' }
  const kargoSource = { ...source, targetRevision: 'kargo/inventory' }
  const before = 'a'.repeat(40)
  const after = 'b'.repeat(40)
  const compared = { status: 'OutOfSync', revision: after, comparedTo: { source: kargoSource } }
  const history = [
    { id: 7, source: kargoSource, revision: before },
    { id: 3, source: kargoSource, revision: after },
  ]

  test('uses the authorized Stage rather than application name and compares against the highest deployment ID', () => {
    const [entry] = report([
      app('inventory-worker', { sync: compared, history }, { source: kargoSource, syncPolicy: {} }, authorization),
    ])

    expect(entry?.management).toEqual({ kind: 'kargo', tracking: 'verified', expectedBranches: ['kargo/inventory'] })
    expect(entry?.finding?.classification).toBe('kargo_promotion_pending')
  })

  test('does not call ordinary drift, an unrelated comparison, or a failed operation a pending promotion', () => {
    const statuses = [
      { sync: { ...compared, revision: before }, history },
      { sync: { ...compared, comparedTo: { source } }, history },
      { sync: compared, history: [{ ...history[0], source }] },
      { sync: compared },
      { sync: compared, history, operationState: { phase: 'Failed' } },
      { sync: compared, history, resources: [claim] },
    ]
    for (const status of statuses) {
      const [entry] = report([app('inventory-worker', status, { source: kargoSource }, authorization)])
      expect(entry?.finding?.classification).toBe('degraded_workload')
    }
  })

  test('does not attribute same-branch renderer changes to a pending promotion', () => {
    const previousSource = { ...kargoSource, helm: { values: 'replicas: 1' } }
    const currentSource = { ...kargoSource, helm: { values: 'replicas: 2' } }
    const [entry] = report([
      app(
        'inventory-worker',
        {
          sync: { ...compared, comparedTo: { source: currentSource } },
          history: [{ id: 7, source: previousSource, revision: before }],
        },
        { source: currentSource },
        authorization,
      ),
    ])

    expect(entry?.finding?.classification).toBe('degraded_workload')
  })

  test('checks the active sources of a multi-source Application without attributing side-source changes to Kargo', () => {
    const sources = [{ ...source, chart: 'helm-service' }, kargoSource]
    const spec = { source, sources }
    const status = {
      sync: { status: 'OutOfSync', revisions: ['1.2.3', after], comparedTo: { sources } },
      history: [{ id: 1, sources, revisions: ['1.2.3', before] }],
    }
    const bothChanged = { ...status, sync: { ...status.sync, revisions: ['2.0.0', after] } }
    const results = report([
      app('stage-changed', status, spec, authorization),
      app('both-changed', bothChanged, spec, authorization),
      app(
        'wrong-branch',
        status,
        { sources: [...sources, { ...source, targetRevision: 'kargo/wrong' }] },
        authorization,
      ),
    ])

    expect(results.map(({ name, finding, management }) => [name, finding?.classification, management])).toEqual([
      [
        'both-changed',
        'degraded_workload',
        { kind: 'kargo', tracking: 'verified', expectedBranches: ['kargo/inventory'] },
      ],
      [
        'stage-changed',
        'kargo_promotion_pending',
        { kind: 'kargo', tracking: 'verified', expectedBranches: ['kargo/inventory'] },
      ],
      [
        'wrong-branch',
        'degraded_workload',
        { kind: 'kargo', tracking: 'mismatch', expectedBranches: ['kargo/inventory'] },
      ],
    ])
  })

  test('reports revision configuration problems even for healthy apps without printing raw target revisions', () => {
    const entries = report([
      app('branch-only', {}, { source: kargoSource }),
      app('bad-authorization', {}, { source: kargoSource }, { [authorizedStage]: secretMarker }),
      app(
        'healthy-mismatch',
        { sync: { status: 'Synced' } },
        { source: { ...source, targetRevision: secretMarker } },
        authorization,
      ),
    ])

    expect(entries.map(({ management }) => management)).toEqual([
      { kind: 'kargo', tracking: 'unverifiable', expectedBranches: [] },
      { kind: 'kargo', tracking: 'unverifiable', expectedBranches: [] },
      { kind: 'kargo', tracking: 'mismatch', expectedBranches: ['kargo/inventory'] },
    ])
    expect(entries[2]?.finding).toBeNull()
    expect(entries[2]?.trackingRecommendation).toContain('authorized Stage')
    expect(JSON.stringify(entries)).not.toContain(secretMarker)
    expect(renderMarkdown(entries)).not.toContain(secretMarker)
  })
})

const script = fileURLToPath(new URL('../audit-argocd-drift.ts', import.meta.url))
const run = (args: string[], path: string) =>
  Bun.spawnSync([process.execPath, script, ...args], { env: { ...process.env, PATH: path } })
const withTempDir = (callback: (directory: string) => void) => {
  const directory = mkdtempSync(join(tmpdir(), 'argocd-drift-test-'))
  try {
    callback(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
const writeKubectl = (directory: string, script: string) => {
  const executable = join(directory, 'kubectl')
  writeFileSync(executable, '#!' + process.execPath + '\n' + script)
  chmodSync(executable, 0o700)
}

describe('CLI boundary', () => {
  test('reports deterministic JSON and Markdown from fixtures without kubectl or raw data in output', () => {
    withTempDir((directory) => {
      const fixture = join(directory, 'snapshot.json')
      const resources = [claim, differentDeployment]
      const items = [
        app(
          'forgejo',
          {
            health: { status: 'Healthy', message: secretMarker },
            resources,
          },
          { source: { ...source, repoURL: 'https://' + secretMarker + '@example.test/config.git' } },
        ),
        app('a-ready-app', { sync: { status: 'Synced' } }, {}, { notes: secretMarker }),
      ]
      const liveResources = [liveClaim({ 'kubectl.kubernetes.io/last-applied-configuration': secretMarker })]
      writeFileSync(fixture, JSON.stringify({ kind: 'List', items, liveResources }))

      const json = run(['--fixture', fixture, '--format', 'json'], directory)
      const markdown = run(['--fixture', fixture, '--format', 'markdown'], directory)
      expect(json.exitCode).toBe(0)
      expect(markdown.exitCode).toBe(0)
      expect(json.stderr.toString() + markdown.stderr.toString()).toBe('')
      expect(JSON.parse(json.stdout.toString())).toEqual({ applications: report(items, liveResources) })
      expect(markdown.stdout.toString()).toContain('Reviewed 2 applications in `argocd`; 1 not Synced/Healthy.')
      expect(markdown.stdout.toString()).toContain('Recommendation: Inspect Argo conditions')
      expect(json.stdout.toString() + markdown.stdout.toString()).not.toContain(secretMarker)

      items.reverse()
      resources.reverse()
      writeFileSync(fixture, JSON.stringify({ kind: 'List', items, liveResources }))
      expect(run(['--fixture', fixture, '--format', 'json'], directory).stdout.toString()).toBe(json.stdout.toString())
      expect(run(['--fixture', fixture], directory).stdout.toString()).toBe(markdown.stdout.toString())
    })
  })

  test('live mode only lists Applications and gets distinct local prune candidates by name', () => {
    withTempDir((directory) => {
      const calls = join(directory, 'calls.jsonl')
      const live = liveClaim()
      const unavailable = { ...claim, name: 'unavailable' }
      const items = [
        app('forgejo', { resources: [claim] }),
        app('local-other', { resources: [claim, unavailable, { ...claim, kind: 'Secret' }, differentDeployment] }),
        app(
          'remote',
          { resources: [claim, { ...claim, name: 'remote-only' }] },
          { destination: { name: 'elsewhere' } },
        ),
      ]
      writeKubectl(
        directory,
        [
          'import { appendFileSync } from "node:fs"',
          'const args = process.argv.slice(2)',
          'appendFileSync(' + JSON.stringify(calls) + ', JSON.stringify(args) + "\\n")',
          'console.error(' + JSON.stringify(secretMarker) + ')',
          'if (args[3] === "applications") console.log(' +
            JSON.stringify(JSON.stringify({ kind: 'List', items })) +
            ')',
          'else if (args[4] === "upgrade-backup") console.log(' + JSON.stringify(JSON.stringify(live)) + ')',
          'else process.exit(1)',
        ].join('\n'),
      )

      const result = run(['--format', 'json'], directory)
      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString()).toBe('')
      expect(result.stdout.toString()).not.toContain(secretMarker)
      expect(JSON.parse(result.stdout.toString())).toEqual({ applications: report(items, [live]) })
      expect(
        readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([
        ['-n', 'argocd', 'get', 'applications', '-o', 'json', '--request-timeout=15s'],
        ['-n', 'forgejo', 'get', 'PersistentVolumeClaim', 'unavailable', '-o', 'json', '--request-timeout=15s'],
        ['-n', 'forgejo', 'get', 'PersistentVolumeClaim', 'upgrade-backup', '-o', 'json', '--request-timeout=15s'],
      ])
    })
  })

  test('fails closed on list errors, invalid fixture data, and invalid CLI arguments', () => {
    withTempDir((directory) => {
      const fixture = join(directory, 'invalid.json')
      writeFileSync(
        fixture,
        JSON.stringify({ items: [{ metadata: { name: 'https://example.test/' + secretMarker } }] }),
      )
      writeKubectl(directory, 'console.error(' + JSON.stringify(secretMarker) + '); process.exit(1)')
      const invalidArgs = ['--format', secretMarker]
      for (const [args, message] of [
        [[], 'Unable to list Argo CD Applications'],
        [['--fixture', fixture], 'Invalid audit input at items.0.metadata.name'],
        [['--fixture', join(directory, secretMarker)], 'Unable to read the fixture file'],
        [invalidArgs, 'Usage:'],
      ] as const) {
        const result = run([...args], directory)
        expect(result.exitCode).toBe(1)
        expect(result.stdout.toString()).toBe('')
        expect(result.stderr.toString()).toContain(message)
        expect(result.stderr.toString()).not.toContain(secretMarker)
      }
    })
  })
})
