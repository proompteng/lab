import { describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatCephStorageReclamation, planCephStorageReclamation } from '../plan-ceph-storage-reclamation-core'

const TIB = 1024 ** 4
const KIB_PER_TIB = TIB / 1024
const driver = 'rook-ceph.rbd.csi.ceph.com'
const retained = { 'argocd.argoproj.io/sync-options': 'Prune=false, Delete=false' }
const list = <T>(items: T[] = []) => ({ items })
const meta = (name: string, namespace = 'observability') => ({
  name,
  namespace,
  uid: `uid-${namespace}-${name}`,
  creationTimestamp: '2026-10-01T00:00:00Z',
  annotations: retained as Record<string, string>,
  labels: {} as Record<string, string>,
  ownerReferences: [] as { kind: string }[],
})

type Source = { kind: string; name: string; namespace?: string }
const claim = (name: string, namespace = 'observability', storage = '1Ti') => ({
  metadata: meta(name, namespace),
  spec: {
    storageClassName: 'rook-ceph-block',
    volumeName: `pv-${namespace}-${name}`,
    dataSource: undefined as Source | undefined,
    dataSourceRef: undefined as Source | undefined,
  },
  status: { phase: 'Bound', capacity: { storage } },
})
type Claim = ReturnType<typeof claim>
const volume = (pvc: Claim, policy = 'Delete') => ({
  metadata: { name: pvc.spec.volumeName },
  spec: {
    claimRef: { name: pvc.metadata.name, namespace: pvc.metadata.namespace, uid: pvc.metadata.uid },
    persistentVolumeReclaimPolicy: policy,
    csi: {
      driver,
      volumeHandle: `handle-${pvc.spec.volumeName}`,
      volumeAttributes: { clusterID: 'rook-ceph', pool: 'replicapool' },
    },
  },
})
const checkpoint = (name: string, source: Claim, restoreSize = '1Ti') => {
  const metadata = meta(name, source.metadata.namespace)
  const contentName = `content-${metadata.namespace}-${name}`
  const snapshot = {
    metadata,
    spec: {
      volumeSnapshotClassName: 'rook-ceph-block',
      source: { persistentVolumeClaimName: source.metadata.name },
    },
    status: { boundVolumeSnapshotContentName: contentName, readyToUse: true, restoreSize },
  }
  return {
    snapshot,
    content: {
      metadata: { name: contentName },
      spec: {
        driver,
        deletionPolicy: 'Delete',
        source: { volumeHandle: volume(source).spec.csi.volumeHandle },
        volumeSnapshotRef: { name, namespace: metadata.namespace, uid: metadata.uid },
      },
      status: { readyToUse: true, snapshotHandle: `snapshot-handle-${contentName}` },
    },
  }
}
const claimMount = (claimName: string) => ({ name: 'data', persistentVolumeClaim: { claimName } })
const pod = (name: string, pvc: Claim, phase?: string) => ({
  metadata: meta(name, pvc.metadata.namespace),
  spec: { volumes: [claimMount(pvc.metadata.name)] },
  status: { phase },
})

