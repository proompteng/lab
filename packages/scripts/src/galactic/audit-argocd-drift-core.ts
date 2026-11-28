import { isDeepStrictEqual } from 'node:util'

import { z } from 'zod'

export const argocdNamespace = 'argocd'
const authorizedStage = 'kargo.akuity.io/authorized-stage'
const trackingId = 'argocd.argoproj.io/tracking-id'
const syncOptions = 'argocd.argoproj.io/sync-options'
const compareOptions = 'argocd.argoproj.io/compare-options'

const dnsName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
const kind = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/)
const optionalDnsName = z.union([dnsName, z.literal('')]).default('')
const syncCode = z.enum(['Synced', 'OutOfSync', 'Unknown']).catch('Unknown')
const healthCode = z.enum(['Healthy', 'Progressing', 'Degraded', 'Missing', 'Suspended', 'Unknown']).catch('Unknown')
const resourceRef = z.object({ group: optionalDnsName, kind, namespace: optionalDnsName, name: dnsName })
const resourceStatus = resourceRef.extend({
  status: syncCode.optional(),
  requiresPruning: z.boolean().optional(),
  hook: z.boolean().optional(),
})

// Application status summarizes resources but does not include their annotations.
export const liveResourceSchema = z
  .object({
    apiVersion: z.string().regex(/^(?:[a-z0-9.-]+\/)?v[0-9][a-z0-9]*$/),
    kind,
    metadata: z.object({
      name: dnsName,
      namespace: optionalDnsName,
      annotations: z
        .object({
          [trackingId]: z.string().optional(),
          [syncOptions]: z.string().optional(),
          [compareOptions]: z.string().optional(),
        })
        .optional(),
    }),
  })
  .transform(({ apiVersion, kind, metadata }) => ({
    group: apiVersion.slice(0, Math.max(0, apiVersion.indexOf('/'))),
    kind,
    ...metadata,
  }))

// Keep renderer settings for equality checks only; they are never part of the report.
const source = z.looseObject({
  targetRevision: z.string().optional(),
  chart: z.string().optional(),
})
const sourceFields = z.object({ source: source.nullish(), sources: z.array(source).nullish() })
const revisionFields = z.object({ revision: z.string().optional(), revisions: z.array(z.string()).optional() })
const applicationSchema = z.object({
  kind: z.literal('Application').optional(),
  metadata: z.object({
    name: dnsName,
    namespace: z.literal(argocdNamespace).optional(),
    annotations: z.object({ [authorizedStage]: z.string().optional() }).optional(),
    deletionTimestamp: z.string().nullish(),
  }),
  spec: sourceFields.extend({
    destination: z.object({ server: z.string().optional(), name: z.string().optional() }).optional(),
    syncPolicy: z.object({ automated: z.object({ enabled: z.boolean().nullish() }).nullish() }).nullish(),
  }),
  status: z
    .object({
      sync: revisionFields.extend({ status: syncCode, comparedTo: sourceFields.optional() }).optional(),
      health: z.object({ status: healthCode }).optional(),
      conditions: z.array(z.object({ type: z.string() })).optional(),
      operationState: z.object({ phase: z.string().optional() }).nullish(),
      history: z
        .array(sourceFields.extend(revisionFields.shape).extend({ id: z.number().int().nonnegative() }))
        .optional(),
      resources: z.array(resourceStatus).optional(),
    })
    .optional(),
})

type ResourceRef = z.infer<typeof resourceRef>
type Application = z.infer<typeof applicationSchema>
type ResourceStatus = z.infer<typeof resourceStatus>
type LiveResource = z.infer<typeof liveResourceSchema>

