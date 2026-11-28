import { sql } from 'kysely'

import { resolveStoreDb, type Db } from './db'
import { ensureMigrations } from './kysely-migrations'

type Timestamp = string | Date

export type ControlPlaneCacheKey = {
  cluster: string
  kind: string
  namespace: string
  name: string
}

export type ControlPlaneCacheResource = {
  apiVersion: string | null
  kind: string | null
  metadata: Record<string, unknown>
  spec: Record<string, unknown>
  status: Record<string, unknown>
}

export type ControlPlaneCacheResourceRow = {
  resource: ControlPlaneCacheResource
  lastSeenAt: Timestamp | null
  updatedAt: Timestamp | null
  resourceUpdatedAt: Timestamp | null
}

export type UpsertControlPlaneCacheResourceInput = {
  key: ControlPlaneCacheKey
  uid: string | null
  apiVersion: string | null
  resourceVersion: string | null
  generation: number | null
  labels: Record<string, unknown>
  annotations: Record<string, unknown>
  resource: ControlPlaneCacheResource
  fingerprint: string
  resourceCreatedAt: Timestamp | null
  resourceUpdatedAt: Timestamp | null
  statusPhase: string | null
  specRuntimeType: string | null
  specAgentRefName: string | null
  specImplementationSpecRefName: string | null
  specSourceProvider: string | null
  specSourceExternalId: string | null
  specSummary: string | null
  specLabels: string[]
}

export type ListControlPlaneCacheResourcesInput = {
  cluster: string
  kind: string
  namespace: string
  labelEquals?: Array<{ key: string; value: string }>
  phase?: string | null
  runtime?: string | null
  limit?: number | null
}

export type ControlPlaneCacheStore = {
  ready: Promise<void>
  close: () => Promise<void>
  getDbNow: () => Promise<Timestamp>
  upsertResources: (inputs: UpsertControlPlaneCacheResourceInput[], observedBefore?: Timestamp) => Promise<void>
  markDeleted: (key: ControlPlaneCacheKey) => Promise<void>
  markNotSeenSince: (input: { cluster: string; kind: string; namespace: string; since: Timestamp }) => Promise<void>
  getResource: (key: ControlPlaneCacheKey) => Promise<ControlPlaneCacheResourceRow | null>
  listResources: (input: ListControlPlaneCacheResourcesInput) => Promise<{
    items: ControlPlaneCacheResourceRow[]
    total: number
  }>
}

type StoreOptions = {
  url?: string
  createDb?: (url: string) => Db
}

type DbJsonValue = Record<string, unknown>

export const CONTROL_PLANE_CACHE_BATCH_SIZE = 25

const toJsonb = (value: unknown) => sql<DbJsonValue>`${JSON.stringify(value ?? {})}::jsonb`

const resolveLimit = (value: number | null | undefined) => {
  if (!value) return null
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.floor(value), 500)
}