type OsdNode = {
  id: number
  kb: number
  kb_used: number
  utilization: number
  reweight: number
  status?: string
  children?: number[]
}
const osd = (id: number, size: number, utilization: number): OsdNode => ({
  id,
  kb: size * KIB_PER_TIB,
  kb_used: Math.round((size * KIB_PER_TIB * utilization) / 100),
  utilization,
  reweight: 1,
  status: 'up',
})
const bucket = (id: number, children: number[]): OsdNode => ({
  id,
  children,
  kb: 0,
  kb_used: 0,
  utilization: 0,
  reweight: -1,
})
const inventory = (claims: Claim[] = [], snapshots: ReturnType<typeof checkpoint>[] = []) => ({
  asOf: '2026-11-28T00:00:00Z',
  pvcs: list(claims),
  pvs: list(claims.map((pvc) => volume(pvc))),
  pods: list<ReturnType<typeof pod>>(),
  deployments: list<{
    metadata: ReturnType<typeof meta>
    spec: { template: { spec: { volumes: ReturnType<typeof claimMount>[] } } }
  }>(),
  statefulSets: list(),
  snapshots: list(snapshots.map(({ snapshot }) => snapshot)),
  snapshotContents: list(snapshots.map(({ content }) => content)),
  cephDf: {
    pools: [
      { id: 4, name: 'replicapool', stats: { bytes_used: 20 * TIB } },
      { id: 2, name: '.mgr', stats: { bytes_used: 1024 } },
    ],
  },
  cephPools: [{ pool: 4, pool_name: 'replicapool', type: 1, size: 2, crush_rule: 0 }],
  cephCrushRules: [{ rule_id: 0, steps: [{ op: 'take', item: -1 }, { op: 'chooseleaf_firstn' }, { op: 'emit' }] }],
  cephOsdDf: {
    nodes: [bucket(-1, [-2, -3]), bucket(-2, [3]), osd(3, 10, 86.07), bucket(-3, [1]), osd(1, 20, 83), osd(8, 5, 80)],
  },
})
const names = (items: { name: string }[]) => items.map((item) => item.name)