const resourceKey = ({ group, kind, namespace, name }: ResourceRef) => `${group}/${kind}:${namespace}/${name}`
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export const snapshotSchema = z.object({
  items: z
    .array(applicationSchema)
    .refine((apps) => new Set(apps.map((app) => app.metadata.name)).size === apps.length),
  liveResources: z
    .array(liveResourceSchema)
    .refine((resources) => new Set(resources.map(resourceKey)).size === resources.length)
    .default([]),
})
type Snapshot = z.infer<typeof snapshotSchema>

const inCluster = ({ spec: { destination } }: Application) =>
  destination?.server === 'https://kubernetes.default.svc' ||
  (!destination?.server && destination?.name === 'in-cluster')

const differences = (app: Application) =>
  (app.status?.resources ?? []).filter((resource) => !resource.hook && resource.status && resource.status !== 'Synced')

const needsPruning = ({ status, requiresPruning }: ResourceStatus) => status === 'OutOfSync' && requiresPruning === true
const toResourceRef = ({ group, kind, namespace, name }: ResourceRef) => ({ group, kind, namespace, name })

export const localPruneCandidates = ({ items }: Snapshot) => {
  const candidates = new Map<string, ResourceRef>()
  for (const app of items) {
    if (!inCluster(app) || app.status?.sync?.status !== 'OutOfSync' || app.status.health?.status !== 'Healthy') continue
    for (const resource of differences(app)) {
      if (needsPruning(resource) && !/^secrets?$/i.test(resource.kind)) {
        candidates.set(resourceKey(resource), toResourceRef(resource))
      }
    }
  }
  return [...candidates.values()].sort((left, right) => compareText(resourceKey(left), resourceKey(right)))
}

const hasOption = (options: string | undefined, value: string) =>
  options?.split(',').some((option) => option.trim() === value)

const retention = (app: Application, resource: ResourceStatus, live: LiveResource | undefined) => {
  if (!needsPruning(resource)) return 'not_applicable'
  if (!live || !inCluster(app)) return 'metadata_unavailable'

  const [owner, groupKind, namespacedName, extra] = live.annotations?.[trackingId]?.split(':') ?? []
  const [trackedNamespace, trackedName, extraName] = namespacedName?.split('/') ?? []
  // Argo can put the destination namespace in a cluster-scoped object's tracking ID.
  if (
    owner !== app.metadata.name ||
    groupKind !== `${resource.group}/${resource.kind}` ||
    trackedName !== resource.name ||
    (resource.namespace !== '' && trackedNamespace !== resource.namespace) ||
    extra !== undefined ||
    extraName !== undefined ||
    !hasOption(live.annotations?.[syncOptions], 'Prune=false')
  ) {
    return 'not_confirmed'
  }
  // IgnoreExtraneous can leave a resource OutOfSync without contributing to the Application's sync status.
  return hasOption(live.annotations?.[compareOptions], 'IgnoreExtraneous') ? 'ignored_extraneous' : 'confirmed'
}

type ResourceEvidence = ResourceRef & {
  status: z.infer<typeof syncCode>
  retention: ReturnType<typeof retention>
}

const activeSources = (fields: z.infer<typeof sourceFields> | undefined) =>
  fields?.sources?.length ? fields.sources : fields?.source ? [fields.source] : []

type Management =
  | { kind: 'static_gitops' }
  | { kind: 'kargo'; tracking: 'verified' | 'mismatch' | 'unverifiable'; expectedBranches: string[] }

const management = (app: Application): Management => {
  const authorization = app.metadata.annotations?.[authorizedStage]
  const kargoSources = activeSources(app.spec).filter((source) =>
    /^(?:refs\/heads\/)?kargo\//.test(source.targetRevision ?? ''),
  )
  if (authorization === undefined && kargoSources.length === 0) return { kind: 'static_gitops' }

  const stages = authorization?.split(',').map((entry) => entry.trim().split(':')) ?? []
  if (
    !stages.length ||
    stages.some((entry) => entry.length !== 2 || entry.some((name) => !dnsName.safeParse(name).success))
  ) {
    return { kind: 'kargo', tracking: 'unverifiable', expectedBranches: [] }
  }

  const expectedBranches = [...new Set(stages.map(([, stage]) => `kargo/${stage}`))].sort(compareText)
  const verified =
    kargoSources.length > 0 &&
    kargoSources.every(({ chart, targetRevision }) => !chart && expectedBranches.includes(targetRevision ?? ''))
  return { kind: 'kargo', tracking: verified ? 'verified' : 'mismatch', expectedBranches }
}

