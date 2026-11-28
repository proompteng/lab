import { z } from 'zod'

const RBD_DRIVER = 'rook-ceph.rbd.csi.ceph.com'
const ROOK_CLUSTER = 'rook-ceph'
const TARGET_PERCENT = 75
const MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000
const KIB = 1024
const TIB = 1024 ** 4
const FRACTIONAL_UNITS = new Map([
  ['m', 1e-3],
  ['u', 1e-6],
  ['n', 1e-9],
])

const name = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/)
const nonempty = z.string().min(1)
const bytes = z.int().nonnegative()
const labels = z.record(z.string(), z.string()).default({})
const metadata = z.object({
  name,
  uid: nonempty.optional(),
  creationTimestamp: z.iso.datetime().optional(),
  deletionTimestamp: z.iso.datetime().nullish(),
  labels,
  annotations: labels,
  ownerReferences: z.array(z.object({ kind: nonempty })).default([]),
})
const namespaced = metadata.extend({ namespace: name })
const objectRef = z.object({ name, namespace: name, uid: nonempty.optional() })
const sourceRef = z.object({ kind: nonempty, name, namespace: name.nullish() })
const claimSource = z.object({ dataSource: sourceRef.nullish(), dataSourceRef: sourceRef.nullish() })
const podSpec = z.object({
  volumes: z
    .array(
      z.object({
        name,
        persistentVolumeClaim: z.object({ claimName: name }).optional(),
        ephemeral: z.object({ volumeClaimTemplate: z.object({ spec: claimSource }) }).optional(),
      }),
    )
    .default([]),
})
const controller = z.object({
  metadata: namespaced,
  spec: z.object({
    template: z.object({ spec: podSpec }),
    volumeClaimTemplates: z.array(z.object({ metadata: z.object({ name }), spec: claimSource })).default([]),
  }),
})
const pvc = z.object({
  metadata: namespaced,
  spec: claimSource.extend({ storageClassName: z.string().optional(), volumeName: name.optional() }),
  status: z
    .object({
      phase: nonempty.optional(),
      capacity: z.object({ storage: nonempty.optional() }).optional(),
    })
    .optional(),
})
const pv = z.object({
  metadata,
  spec: z.object({
    claimRef: objectRef.optional(),
    persistentVolumeReclaimPolicy: nonempty.optional(),
    csi: z
      .object({
        driver: nonempty,
        volumeHandle: nonempty,
        volumeAttributes: z
          .object({
            clusterID: nonempty.optional(),
            pool: nonempty.optional(),
            dataPool: nonempty.optional(),
            staticVolume: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  }),
})
const snapshot = z.object({
  metadata: namespaced,
  spec: z.object({
    volumeSnapshotClassName: name.optional(),
    source: z.object({ persistentVolumeClaimName: name.optional(), volumeSnapshotContentName: name.optional() }),
  }),
  status: z
    .object({
      boundVolumeSnapshotContentName: name.optional(),
      readyToUse: z.boolean().optional(),
      restoreSize: nonempty.optional(),
    })
    .optional(),
})
const snapshotContent = z.object({
  metadata,
  spec: z.object({
    driver: nonempty,
    deletionPolicy: nonempty,
    source: z.object({ volumeHandle: nonempty.optional(), snapshotHandle: nonempty.optional() }),
    volumeSnapshotRef: objectRef,
  }),
  status: z.object({ snapshotHandle: nonempty.optional(), readyToUse: z.boolean().optional() }).optional(),
})
const list = <T extends z.ZodType>(item: T) =>
  z.object({
    // A continued page is not negative evidence about consumers.
    metadata: z.object({ continue: z.literal('').optional() }).optional(),
    items: z.array(item),
  })
const osdNode = z.object({
  id: z.int(),
  children: z.array(z.int()).optional(),
  kb: bytes.max(Math.floor(Number.MAX_SAFE_INTEGER / KIB)),
  kb_used: bytes.max(Math.floor(Number.MAX_SAFE_INTEGER / KIB)),
  utilization: z.number().nonnegative(),
  reweight: z.number().min(-1),
  status: nonempty.optional(),
})
const inventory = z.object({
  asOf: z.iso.datetime(),
  pvcs: list(pvc),
  pvs: list(pv),
  pods: list(
    z.object({ metadata: namespaced, spec: podSpec, status: z.object({ phase: nonempty.optional() }).optional() }),
  ),
  deployments: list(controller),
  statefulSets: list(controller),
  snapshots: list(snapshot),
  snapshotContents: list(snapshotContent),
  cephDf: z.object({ pools: z.array(z.object({ id: bytes, name: nonempty, stats: z.object({ bytes_used: bytes }) })) }),
  cephPools: z.array(
    z.object({ pool: bytes, pool_name: nonempty, type: bytes, size: z.int().min(1).max(255), crush_rule: bytes }),
  ),
  cephCrushRules: z.array(
    z.object({ rule_id: bytes, steps: z.array(z.object({ op: nonempty, item: z.int().optional() })) }),
  ),
  cephOsdDf: z.object({ nodes: z.array(osdNode).min(1), stray: z.array(osdNode).default([]) }),
})

type Namespaced = z.infer<typeof namespaced>
type Claim = z.infer<typeof pvc>
type PodSpec = z.infer<typeof podSpec>
type DataSource = z.infer<typeof claimSource>
type Inventory = z.infer<typeof inventory>
type Item = {
  kind: 'PVC' | 'VolumeSnapshot'
  namespace: string
  name: string
  logicalBytes: number | null
  reason: string
}
type Candidate = Item & { logicalBytes: number; pool: string; scenarioRawBytes: number }

const key = (ref: { namespace: string; name: string }) => `${ref.namespace}/${ref.name}`
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const rank = (a: Item, b: Item) =>
  (b.logicalBytes ?? 0) - (a.logicalBytes ?? 0) || compare(key(a), key(b)) || compare(a.kind, b.kind)

const index = <T, K>(values: T[], getKey: (value: T) => K, field: string) => {
  const result = new Map<K, T>()
  for (const value of values) {
    const id = getKey(value)
    if (result.has(id)) throw new Error(`Inventory contains duplicate ${field} entries`)
    result.set(id, value)
  }
  return result
}

const counts = (handles: (string | undefined)[]) => {
  const result = new Map<string, number>()
  for (const handle of handles) if (handle) result.set(handle, (result.get(handle) ?? 0) + 1)
  return result
}

const quantityBytes = (value?: string) => {
  const match = /^(\d+(?:\.\d*)?|\.\d+)([KMGTPE]i|[kMGTPE]|[mun]|[eE][+-]?\d+)?$/.exec(value ?? '')
  if (!match) return null
  const [, amount, suffix = ''] = match
  const power = 'KMGTPE'.indexOf(suffix[0]?.toUpperCase() ?? '?') + 1
  let multiplier = FRACTIONAL_UNITS.get(suffix) ?? 1000 ** power
  if (suffix.endsWith('i')) multiplier = 1024 ** power
  if (/^[eE][+-]?\d/.test(suffix)) multiplier = 10 ** Number(suffix.slice(1))
  const result = Math.ceil(Number(amount) * multiplier)
  return Number.isSafeInteger(result) && result > 0 ? result : null
}

const metadataPairs = (meta: z.infer<typeof metadata>) => [
  ...Object.entries(meta.labels),
  ...Object.entries(meta.annotations),
]
const critical = (meta: Namespaced | z.infer<typeof metadata>) => {
  if (
    ('namespace' in meta && meta.namespace === 'bayn') ||
    [meta.name, ...metadataPairs(meta).flat()].some((part) => /(?:^|[^a-z0-9])bayn(?:$|[^a-z0-9])/i.test(part))
  )
    return 'Bayn storage is protected'
  if (metadataPairs(meta).some(([field]) => field.startsWith('cnpg.io/') || field === 'postgresql')) {
    return 'CloudNativePG-managed storage is protected'
  }
  return null
}

const recurring = (meta: z.infer<typeof metadata>) => {
  const schedule =
    /(?:^|[^a-z0-9])(?:daily|nightly|hourly|weekly|monthly|scheduled|schedule|cron(?:job)?|recurring)(?:backup)?(?:$|[^a-z0-9])/i
  return (
    schedule.test(meta.name) ||
    metadataPairs(meta).some(([field, value]) => schedule.test(field) || schedule.test(value))
  )
}

const restoreArtifact = /(?:^|-)(?:restore|rehearsal)(?:-|$)/
const retainedInGitOps = (meta: Namespaced) => {
  // Galactic's declared one-shot checkpoints carry both Argo retention flags.
  // Names alone are not enough to distinguish an arbitrary scheduled backup.
  const syncOptions = meta.annotations['argocd.argoproj.io/sync-options']?.split(',').map((option) => option.trim())
  return syncOptions?.includes('Prune=false') && syncOptions.includes('Delete=false')
}
const oneOffSnapshot = (meta: Namespaced) =>
  retainedInGitOps(meta) &&
  (/(?:^|-)(?:before|pre-upgrade|upgrade|restore|rehearsal|cutover|pre-nvme)(?:-|$)/.test(meta.name) ||
    (meta.namespace === 'forgejo' && /^forgejo-(?:server|kargo)-\d+-\d+-\d+-data$/.test(meta.name)) ||
    (meta.namespace === 'temporal' &&
      ['cassandra-upgrade', 'cassandra-rf3-backup'].includes(meta.labels['app.kubernetes.io/component'])) ||
    (meta.namespace === 'torghut' && Boolean(meta.annotations['clickhouse.proompteng.ai/backup-id'])))

const references = (input: Inventory) => {
  const claims = new Set<string>()
  const snapshots = new Set<string>()
  const claimTemplates = new Map<string, string[]>()
  const addSource = (namespace: string, source: DataSource) => {
    for (const ref of [source.dataSource, source.dataSourceRef]) {
      if (!ref) continue
      const id = key({ namespace: ref.namespace ?? namespace, name: ref.name })
      if (ref.kind === 'VolumeSnapshot') snapshots.add(id)
      if (ref.kind === 'PersistentVolumeClaim') claims.add(id)
    }
  }
  const addPod = (namespace: string, spec: PodSpec, podName?: string) => {
    for (const volume of spec.volumes) {
      if (volume.persistentVolumeClaim) claims.add(key({ namespace, name: volume.persistentVolumeClaim.claimName }))
      if (volume.ephemeral) {
        if (podName) claims.add(key({ namespace, name: `${podName}-${volume.name}` }))
        addSource(namespace, volume.ephemeral.volumeClaimTemplate.spec)
      }
    }
  }
  for (const pod of input.pods.items) {
    if (pod.status?.phase !== 'Failed' && pod.status?.phase !== 'Succeeded') {
      addPod(pod.metadata.namespace, pod.spec, pod.metadata.name)
    }
  }
  for (const workload of [...input.deployments.items, ...input.statefulSets.items]) {
    const { namespace, name: workloadName } = workload.metadata
    addPod(namespace, workload.spec.template.spec)
    for (const template of workload.spec.volumeClaimTemplates) {
      const prefixes = claimTemplates.get(namespace) ?? []
      prefixes.push(`${template.metadata.name}-${workloadName}-`)
      claimTemplates.set(namespace, prefixes)
      addSource(namespace, template.spec)
    }
  }
  for (const claim of input.pvcs.items) addSource(claim.metadata.namespace, claim.spec)
  for (const snap of input.snapshots.items) {
    const claimName = snap.spec.source.persistentVolumeClaimName
    if (claimName) claims.add(key({ namespace: snap.metadata.namespace, name: claimName }))
  }
  return {
    snapshots,
    usesClaim: (meta: Namespaced) =>
      claims.has(key(meta)) ||
      (claimTemplates.get(meta.namespace) ?? []).some(
        (prefix) => meta.name.startsWith(prefix) && /^\d+$/.test(meta.name.slice(prefix.length)),
      ),
  }
}

const osdProjections = (input: Inventory, poolDeltas: Map<number, number>) => {
  const nodes = index([...input.cephOsdDf.nodes, ...input.cephOsdDf.stray], (node) => node.id, 'Ceph OSD/CRUSH')
  const rules = index(input.cephCrushRules, (rule) => rule.rule_id, 'Ceph CRUSH rule')
  const osds = [...nodes.values()].filter((node) => node.id >= 0).sort((a, b) => a.id - b.id)
  if (osds.length === 0) throw new Error('Inventory contains no Ceph OSDs')
  const savings = new Map<number, number>()
  let osdProjectionNote: string | null = null
  for (const pool of [...input.cephPools].sort((a, b) => a.pool - b.pool)) {
    const delta = poolDeltas.get(pool.pool) ?? 0
    if (delta === 0) continue
    const steps = rules.get(pool.crush_rule)?.steps
    const root = steps?.[0]?.item
    const eligible = new Set<number>()
    const visited = new Set<number>()
    // Only model the simple replicated CRUSH rule whose root can be resolved in the captured tree.
    const walk = (id: number): boolean => {
      const node = nodes.get(id)
      if (!node || visited.has(id)) return false
      visited.add(id)
      if (id < 0) return Boolean(node.children?.length && node.children.every(walk))
      if (node.reweight === 0) return true
      if (node.reweight < 0 || node.kb === 0 || node.status !== 'up') return false
      eligible.add(id)
      return true
    }
    if (
      steps?.map((step) => step.op).join(',') !== 'take,chooseleaf_firstn,emit' ||
      root === undefined ||
      root >= 0 ||
      !walk(root) ||
      eligible.size < pool.size
    ) {
      osdProjectionNote =
        'OSD scenario unavailable: a candidate pool has unsupported placement or missing statistics for in-service OSDs.'
      break
    }
    const capacity = osds.reduce((sum, osd) => sum + (eligible.has(osd.id) ? osd.kb * KIB : 0), 0)
    for (const osd of osds) {
      if (eligible.has(osd.id)) {
        savings.set(osd.id, (savings.get(osd.id) ?? 0) + delta * ((osd.kb * KIB) / capacity))
      }
    }
  }
  if (!osdProjectionNote && osds.some((osd) => (savings.get(osd.id) ?? 0) > osd.kb_used * KIB)) {
    osdProjectionNote =
      'OSD scenario unavailable: the modeled capacity-weighted savings exceed an OSD’s reported usage.'
  }
  return {
    osdProjectionNote,
    osds: osds.map((osd) => {
      const currentPercent = osd.kb > 0 ? osd.utilization : null
      const projectedPercent =
        currentPercent === null || osdProjectionNote
          ? null
          : Math.max(0, currentPercent - (100 * (savings.get(osd.id) ?? 0)) / (osd.kb * KIB))
      return {
        id: osd.id,
        currentPercent,
        projectedPercent,
        belowTargetInScenario: projectedPercent === null ? null : projectedPercent < TARGET_PERCENT,
      }
    }),
  }
}

export const planCephStorageReclamation = (raw: unknown) => {
  const parsed = inventory.safeParse(raw)
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((issue) => issue.path[0] ?? 'root'))
    throw new Error(`Invalid or incomplete inventory: ${[...fields].slice(0, 5).join(', ')}`)
  }
  const input = parsed.data
  const claims = index(input.pvcs.items, (claim) => key(claim.metadata), 'PVC')
  const volumes = index(input.pvs.items, (volume) => volume.metadata.name, 'PV')
  const contents = index(input.snapshotContents.items, (content) => content.metadata.name, 'VolumeSnapshotContent')
  const snapshots = index(input.snapshots.items, (snap) => key(snap.metadata), 'VolumeSnapshot')
  const volumeHandles = counts(input.pvs.items.map((volume) => volume.spec.csi?.volumeHandle))
  const snapshotSources = new Set(input.snapshotContents.items.map((content) => content.spec.source.volumeHandle))
  const snapshotHandles = counts(
    input.snapshotContents.items.map((content) => content.status?.snapshotHandle ?? content.spec.source.snapshotHandle),
  )
  index(input.cephDf.pools, (pool) => pool.id, 'Ceph df pool ID')
  const pools = index(input.cephDf.pools, (pool) => pool.name, 'Ceph df pool')
  const poolDetails = index(input.cephPools, (pool) => pool.pool, 'Ceph pool detail')
  const used = references(input)
  const oldEnough = (meta: z.infer<typeof metadata>) =>
    meta.creationTimestamp !== undefined && Date.parse(input.asOf) - Date.parse(meta.creationTimestamp) >= MIN_AGE_MS
  const backing = (claim?: Claim) => {
    if (
      claim?.status?.phase !== 'Bound' ||
      claim.metadata.deletionTimestamp ||
      !claim.spec.volumeName ||
      !claim.metadata.uid
    )
      return null
    const volume = volumes.get(claim.spec.volumeName)
    const ref = volume?.spec.claimRef
    const csi = volume?.spec.csi
    const attr = csi?.volumeAttributes
    if (
      !volume ||
      volume.metadata.deletionTimestamp ||
      !ref ||
      key(ref) !== key(claim.metadata) ||
      ref.uid !== claim.metadata.uid ||
      csi?.driver !== RBD_DRIVER ||
      attr?.clusterID !== ROOK_CLUSTER ||
      !attr.pool ||
      (attr.staticVolume && attr.staticVolume !== 'false') ||
      volumeHandles.get(csi.volumeHandle) !== 1
    )
      return null
    return {
      handle: csi.volumeHandle,
      pool: attr.dataPool ?? attr.pool,
      reclaimPolicy: volume.spec.persistentVolumeReclaimPolicy,
    }
  }

  const zeroRisk: Item[] = []
  const protectedItems: Item[] = []
  const ranked: { item: Candidate; volumeHandle: string; poolId: number; poolRawBytes: number; replicas: number }[] = []
  const shortlist = (item: Item, volume: ReturnType<typeof backing>) => {
    const pool = volume ? pools.get(volume.pool) : undefined
    const detail = pool ? poolDetails.get(pool.id) : undefined
    if (
      !item.logicalBytes ||
      !volume ||
      !pool ||
      !detail ||
      detail.pool_name !== pool.name ||
      detail.type !== 1 ||
      !Number.isSafeInteger(item.logicalBytes * detail.size)
    ) {
      zeroRisk.push({ ...item, reason: 'Verify size and unique backing in a known replicated Galactic RBD pool' })
      return
    }
    ranked.push({
      item: { ...item, logicalBytes: item.logicalBytes, pool: volume.pool, scenarioRawBytes: 0 },
      volumeHandle: volume.handle,
      poolId: pool.id,
      poolRawBytes: pool.stats.bytes_used,
      replicas: detail.size,
    })
  }

  for (const claim of claims.values()) {
    const meta = claim.metadata
    const volume = backing(claim)
    const pv = volumes.get(claim.spec.volumeName ?? '')
    if (!claim.spec.storageClassName?.startsWith(ROOK_CLUSTER) && pv?.spec.csi?.driver !== RBD_DRIVER) continue
    const item: Item = {
      kind: 'PVC',
      namespace: meta.namespace,
      name: meta.name,
      logicalBytes: quantityBytes(claim.status?.capacity?.storage),
      reason: '',
    }
    const protection =
      critical(meta) ||
      (pv && critical(pv.metadata)) ||
      (meta.ownerReferences.length > 0 ? 'An owner still controls this claim' : null) ||
      (used.usesClaim(meta) || (volume && snapshotSources.has(volume.handle))
        ? 'Referenced by a workload, claim template, clone, or snapshot'
        : null) ||
      (meta.deletionTimestamp ? 'Already terminating' : null)
    const restore =
      restoreArtifact.test(meta.name) &&
      (retainedInGitOps(meta) ||
        [claim.spec.dataSource, claim.spec.dataSourceRef].some(
          (ref) => ref?.kind === 'VolumeSnapshot' || ref?.kind === 'PersistentVolumeClaim',
        ))
    if (protection) protectedItems.push({ ...item, reason: protection })
    else if (!restore || !oldEnough(meta) || recurring(meta)) {
      zeroRisk.push({
        ...item,
        reason: 'Unmounted in this capture; verify one-off restore or rehearsal provenance and age',
      })
    } else if (volume?.reclaimPolicy !== 'Delete') {
      zeroRisk.push({ ...item, reason: 'Unmounted in this capture; verify bound RBD PV and Delete reclaim policy' })
    } else {
      shortlist({ ...item, reason: 'Unmounted restore/rehearsal claim; confirm retirement with the owner' }, volume)
    }
  }

  for (const snap of snapshots.values()) {
    const meta = snap.metadata
    const status = snap.status
    const content = contents.get(status?.boundVolumeSnapshotContentName ?? '')
    if (!snap.spec.volumeSnapshotClassName?.startsWith(ROOK_CLUSTER) && content?.spec.driver !== RBD_DRIVER) continue
    const sourceName = snap.spec.source.persistentVolumeClaimName
    const source = sourceName ? claims.get(key({ namespace: meta.namespace, name: sourceName })) : undefined
    const sourcePv = volumes.get(source?.spec.volumeName ?? '')
    const item: Item = {
      kind: 'VolumeSnapshot',
      namespace: meta.namespace,
      name: meta.name,
      logicalBytes: quantityBytes(status?.restoreSize),
      reason: '',
    }
    const protection =
      critical(meta) ||
      (source && critical(source.metadata)) ||
      (sourcePv && critical(sourcePv.metadata)) ||
      (content && critical(content.metadata)) ||
      (recurring(meta) || (content && recurring(content.metadata))
        ? 'Scheduled or recurring backup is protected'
        : null) ||
      (meta.ownerReferences.length > 0 || content?.metadata.ownerReferences.length
        ? 'Controller-owned backup is protected'
        : null) ||
      (used.snapshots.has(key(meta)) ? 'A restore claim or claim template still references this snapshot' : null) ||
      (meta.deletionTimestamp || content?.metadata.deletionTimestamp
        ? 'Snapshot or content is already terminating'
        : null)
    if (protection) protectedItems.push({ ...item, reason: protection })
    else if (!oneOffSnapshot(meta) || !oldEnough(meta)) {
      zeroRisk.push({ ...item, reason: 'Verify one-off checkpoint provenance, age, and backup retention' })
    } else {
      const ref = content?.spec.volumeSnapshotRef
      const handle = content?.status?.snapshotHandle
      const volume = backing(source)
      if (
        status?.readyToUse !== true ||
        content?.status?.readyToUse !== true ||
        content.spec.driver !== RBD_DRIVER ||
        content.spec.deletionPolicy !== 'Delete' ||
        !ref ||
        key(ref) !== key(meta) ||
        !meta.uid ||
        ref.uid !== meta.uid ||
        !handle ||
        snapshotHandles.get(handle) !== 1 ||
        snap.spec.source.volumeSnapshotContentName ||
        !volume ||
        content.spec.source.volumeHandle !== volume.handle
      ) {
        zeroRisk.push({
          ...item,
          reason: 'Verify ready Delete-policy RBD content, unique snapshot, and source PV binding',
        })
      } else {
        shortlist(
          { ...item, reason: 'One-off checkpoint; confirm rollback and retention requirements have ended' },
          volume,
        )
      }
    }
  }

  const poolDeltas = new Map<number, number>()
  const countedVolumes = new Set<string>()
  const approvalRequired = ranked
    .sort((a, b) => rank(a.item, b.item))
    .map(({ item, volumeHandle, poolId, poolRawBytes, replicas }) => {
      if (countedVolumes.has(volumeHandle)) return item
      // Restore sizes describe images, not exclusive snapshot extents. Do not sum
      // multiple logical sizes for checkpoints of the same source image.
      countedVolumes.add(volumeHandle)
      const currentDelta = poolDeltas.get(poolId) ?? 0
      const scenarioRawBytes = Math.min(poolRawBytes - currentDelta, item.logicalBytes * replicas)
      poolDeltas.set(poolId, currentDelta + scenarioRawBytes)
      return { ...item, scenarioRawBytes }
    })
  return {
    asOf: input.asOf,
    targetPercentExclusive: TARGET_PERCENT,
    scenario:
      'Illustrative only: logical capacity × replicas, at most one entry per RBD image, capped at pool raw use. OSD savings are capacity-weighted within the captured CRUSH root. Actual savings may be zero.',
    zeroRisk: zeroRisk.sort(rank),
    approvalRequired,
    protected: protectedItems.sort(rank),
    pools: [...pools.values()]
      .sort((a, b) => compare(a.name, b.name))
      .map((pool) => ({
        name: pool.name,
        currentRawBytes: pool.stats.bytes_used,
        projectedRawBytes: pool.stats.bytes_used - (poolDeltas.get(pool.id) ?? 0),
      })),
    ...osdProjections(input, poolDeltas),
  }
}

type Plan = ReturnType<typeof planCephStorageReclamation>
const tibibytes = (value: number | null) => (value === null ? '—' : (value / TIB).toFixed(3))
const percent = (value: number | null) => (value === null ? '—' : `${value.toFixed(2)}%`)
const table = (headers: string[], rows: string[][]) =>
  rows.length === 0
    ? '_None._'
    : [
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...rows.map(
          (row) => `| ${row.map((cell) => cell.replace(/[\\|]/g, '\\$&').replace(/[\r\n]+/g, ' ')).join(' | ')} |`,
        ),
      ].join('\n')

export const formatCephStorageReclamation = (plan: Plan, format: 'json' | 'markdown') => {
  if (format === 'json') return `${JSON.stringify(plan, null, 2)}\n`
  const inventoryHeaders = ['Kind', 'Object', 'Logical TiB', 'Reason']
  const row = (item: Item) => [item.kind, key(item), tibibytes(item.logicalBytes), item.reason]
  return (
    [
      '# Ceph storage reclamation plan (read-only)',
      `Capture: ${plan.asOf}. OSD target: strictly below ${plan.targetPercentExclusive}%.`,
      plan.scenario,
      '## Zero-risk: read-only verification only',
      table(inventoryHeaders, plan.zeroRisk.map(row)),
      '## Approval required: potential reclamation candidates',
      table(
        [...inventoryHeaders, 'Pool', 'Scenario raw TiB'],
        plan.approvalRequired.map((item) => [...row(item), item.pool, tibibytes(item.scenarioRawBytes)]),
      ),
      '## Protected: exclude from reclamation',
      table(inventoryHeaders, plan.protected.map(row)),
      '## Pool raw usage',
      table(
        ['Pool', 'Current TiB', 'Scenario TiB'],
        plan.pools.map((pool) => [pool.name, tibibytes(pool.currentRawBytes), tibibytes(pool.projectedRawBytes)]),
      ),
      '## OSD utilization',
      ...(plan.osdProjectionNote ? [plan.osdProjectionNote] : []),
      table(
        ['OSD', 'Current', 'Scenario', 'Below target in scenario?'],
        plan.osds.map((osd) => [
          `osd.${osd.id}`,
          percent(osd.currentPercent),
          percent(osd.projectedPercent),
          osd.belowTargetInScenario === null ? '—' : osd.belowTargetInScenario ? 'Yes' : 'No',
        ]),
      ),
    ].join('\n\n') + '\n'
  )
}