describe('Ceph storage reclamation plan', () => {
  it('protects nonterminal Pod and controller references, including future StatefulSet ordinals', () => {
    const running = claim('running-restore')
    const unknown = claim('starting-restore')
    const finished = claim('finished-rehearsal')
    const failed = claim('failed-restore')
    const crossNamespace = claim('running-restore', 'forgejo')
    const deployed = claim('deployment-restore')
    const scaledDown = claim('data-stateful-restore-7')
    const input = inventory([running, unknown, finished, failed, crossNamespace, deployed, scaledDown])
    const plan = planCephStorageReclamation({
      ...input,
      pods: list([
        pod('running', running, 'Running'),
        pod('starting', unknown),
        pod('succeeded', finished, 'Succeeded'),
        pod('failed', failed, 'Failed'),
      ]),
      deployments: list([
        { metadata: meta('restorer'), spec: { template: { spec: { volumes: [claimMount(deployed.metadata.name)] } } } },
      ]),
      statefulSets: list([
        {
          metadata: meta('stateful-restore'),
          spec: {
            replicas: 0,
            template: { spec: {} },
            volumeClaimTemplates: [{ metadata: { name: 'data' }, spec: {} }],
          },
        },
      ]),
    })

    expect(names(plan.protected)).toEqual([
      'data-stateful-restore-7',
      'deployment-restore',
      'running-restore',
      'starting-restore',
    ])
    expect(plan.approvalRequired.map(({ namespace, name }) => `${namespace}/${name}`)).toEqual([
      'forgejo/running-restore',
      'observability/failed-restore',
      'observability/finished-rehearsal',
    ])
  })

  it('protects Bayn, CNPG, and scheduled backups even when one-off names and retention flags match', () => {
    const bayn = claim('evidence-restore', 'bayn')
    const baynAudit = claim('bayn-audit-rehearsal')
    const database = claim('database-restore', 'forgejo')
    database.metadata.labels = { 'cnpg.io/cluster': 'forgejo-db' }
    const owned = claim('owned-restore', 'torghut')
    owned.metadata.ownerReferences = [{ kind: 'Cluster' }]
    const active = claim('primary')
    const ambiguous = claim('unused-data')
    const daily = checkpoint('analytics-upgrade-daily-20261001', active)
    const labeled = checkpoint('analytics-before-3-2-1', active)
    labeled.snapshot.metadata.labels = { 'backup.example.com/schedule': 'keep' }
    const scheduled = checkpoint('analytics-before-3-1-0', active)
    scheduled.snapshot.metadata.ownerReferences = [{ kind: 'ScheduledBackup' }]
    const db = checkpoint('postgres-pre-upgrade-1', database)
    const unclear = checkpoint('analytics-pre-upgrade-1', active)
    unclear.snapshot.metadata.annotations = {}
    const recent = checkpoint('analytics-before-3-3-0', active)
    recent.snapshot.metadata.creationTimestamp = '2026-11-15T00:00:00Z'
    const input = inventory(
      [bayn, baynAudit, database, owned, active, ambiguous],
      [daily, labeled, scheduled, db, unclear, recent],
    )
    const plan = planCephStorageReclamation(input)

    expect(names(plan.protected)).toEqual([
      'evidence-restore',
      'database-restore',
      'postgres-pre-upgrade-1',
      'analytics-before-3-1-0',
      'analytics-before-3-2-1',
      'analytics-upgrade-daily-20261001',
      'bayn-audit-rehearsal',
      'primary',
      'owned-restore',
    ])
    expect(names(plan.zeroRisk)).toEqual(['analytics-before-3-3-0', 'analytics-pre-upgrade-1', 'unused-data'])
    expect(plan.approvalRequired).toEqual([])
  })

  it('blocks cross-namespace restores, PVC clones, claim-template sources, and retained content dependencies', () => {
    const source = claim('live-data', 'stash')
    const cloneSource = claim('older-restore', 'stash')
    const detached = claim('detached-restore')
    const restoring = claim('pending-restore')
    const snap = checkpoint('stash-pre-upgrade-4', source)
    const later = checkpoint('stash-pre-upgrade-5', source)
    const retainedContent = checkpoint('former-rehearsal', detached).content
    retainedContent.spec.deletionPolicy = 'Retain'
    restoring.spec.dataSource = { kind: 'PersistentVolumeClaim', name: cloneSource.metadata.name, namespace: 'stash' }
    restoring.spec.dataSourceRef = { kind: 'VolumeSnapshot', name: snap.snapshot.metadata.name, namespace: 'stash' }
    restoring.status.phase = 'Pending'
    const input = inventory([source, cloneSource, detached, restoring], [snap, later])
    const plan = planCephStorageReclamation({
      ...input,
      snapshotContents: list([...input.snapshotContents.items, retainedContent]),
      statefulSets: list([
        {
          metadata: meta('future-restorer', 'stash'),
          spec: {
            template: { spec: {} },
            volumeClaimTemplates: [
              {
                metadata: { name: 'data' },
                spec: { dataSource: { kind: 'VolumeSnapshot', name: later.snapshot.metadata.name } },
              },
            ],
          },
        },
      ]),
    })

    expect(names(plan.protected)).toEqual([
      'detached-restore',
      'live-data',
      'older-restore',
      'stash-pre-upgrade-4',
      'stash-pre-upgrade-5',
    ])
    expect(names(plan.zeroRisk)).toEqual(['pending-restore'])
    expect(plan.approvalRequired).toEqual([])
  })

  it('withholds credit for incomplete bindings, Retain policies, and ambiguous sizes', () => {
    const source = claim('primary')
    const pvRetain = claim('retained-restore')
    const missingSize = claim('unknown-restore', 'observability', '2 parsecs')
    const identityMismatch = claim('broken-restore')
    const snapRetain = checkpoint('analytics-before-3-2-1', source)
    snapRetain.content.spec.deletionPolicy = 'Retain'
    const mismatch = checkpoint('analytics-before-3-1-0', source)
    mismatch.content.spec.volumeSnapshotRef.uid = 'stale'
    const notReady = checkpoint('analytics-before-3-0-0', source)
    notReady.snapshot.status.readyToUse = false
    const input = inventory([source, pvRetain, missingSize, identityMismatch], [snapRetain, mismatch, notReady])
    input.pvs.items[1].spec.persistentVolumeReclaimPolicy = 'Retain'
    input.pvs.items[3].spec.claimRef.uid = 'stale'
    const plan = planCephStorageReclamation(input)

    expect(names(plan.zeroRisk)).toEqual([
      'analytics-before-3-0-0',
      'analytics-before-3-1-0',
      'analytics-before-3-2-1',
      'broken-restore',
      'retained-restore',
      'unknown-restore',
    ])
    expect(plan.approvalRequired).toEqual([])
    expect(plan.pools.find(({ name }) => name === 'replicapool')?.projectedRawBytes).toBe(20 * TIB)
    expect(plan.osds.find(({ id }) => id === 3)?.projectedPercent).toBe(86.07)
  })

  it('ranks detached claims and one-off checkpoints, credits one per source image, and limits OSDs to the pool root', () => {
    const source = claim('primary')
    const restore = claim('detached-restore', 'temporal', '1024Gi')
    const newer = checkpoint('observability-grafana-before-13-3-1', source)
    const older = checkpoint('observability-grafana-before-13-2-1', source, '0.5Ti')
    const input = inventory([source, restore], [newer, older])
    input.pods.items.push(pod('active', source, 'Running'))
    const plan = planCephStorageReclamation(input)

    expect(
      plan.approvalRequired.map(({ name, logicalBytes, scenarioRawBytes }) => [name, logicalBytes, scenarioRawBytes]),
    ).toEqual([
      ['observability-grafana-before-13-3-1', TIB, 2 * TIB],
      ['detached-restore', TIB, 2 * TIB],
      ['observability-grafana-before-13-2-1', TIB / 2, 0],
    ])
    expect(plan.pools).toEqual([
      { name: '.mgr', currentRawBytes: 1024, projectedRawBytes: 1024 },
      { name: 'replicapool', currentRawBytes: 20 * TIB, projectedRawBytes: 16 * TIB },
    ])
    const nearfull = plan.osds.find(({ id }) => id === 3)
    expect(nearfull?.currentPercent).toBe(86.07)
    expect(nearfull?.projectedPercent).toBeCloseTo(72.736666, 5)
    expect(nearfull?.belowTargetInScenario).toBe(true)
    expect(plan.osds.find(({ id }) => id === 8)?.projectedPercent).toBe(80)
    expect(plan.osdProjectionNote).toBeNull()
    const markdown = formatCephStorageReclamation(plan, 'markdown')
    expect(markdown).toContain('Zero-risk: read-only verification only')
    expect(markdown).toContain('Approval required: potential reclamation candidates')
    expect(markdown).toContain('| osd.3 | 86.07% | 72.74% | Yes |')
    for (const listing of [input.pvcs, input.pvs, input.snapshots, input.snapshotContents]) listing.items.reverse()
    input.cephOsdDf.nodes.reverse()
    input.cephDf.pools.reverse()
    const reordered = planCephStorageReclamation(input)
    expect(formatCephStorageReclamation(reordered, 'json')).toBe(formatCephStorageReclamation(plan, 'json'))
    expect(formatCephStorageReclamation(reordered, 'markdown')).toBe(markdown)
  })

  it('caps savings and leaves unsupported CRUSH or down in-OSDs unprojected', () => {
    const input = inventory([claim('detached-restore', 'stash', '5000G')])
    input.cephDf.pools[0].stats.bytes_used = 2 * TIB
    expect(planCephStorageReclamation(input).approvalRequired[0].scenarioRawBytes).toBe(2 * TIB)
    input.cephOsdDf.nodes[2].status = 'down'
    const plan = planCephStorageReclamation(input)
    expect(plan.osdProjectionNote).toContain('OSD scenario unavailable')
    expect(plan.osds.every((osd) => osd.projectedPercent === null && osd.belowTargetInScenario === null)).toBe(true)
    input.cephOsdDf.nodes[2].status = 'up'
    input.cephCrushRules[0].steps[0].item = -42
    expect(planCephStorageReclamation(input).osdProjectionNote).toContain('unsupported placement')
  })

  it('treats exactly 75% as not below target and fails closed on missing or truncated inventory', () => {
    const input = inventory()
    input.cephOsdDf.nodes[2] = osd(3, 10, 75)
    expect(planCephStorageReclamation(input).osds.find(({ id }) => id === 3)?.belowTargetInScenario).toBe(false)
    expect(() => planCephStorageReclamation({ ...input, pods: undefined })).toThrow(
      'Invalid or incomplete inventory: pods',
    )
    expect(() =>
      planCephStorageReclamation({ ...input, deployments: { ...list(), metadata: { continue: 'another-page' } } }),
    ).toThrow('Invalid or incomplete inventory: deployments')
    const duplicate = claim('duplicates-restore')
    expect(() => planCephStorageReclamation(inventory([duplicate, duplicate]))).toThrow('duplicate PVC')
  })
})