const resolvedRevisions = (data: z.infer<typeof revisionFields> | undefined, multiple: boolean) =>
  multiple ? (data?.revisions ?? []) : data?.revision ? [data.revision] : []

const gitCommit = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

const promotionPending = (app: Application) => {
  const sources = activeSources(app.spec)
  const sync = app.status?.sync
  const latest = app.status?.history?.toSorted((left, right) => right.id - left.id)[0]
  if (
    !isDeepStrictEqual(sources, activeSources(sync?.comparedTo)) ||
    !isDeepStrictEqual(sources, activeSources(latest))
  ) {
    return false
  }

  const multiple = Boolean(app.spec.sources?.length)
  const compared = resolvedRevisions(sync, multiple)
  const deployed = resolvedRevisions(latest, multiple)
  if (
    compared.length !== sources.length ||
    deployed.length !== sources.length ||
    !compared.every(Boolean) ||
    !deployed.every(Boolean)
  )
    return false

  return (
    compared.some((revision, index) => revision !== deployed[index]) &&
    sources.every(({ targetRevision }, index) => {
      const before = deployed[index] ?? ''
      const after = compared[index] ?? ''
      return (
        before === after || (targetRevision?.startsWith('kargo/') && gitCommit.test(before) && gitCommit.test(after))
      )
    })
  )
}

const recommendations = {
  retained_prune_false_orphan:
    'Leave the objects in place. Verify backup integrity, retention, and ownership before reviewing any tracking change.',
  kargo_promotion_pending:
    'Check the authorized Stage, Freight, and generated branch against Argo’s comparison. Do not bypass promotion with a manual sync or revision override.',
  manual_autosync_disabled:
    'Confirm the intended sync policy in Git and inspect the live diff. Follow the approved change path; do not enable auto-sync just to clear drift.',
  rollout_progressing:
    'Inspect the running operation and workload rollout against the expected revision. Investigate if progress stalls.',
  degraded_workload:
    'Inspect Argo conditions, workload health, and the desired/live diff before considering any sync or prune.',
}

const trackingRecommendation =
  'Verify the authorized Stage and target branch in the reviewed Application or ApplicationSet. Do not override the live revision.'
type Classification = keyof typeof recommendations

const assess = (
  app: Application,
  owner: Management,
  resources: ResourceEvidence[],
  autoSync: boolean,
): { classification: Classification; reason: string } | null => {
  const sync = app.status?.sync?.status ?? 'Unknown'
  const health = app.status?.health?.status ?? 'Unknown'
  const phase = app.status?.operationState?.phase
  if (sync === 'Synced' && health === 'Healthy') return null
  if (
    sync === 'Unknown' ||
    (health !== 'Healthy' && health !== 'Progressing') ||
    phase === 'Terminating' ||
    app.metadata.deletionTimestamp ||
    app.status?.conditions?.some(({ type }) => type.endsWith('Error'))
  ) {
    return {
      classification: 'degraded_workload',
      reason: 'Application health, comparison, or lifecycle needs investigation.',
    }
  }
  if (owner.kind === 'kargo' && owner.tracking !== 'verified') {
    return { classification: 'degraded_workload', reason: 'The authorized Kargo branch could not be verified.' }
  }
  if (health === 'Progressing' || phase === 'Running') {
    return {
      classification: 'rollout_progressing',
      reason: 'Argo reports progressing health or a running sync operation.',
    }
  }
  if (
    resources.some(({ retention }) => retention === 'confirmed') &&
    resources.every(({ retention }) => retention === 'confirmed' || retention === 'ignored_extraneous')
  ) {
    return {
      classification: 'retained_prune_false_orphan',
      reason: 'All reported differences are live-only objects with matching tracking IDs and Prune=false.',
    }
  }
  if (
    owner.kind === 'kargo' &&
    resources.every(({ status, retention }) => status === 'OutOfSync' && retention === 'not_applicable') &&
    phase !== 'Failed' &&
    phase !== 'Error' &&
    promotionPending(app)
  ) {
    return {
      classification: 'kargo_promotion_pending',
      reason: 'Argo is comparing a different commit on the authorized branch than it last deployed.',
    }
  }
  if (!autoSync) {
    return {
      classification: 'manual_autosync_disabled',
      reason: 'Application is OutOfSync and automated sync is disabled; drift is not assumed benign.',
    }
  }
  return {
    classification: 'degraded_workload',
    reason: 'Reported drift is not explained by verified retention or a pending Kargo revision.',
  }
}

