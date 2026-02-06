import { sql } from 'kysely'

import { createKyselyDb, type Db } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

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
  upsertResource: (input: UpsertControlPlaneCacheResourceInput) => Promise<void>
  markDeleted: (key: ControlPlaneCacheKey) => Promise<void>
  markNotSeenSince: (input: { cluster: string; kind: string; namespace: string; since: Timestamp }) => Promise<void>
  getResource: (key: ControlPlaneCacheKey) => Promise<ControlPlaneCacheResource | null>
  listResources: (input: ListControlPlaneCacheResourcesInput) => Promise<{
    items: ControlPlaneCacheResource[]
    total: number
  }>
}

type StoreOptions = {
  url?: string
  createDb?: (url: string) => Db
}

type DbJsonValue = Record<string, unknown>

const toJsonb = (value: unknown) => sql<DbJsonValue>`${JSON.stringify(value ?? {})}::jsonb`

const resolveLimit = (value: number | null | undefined) => {
  if (!value) return null
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.floor(value), 500)
}

export const createControlPlaneCacheStore = (options: StoreOptions = {}): ControlPlaneCacheStore => {
  const url = options.url ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required for Jangar control-plane cache')
  }

  const db = (options.createDb ?? createKyselyDb)(url)
  const ready = ensureMigrations(db)

  const close = async () => {
    await db.destroy()
  }

  const getDbNow: ControlPlaneCacheStore['getDbNow'] = async () => {
    await ready
    const result = await sql<{ now: Timestamp }>`select now() as now`.execute(db)
    const value = result.rows[0]?.now
    if (!value) {
      // Should be unreachable, but avoid crashing the cache sync loop.
      return new Date()
    }
    return value
  }

  const upsertResource: ControlPlaneCacheStore['upsertResource'] = async (input) => {
    await ready

    const { key } = input
    await db
      .insertInto('agents_control_plane.resources_current')
      .values({
        cluster: key.cluster,
        kind: key.kind,
        namespace: key.namespace,
        name: key.name,
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
      })
      .onConflict((oc) =>
        oc.columns(['cluster', 'kind', 'namespace', 'name']).doUpdateSet({
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
        }),
      )
      .execute()
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
      .select(['resource'])
      .where('cluster', '=', key.cluster)
      .where('kind', '=', key.kind)
      .where('namespace', '=', key.namespace)
      .where('name', '=', key.name)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!row) return null
    return row.resource as unknown as ControlPlaneCacheResource
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
      // Uses the `jsonb_path_ops` GIN index.
      base = base.where(
        sql<boolean>`agents_control_plane.resources_current.labels @> ${JSON.stringify({ [filter.key]: filter.value })}::jsonb`,
      )
    }

    const [{ count }] = await base.select((eb) => eb.fn.countAll<string>().as('count')).execute()
    const total = Number.parseInt(count ?? '0', 10) || 0

    let list = base.select(['resource']).orderBy('resource_updated_at', 'desc').orderBy('name', 'asc')

    if (limit) {
      list = list.limit(limit)
    }

    const rows = await list.execute()
    return {
      total,
      items: rows.map((row) => row.resource as unknown as ControlPlaneCacheResource),
    }
  }

  return { ready, close, getDbNow, upsertResource, markDeleted, markNotSeenSince, getResource, listResources }
}