describe('Ceph storage reclamation CLI', () => {
  const cli = join(import.meta.dir, '../plan-ceph-storage-reclamation.ts')
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const subprocess = Bun.spawn([process.execPath, cli, ...args], {
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, out, err] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ])
    return { code, out, err }
  }

  it('replays a fixture without kubectl and fails without printing malformed input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ceph-reclamation-'))
    try {
      const path = join(dir, 'inventory.json')
      const input = inventory([claim('test-restore')])
      await Bun.write(path, JSON.stringify(input))
      const json = await run(['--fixture', path, '--format', 'json'], { PATH: dir })
      expect(json).toEqual({
        code: 0,
        out: formatCephStorageReclamation(planCephStorageReclamation(input), 'json'),
        err: '',
      })
      const markdown = await run(['--fixture', path], { PATH: dir })
      expect(markdown.out).toContain('read-only verification only')
      expect((await run(['--fixture', path, '--context', 'galactic-lan'])).code).toBe(1)
      expect((await run(['--fixture', path, '--format', 'yaml'])).code).toBe(1)

      await Bun.write(path, '{not-json: DO_NOT_ECHO}')
      const invalid = await run(['--fixture', path])
      expect(invalid.code).toBe(1)
      expect(invalid.out).toBe('')
      expect(invalid.err).toContain('Unable to read fixture as JSON')
      expect(invalid.err).not.toContain('DO_NOT_ECHO')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('only issues the explicit live read commands and stops on a denied listing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ceph-reclamation-'))
    try {
      const input = inventory()
      const namespaced = ' --all-namespaces -o json'
      const ceph = '-n rook-ceph exec deploy/rook-ceph-tools -c rook-ceph-tools -- ceph '
      const responses = {
        [`get persistentvolumeclaims${namespaced}`]: input.pvcs,
        'get persistentvolumes -o json': input.pvs,
        [`get pods${namespaced}`]: input.pods,
        [`get deployments.apps${namespaced}`]: input.deployments,
        [`get statefulsets.apps${namespaced}`]: input.statefulSets,
        [`get volumesnapshots.snapshot.storage.k8s.io${namespaced}`]: input.snapshots,
        'get volumesnapshotcontents.snapshot.storage.k8s.io -o json': input.snapshotContents,
        [`${ceph}df --format json`]: input.cephDf,
        [`${ceph}osd df tree --format json`]: input.cephOsdDf,
        [`${ceph}osd pool ls detail --format json`]: input.cephPools,
        [`${ceph}osd crush rule dump --format json`]: input.cephCrushRules,
      }
      const kubectl = join(dir, 'kubectl')
      await Bun.write(
        kubectl,
        `#!${process.execPath}
const args = Bun.argv.slice(2)
if (args.slice(0, 3).join(' ') !== '--context galactic-lan --request-timeout=30s') process.exit(10)
const command = args.slice(3).join(' ')
const responses = ${JSON.stringify(responses)}
if (!(command in responses)) process.exit(11)
if (process.env.DENY_DEPLOYMENTS === '1' && command.startsWith('get deployments.apps')) {
  console.error('DO_NOT_ECHO')
  process.exit(12)
}
console.log(JSON.stringify(responses[command]))
`,
      )
      await chmod(kubectl, 0o700)
      const args = ['--context', 'galactic-lan', '--format', 'json']
      const live = await run(args, { PATH: dir })
      expect(live.code).toBe(0)
      expect(live.err).toBe('')
      expect(JSON.parse(live.out).osds).toHaveLength(3)
      const denied = await run(args, { PATH: dir, DENY_DEPLOYMENTS: '1' })
      expect(denied.code).toBe(1)
      expect(denied.out).toBe('')
      expect(denied.err).toContain('Unable to read deployments (kubectl exit 12)')
      expect(denied.err).not.toContain('DO_NOT_ECHO')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