export const createControlPlaneCacheStore = (options: StoreOptions = {}): ControlPlaneCacheStore => {
  const resolved = resolveStoreDb(options)
  if (!resolved.db || !resolved.url) {
    throw new Error('DATABASE_URL is required for Agents control-plane cache')
  }

  const db = resolved.db
  const ready = ensureMigrations(db)

  const close = async () => {
    if (resolved.shared) return
    await db.destroy()
  }

  const getDbNow: ControlPlaneCacheStore['getDbNow'] = async () => {
    await ready
    const result = await sql<{ now: Timestamp }>`select now() as now`.execute(db)
    const value = result.rows[0]?.now
    if (!value) return new Date()
    return value
  }

  const upsertResources: ControlPlaneCacheStore['upsertResources'] = async (inputs, observedBefore) => {
    await ready

    for (let offset = 0; offset < inputs.length; offset += CONTROL_PLANE_CACHE_BATCH_SIZE) {
      await db
        .insertInto('agents_control_plane.resources_current')
        .values(
          inputs.slice(offset, offset + CONTROL_PLANE_CACHE_BATCH_SIZE).map((input) => ({
            cluster: input.key.cluster,
            kind: input.key.kind,
            namespace: input.key.namespace,
            name: input.key.name,
            uid: input.uid,
            api_version: input.apiVersion,
            resource_version: input.resourceVersion,
            generation: input.generation,
            labels: toJsonb(input.labels),
            annotations: toJsonb(input.annotations),
            resource: toJsonb(input.resource),
            fingerprint: input.fingerprint,
            resource_created_at: input.resourceCreatedAt,
            resource_updated_at: input.resourceUpdatedAt,
            status_phase: input.statusPhase,
            spec_runtime_type: input.specRuntimeType,
            spec_agent_ref_name: input.specAgentRefName,
            spec_implementation_spec_ref_name: input.specImplementationSpecRefName,
            spec_source_provider: input.specSourceProvider,
            spec_source_external_id: input.specSourceExternalId,
            spec_summary: input.specSummary,
            spec_labels: input.specLabels,
            last_seen_at: sql`now()`,
            deleted_at: null,
            updated_at: sql`now()`,
          })),
        )
        .onConflict((oc) => {
          const update = oc.columns(['cluster', 'kind', 'namespace', 'name']).doUpdateSet((eb) => ({
            uid: eb.ref('excluded.uid'),
            api_version: eb.ref('excluded.api_version'),
            resource_version: eb.ref('excluded.resource_version'),
            generation: eb.ref('excluded.generation'),
            labels: eb.ref('excluded.labels'),
            annotations: eb.ref('excluded.annotations'),
            resource: eb.ref('excluded.resource'),
            fingerprint: eb.ref('excluded.fingerprint'),
            resource_created_at: eb.ref('excluded.resource_created_at'),
            resource_updated_at: eb.ref('excluded.resource_updated_at'),
            status_phase: eb.ref('excluded.status_phase'),
            spec_runtime_type: eb.ref('excluded.spec_runtime_type'),
            spec_agent_ref_name: eb.ref('excluded.spec_agent_ref_name'),
            spec_implementation_spec_ref_name: eb.ref('excluded.spec_implementation_spec_ref_name'),
            spec_source_provider: eb.ref('excluded.spec_source_provider'),
            spec_source_external_id: eb.ref('excluded.spec_source_external_id'),
            spec_summary: eb.ref('excluded.spec_summary'),
            spec_labels: eb.ref('excluded.spec_labels'),
            last_seen_at: eb.ref('excluded.last_seen_at'),
            deleted_at: eb.ref('excluded.deleted_at'),
            updated_at: eb.ref('excluded.updated_at'),
          }))
          // Relists must not overwrite watch writes or deletions made after the list started.
          return observedBefore === undefined
            ? update
            : update.where('agents_control_plane.resources_current.last_seen_at', '<', observedBefore)
        })
        .execute()
    }
  }

  const markNotSeenSince: ControlPlaneCacheStore['markNotSeenSince'] = async ({ cluster, kind, namespace, since }) => {
    await ready
    await db
      .updateTable('agents_control_plane.resources_current')
      .set({
        deleted_at: sql`now()`,
        last_seen_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where('cluster', '=', cluster)
      .where('kind', '=', kind)
      .where('namespace', '=', namespace)
      .where('deleted_at', 'is', null)
      .where('last_seen_at', '<', since)
      .execute()
  }

  const markDeleted: ControlPlaneCacheStore['markDeleted'] = async (key) => {
    await ready
    await db
      .updateTable('agents_control_plane.resources_current')
      .set({
        deleted_at: sql`now()`,
        last_seen_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where('cluster', '=', key.cluster)
      .where('kind', '=', key.kind)
      .where('namespace', '=', key.namespace)
      .where('name', '=', key.name)
      .execute()
  }

  const getResource: ControlPlaneCacheStore['getResource'] = async (key) => {
    await ready
    const row = await db
      .selectFrom('agents_control_plane.resources_current')
      .select(['resource', 'last_seen_at', 'updated_at', 'resource_updated_at'])
      .where('cluster', '=', key.cluster)
      .where('kind', '=', key.kind)
      .where('namespace', '=', key.namespace)
      .where('name', '=', key.name)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!row) return null
    return {
      resource: row.resource as unknown as ControlPlaneCacheResource,
      lastSeenAt: row.last_seen_at,
      updatedAt: row.updated_at,
      resourceUpdatedAt: row.resource_updated_at,
    }
  }

  const listResources: ControlPlaneCacheStore['listResources'] = async (input) => {
    await ready

    const limit = resolveLimit(input.limit)
    let base = db
      .selectFrom('agents_control_plane.resources_current')
      .where('cluster', '=', input.cluster)
      .where('kind', '=', input.kind)
      .where('namespace', '=', input.namespace)
      .where('deleted_at', 'is', null)

    if (input.kind === 'AgentRun') {
      if (input.phase) {
        base = base.where('status_phase', '=', input.phase)
      }
      if (input.runtime) {
        base = base.where('spec_runtime_type', '=', input.runtime)
      }
    }

    for (const filter of input.labelEquals ?? []) {
      base = base.where(
        sql<boolean>`agents_control_plane.resources_current.labels @> ${JSON.stringify({
          [filter.key]: filter.value,
        })}::jsonb`,
      )
    }

    const [{ count }] = await base.select((eb) => eb.fn.countAll<string>().as('count')).execute()
    const total = Number.parseInt(count ?? '0', 10) || 0

    let list = base
      .select(['resource', 'last_seen_at', 'updated_at', 'resource_updated_at'])
      .orderBy('resource_updated_at', 'desc')
      .orderBy('name', 'asc')

    if (limit) {
      list = list.limit(limit)
    }

    const rows = await list.execute()
    return {
      total,
      items: rows.map((row) => ({
        resource: row.resource as unknown as ControlPlaneCacheResource,
        lastSeenAt: row.last_seen_at,
        updatedAt: row.updated_at,
        resourceUpdatedAt: row.resource_updated_at,
      })),
    }
  }

  return { ready, close, getDbNow, upsertResources, markDeleted, markNotSeenSince, getResource, listResources }
}