export const audit = ({ items, liveResources }: Snapshot) => {
  const liveByKey = new Map(liveResources.map((resource) => [resourceKey(resource), resource]))
  return items
    .toSorted((left, right) => compareText(left.metadata.name, right.metadata.name))
    .map((app) => {
      const owner = management(app)
      const automated = app.spec.syncPolicy?.automated
      const autoSync = automated != null && automated.enabled !== false
      const resources = differences(app)
        .toSorted((left, right) => compareText(resourceKey(left), resourceKey(right)))
        .map<ResourceEvidence>((resource) => ({
          ...toResourceRef(resource),
          status: resource.status ?? 'Unknown',
          retention: retention(app, resource, liveByKey.get(resourceKey(resource))),
        }))
      const finding = assess(app, owner, resources, autoSync)
      return {
        name: app.metadata.name,
        sync: app.status?.sync?.status ?? 'Unknown',
        health: app.status?.health?.status ?? 'Unknown',
        management: owner,
        autoSync,
        finding: finding && { ...finding, recommendation: recommendations[finding.classification] },
        trackingRecommendation: owner.kind === 'kargo' && owner.tracking !== 'verified' ? trackingRecommendation : null,
        resources,
      }
    })
}

export const renderMarkdown = (applications: ReturnType<typeof audit>) => {
  const code = (value: string) => '`' + value + '`'
  const lines = [
    '# Argo CD drift audit',
    '',
    `Reviewed ${applications.length} applications in ${code(argocdNamespace)}; ${applications.filter(({ finding }) => finding !== null).length} not Synced/Healthy.`,
    '',
    '| Application | Sync | Health | Management | Auto-sync | Classification |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const { name, sync, health, management, autoSync, finding } of applications) {
    const owner = management.kind === 'kargo' ? `kargo (${management.tracking})` : 'static GitOps'
    lines.push(
      `| ${code(name)} | ${sync} | ${health} | ${owner} | ${autoSync ? 'enabled' : 'disabled'} | ${finding?.classification ?? '—'} |`,
    )
  }
  for (const { name, management, finding, trackingRecommendation, resources } of applications) {
    if (!finding && management.kind !== 'kargo') continue
    lines.push('', `## ${name}`)
    if (management.kind === 'kargo') {
      const branches = management.expectedBranches.map(code).join(', ')
      lines.push(
        '',
        `Kargo revision tracking: **${management.tracking}**${branches ? ` (expected: ${branches})` : ''}.`,
      )
      if (trackingRecommendation) lines.push('', trackingRecommendation)
    }
    if (finding) lines.push('', finding.reason, '', `Recommendation: ${finding.recommendation}`)
    for (const resource of resources) {
      lines.push('', `- ${code(resourceKey(resource))}: ${resource.status} (${resource.retention})`)
    }
  }
  return `${lines.join('\n')}\n`
}
