import { sql } from 'kysely'

import { createKyselyDb, type Db } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

type Timestamp = string | Date

export type AgentRunRecord = {
  id: string
  agentName: string
  deliveryId: string
  provider: string
  status: string
  externalRunId: string | null
  payload: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type OrchestrationRunRecord = {
  id: string
  orchestrationName: string
  deliveryId: string
  provider: string
  status: string
  externalRunId: string | null
  payload: Record<string, unknown>
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type AgentRunIdempotencyRecord = {
  id: string
  namespace: string
  agentName: string
  idempotencyKey: string
  agentRunName: string | null
  agentRunUid: string | null
  terminalPhase: string | null
  terminalAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type MemoryResourceRecord = {
  id: string
  memoryName: string
  provider: string
  status: string
  connectionSecret: Record<string, unknown> | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type AuditEventRecord = {
  id: string
  entityType: string
  entityId: string
  eventType: string
  payload: Record<string, unknown>
  createdAt: Timestamp
}

export type CreateAgentRunInput = {
  agentName: string
  deliveryId: string
  provider: string
  status: string
  externalRunId?: string | null
  payload: Record<string, unknown>
}

export type UpdateRunDetailsInput = {
  id: string
  status: string
  externalRunId?: string | null
  payload?: Record<string, unknown>
}

export type CreateOrchestrationRunInput = {
  orchestrationName: string
  deliveryId: string
  provider: string
  status: string
  externalRunId?: string | null
  payload: Record<string, unknown>
}

export type UpsertMemoryResourceInput = {
  memoryName: string
  provider: string
  status: string
  connectionSecret?: Record<string, unknown> | null
}

export type CreateAuditEventInput = {
  entityType: string
  entityId: string
  eventType: string
  payload: Record<string, unknown>
}

export type ReserveAgentRunIdempotencyInput = {
  namespace: string
  agentName: string
  idempotencyKey: string
}

export type AssignAgentRunIdempotencyInput = {
  namespace: string
  agentName: string
  idempotencyKey: string
  agentRunName: string
  agentRunUid?: string | null
}

export type MarkAgentRunIdempotencyTerminalInput = {
  namespace: string
  agentName: string
  idempotencyKey: string
  terminalPhase: string
  terminalAt?: Timestamp | null
}

export type PrimitivesStore = {
  ready: Promise<void>
  close: () => Promise<void>
  createAgentRun: (input: CreateAgentRunInput) => Promise<AgentRunRecord>
  updateAgentRunStatus: (id: string, status: string, externalRunId?: string | null) => Promise<AgentRunRecord | null>
  updateAgentRunDetails: (input: UpdateRunDetailsInput) => Promise<AgentRunRecord | null>
  getAgentRunById: (id: string) => Promise<AgentRunRecord | null>
  getAgentRunByDeliveryId: (deliveryId: string) => Promise<AgentRunRecord | null>
  getAgentRunByExternalRunId: (externalRunId: string) => Promise<AgentRunRecord | null>
  getAgentRunsByAgent: (agentName: string, limit?: number) => Promise<AgentRunRecord[]>
  createOrchestrationRun: (input: CreateOrchestrationRunInput) => Promise<OrchestrationRunRecord>
  updateOrchestrationRunStatus: (
    id: string,
    status: string,
    externalRunId?: string | null,
  ) => Promise<OrchestrationRunRecord | null>
  updateOrchestrationRunDetails: (input: UpdateRunDetailsInput) => Promise<OrchestrationRunRecord | null>
  getOrchestrationRunById: (id: string) => Promise<OrchestrationRunRecord | null>
  getOrchestrationRunByDeliveryId: (deliveryId: string) => Promise<OrchestrationRunRecord | null>
  getOrchestrationRunByExternalRunId: (externalRunId: string) => Promise<OrchestrationRunRecord | null>
  getOrchestrationRunsByName: (orchestrationName: string, limit?: number) => Promise<OrchestrationRunRecord[]>
  upsertMemoryResource: (input: UpsertMemoryResourceInput) => Promise<MemoryResourceRecord>
  getMemoryResourceById: (id: string) => Promise<MemoryResourceRecord | null>
  getMemoryResourceByName: (memoryName: string) => Promise<MemoryResourceRecord | null>
  createAuditEvent: (input: CreateAuditEventInput) => Promise<AuditEventRecord>
  getAgentRunIdempotencyKey: (input: ReserveAgentRunIdempotencyInput) => Promise<AgentRunIdempotencyRecord | null>
  reserveAgentRunIdempotencyKey: (
    input: ReserveAgentRunIdempotencyInput,
  ) => Promise<{ record: AgentRunIdempotencyRecord; created: boolean }>
  assignAgentRunIdempotencyKey: (input: AssignAgentRunIdempotencyInput) => Promise<AgentRunIdempotencyRecord | null>
  markAgentRunIdempotencyKeyTerminal: (
    input: MarkAgentRunIdempotencyTerminalInput,
  ) => Promise<AgentRunIdempotencyRecord | null>
  deleteAgentRunIdempotencyKey: (input: ReserveAgentRunIdempotencyInput) => Promise<boolean>
  pruneAgentRunIdempotencyKeys: (retentionDays: number) => Promise<number>
  getRunById: (
    id: string,
  ) => Promise<{ kind: 'agent' | 'orchestration'; record: AgentRunRecord | OrchestrationRunRecord } | null>
}

type PrimitivesStoreOptions = {
  url?: string
  createDb?: (url: string) => Db
}

const DEFAULT_RUN_STATUS = 'Pending'

const toAgentRunRecord = (row: {
  id: string
  agent_name: string
  delivery_id: string
  provider: string
  status: string
  external_run_id: string | null
  payload: Record<string, unknown>
  created_at: Timestamp
  updated_at: Timestamp
}): AgentRunRecord => ({
  id: row.id,
  agentName: row.agent_name,
  deliveryId: row.delivery_id,
  provider: row.provider,
  status: row.status,
  externalRunId: row.external_run_id,
  payload: row.payload ?? {},
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toOrchestrationRunRecord = (row: {
  id: string
  orchestration_name: string
  delivery_id: string
  provider: string
  status: string
  external_run_id: string | null
  payload: Record<string, unknown>
  created_at: Timestamp
  updated_at: Timestamp
}): OrchestrationRunRecord => ({
  id: row.id,
  orchestrationName: row.orchestration_name,
  deliveryId: row.delivery_id,
  provider: row.provider,
  status: row.status,
  externalRunId: row.external_run_id,
  payload: row.payload ?? {},
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toMemoryResourceRecord = (row: {
  id: string
  memory_name: string
  provider: string
  status: string
  connection_secret: Record<string, unknown> | null
  created_at: Timestamp
  updated_at: Timestamp
}): MemoryResourceRecord => ({
  id: row.id,
  memoryName: row.memory_name,
  provider: row.provider,
  status: row.status,
  connectionSecret: row.connection_secret ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toAgentRunIdempotencyRecord = (row: {
  id: string
  namespace: string
  agent_name: string
  idempotency_key: string
  agent_run_name: string | null
  agent_run_uid: string | null
  terminal_phase: string | null
  terminal_at: Timestamp | null
  created_at: Timestamp
  updated_at: Timestamp
}): AgentRunIdempotencyRecord => ({
  id: row.id,
  namespace: row.namespace,
  agentName: row.agent_name,
  idempotencyKey: row.idempotency_key,
  agentRunName: row.agent_run_name,
  agentRunUid: row.agent_run_uid,
  terminalPhase: row.terminal_phase,
  terminalAt: row.terminal_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toAuditEventRecord = (row: {
  id: string
  entity_type: string
  entity_id: string
  event_type: string
  payload: Record<string, unknown>
  created_at: Timestamp
}): AuditEventRecord => ({
  id: row.id,
  entityType: row.entity_type,
  entityId: row.entity_id,
  eventType: row.event_type,
  payload: row.payload ?? {},
  createdAt: row.created_at,
})

export const createPrimitivesStore = (options: PrimitivesStoreOptions = {}): PrimitivesStore => {
  const url = options.url ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required for Jangar primitives storage')
  }

  const db = (options.createDb ?? createKyselyDb)(url)
  const ready = ensureMigrations(db)

  const close = async () => {
    await db.destroy()
  }

  const createAgentRun: PrimitivesStore['createAgentRun'] = async (input) => {
    await ready
    const status = input.status || DEFAULT_RUN_STATUS
    const payloadJson = JSON.stringify(input.payload ?? {})
    const inserted = await db
      .insertInto('agent_runs')
      .values({
        agent_name: input.agentName,
        delivery_id: input.deliveryId,
        provider: input.provider,
        status,
        external_run_id: input.externalRunId ?? null,
        payload: sql`${payloadJson}::jsonb`,
      })
      .onConflict((oc) => oc.column('delivery_id').doNothing())
      .returningAll()
      .executeTakeFirst()

    if (inserted) return toAgentRunRecord(inserted)

    const existing = await db
      .selectFrom('agent_runs')
      .selectAll()
      .where('delivery_id', '=', input.deliveryId)
      .executeTakeFirst()

    if (!existing) {
      throw new Error('failed to resolve agent run after idempotent insert')
    }
    return toAgentRunRecord(existing)
  }

  const updateAgentRunStatus: PrimitivesStore['updateAgentRunStatus'] = async (id, status, externalRunId) => {
    await ready
    const payload = await db
      .updateTable('agent_runs')
      .set({
        status,
        external_run_id: externalRunId ?? sql.ref('external_run_id'),
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
    return payload ? toAgentRunRecord(payload) : null
  }

  const updateAgentRunDetails: PrimitivesStore['updateAgentRunDetails'] = async (input) => {
    await ready
    const payloadJson = input.payload ? JSON.stringify(input.payload) : null
    const row = await db
      .updateTable('agent_runs')
      .set({
        status: input.status,
        external_run_id: input.externalRunId ?? sql.ref('external_run_id'),
        payload: input.payload ? sql`${payloadJson}::jsonb` : sql.ref('payload'),
        updated_at: sql`now()`,
      })
      .where('id', '=', input.id)
      .returningAll()
      .executeTakeFirst()
    return row ? toAgentRunRecord(row) : null
  }

  const getAgentRunById: PrimitivesStore['getAgentRunById'] = async (id) => {
    await ready
    const row = await db.selectFrom('agent_runs').selectAll().where('id', '=', id).executeTakeFirst()
    return row ? toAgentRunRecord(row) : null
  }

  const getAgentRunByDeliveryId: PrimitivesStore['getAgentRunByDeliveryId'] = async (deliveryId) => {
    await ready
    const row = await db.selectFrom('agent_runs').selectAll().where('delivery_id', '=', deliveryId).executeTakeFirst()
    return row ? toAgentRunRecord(row) : null
  }

  const getAgentRunByExternalRunId: PrimitivesStore['getAgentRunByExternalRunId'] = async (externalRunId) => {
    await ready
    const row = await db
      .selectFrom('agent_runs')
      .selectAll()
      .where('external_run_id', '=', externalRunId)
      .executeTakeFirst()
    return row ? toAgentRunRecord(row) : null
  }

  const getAgentRunsByAgent: PrimitivesStore['getAgentRunsByAgent'] = async (agentName, limit) => {
    await ready
    const rows = await db
      .selectFrom('agent_runs')
      .selectAll()
      .where('agent_name', '=', agentName)
      .orderBy('created_at', 'desc')
      .limit(limit ?? 50)
      .execute()
    return rows.map(toAgentRunRecord)
  }

  const createOrchestrationRun: PrimitivesStore['createOrchestrationRun'] = async (input) => {
    await ready
    const status = input.status || DEFAULT_RUN_STATUS
    const payloadJson = JSON.stringify(input.payload ?? {})
    const inserted = await db
      .insertInto('orchestration_runs')
      .values({
        orchestration_name: input.orchestrationName,
        delivery_id: input.deliveryId,
        provider: input.provider,
        status,
        external_run_id: input.externalRunId ?? null,
        payload: sql`${payloadJson}::jsonb`,
      })
      .onConflict((oc) => oc.column('delivery_id').doNothing())
      .returningAll()
      .executeTakeFirst()

    if (inserted) return toOrchestrationRunRecord(inserted)

    const existing = await db
      .selectFrom('orchestration_runs')
      .selectAll()
      .where('delivery_id', '=', input.deliveryId)
      .executeTakeFirst()

    if (!existing) {
      throw new Error('failed to resolve orchestration run after idempotent insert')
    }
    return toOrchestrationRunRecord(existing)
  }

  const updateOrchestrationRunStatus: PrimitivesStore['updateOrchestrationRunStatus'] = async (
    id,
    status,
    externalRunId,
  ) => {
    await ready
    const payload = await db
      .updateTable('orchestration_runs')
      .set({
        status,
        external_run_id: externalRunId ?? sql.ref('external_run_id'),
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst()
    return payload ? toOrchestrationRunRecord(payload) : null
  }

  const updateOrchestrationRunDetails: PrimitivesStore['updateOrchestrationRunDetails'] = async (input) => {
    await ready
    const payloadJson = input.payload ? JSON.stringify(input.payload) : null
    const row = await db
      .updateTable('orchestration_runs')
      .set({
        status: input.status,
        external_run_id: input.externalRunId ?? sql.ref('external_run_id'),
        payload: input.payload ? sql`${payloadJson}::jsonb` : sql.ref('payload'),
        updated_at: sql`now()`,
      })
      .where('id', '=', input.id)
      .returningAll()
      .executeTakeFirst()
    return row ? toOrchestrationRunRecord(row) : null
  }

  const getOrchestrationRunById: PrimitivesStore['getOrchestrationRunById'] = async (id) => {
    await ready
    const row = await db.selectFrom('orchestration_runs').selectAll().where('id', '=', id).executeTakeFirst()
    return row ? toOrchestrationRunRecord(row) : null
  }

  const getOrchestrationRunByDeliveryId: PrimitivesStore['getOrchestrationRunByDeliveryId'] = async (deliveryId) => {
    await ready
    const row = await db
      .selectFrom('orchestration_runs')
      .selectAll()
      .where('delivery_id', '=', deliveryId)
      .executeTakeFirst()
    return row ? toOrchestrationRunRecord(row) : null
  }

  const getOrchestrationRunByExternalRunId: PrimitivesStore['getOrchestrationRunByExternalRunId'] = async (
    externalRunId,
  ) => {
    await ready
    const row = await db
      .selectFrom('orchestration_runs')
      .selectAll()
      .where('external_run_id', '=', externalRunId)
      .executeTakeFirst()
    return row ? toOrchestrationRunRecord(row) : null
  }

  const getOrchestrationRunsByName: PrimitivesStore['getOrchestrationRunsByName'] = async (
    orchestrationName,
    limit,
  ) => {
    await ready
    const rows = await db
      .selectFrom('orchestration_runs')
      .selectAll()
      .where('orchestration_name', '=', orchestrationName)
      .orderBy('created_at', 'desc')
      .limit(limit ?? 50)
      .execute()
    return rows.map(toOrchestrationRunRecord)
  }

  const upsertMemoryResource: PrimitivesStore['upsertMemoryResource'] = async (input) => {
    await ready
    const payload = JSON.stringify(input.connectionSecret ?? {})
    const row = await db
      .insertInto('memory_resources')
      .values({
        memory_name: input.memoryName,
        provider: input.provider,
        status: input.status,
        connection_secret: input.connectionSecret ? sql`${payload}::jsonb` : null,
      })
      .onConflict((oc) =>
        oc.column('memory_name').doUpdateSet({
          provider: input.provider,
          status: input.status,
          connection_secret: input.connectionSecret ? sql`${payload}::jsonb` : null,
          updated_at: sql`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow()

    return toMemoryResourceRecord(row)
  }

  const getMemoryResourceById: PrimitivesStore['getMemoryResourceById'] = async (id) => {
    await ready
    const row = await db.selectFrom('memory_resources').selectAll().where('id', '=', id).executeTakeFirst()
    return row ? toMemoryResourceRecord(row) : null
  }

  const getMemoryResourceByName: PrimitivesStore['getMemoryResourceByName'] = async (memoryName) => {
    await ready
    const row = await db
      .selectFrom('memory_resources')
      .selectAll()
      .where('memory_name', '=', memoryName)
      .executeTakeFirst()
    return row ? toMemoryResourceRecord(row) : null
  }

  const createAuditEvent: PrimitivesStore['createAuditEvent'] = async (input) => {
    await ready
    const payloadJson = JSON.stringify(input.payload ?? {})
    const row = await db
      .insertInto('audit_events')
      .values({
        entity_type: input.entityType,
        entity_id: input.entityId,
        event_type: input.eventType,
        payload: sql`${payloadJson}::jsonb`,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toAuditEventRecord(row)
  }

  const getAgentRunIdempotencyKey: PrimitivesStore['getAgentRunIdempotencyKey'] = async (input) => {
    await ready
    const row = await db
      .selectFrom('agent_run_idempotency_keys')
      .selectAll()
      .where('namespace', '=', input.namespace)
      .where('agent_name', '=', input.agentName)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst()
    return row ? toAgentRunIdempotencyRecord(row) : null
  }

  const reserveAgentRunIdempotencyKey: PrimitivesStore['reserveAgentRunIdempotencyKey'] = async (input) => {
    await ready
    const inserted = await db
      .insertInto('agent_run_idempotency_keys')
      .values({
        namespace: input.namespace,
        agent_name: input.agentName,
        idempotency_key: input.idempotencyKey,
        agent_run_name: null,
        agent_run_uid: null,
        terminal_phase: null,
        terminal_at: null,
      })
      .onConflict((oc) => oc.columns(['namespace', 'agent_name', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst()

    if (inserted) {
      return { record: toAgentRunIdempotencyRecord(inserted), created: true }
    }

    const existing = await db
      .selectFrom('agent_run_idempotency_keys')
      .selectAll()
      .where('namespace', '=', input.namespace)
      .where('agent_name', '=', input.agentName)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst()

    if (!existing) {
      throw new Error('failed to resolve agent run idempotency key after conflict')
    }

    return { record: toAgentRunIdempotencyRecord(existing), created: false }
  }

  const assignAgentRunIdempotencyKey: PrimitivesStore['assignAgentRunIdempotencyKey'] = async (input) => {
    await ready
    const row = await db
      .updateTable('agent_run_idempotency_keys')
      .set({
        agent_run_name: sql`COALESCE(agent_run_name, ${input.agentRunName})`,
        agent_run_uid:
          input.agentRunUid !== undefined
            ? sql`COALESCE(agent_run_uid, ${input.agentRunUid})`
            : sql.ref('agent_run_uid'),
        updated_at: sql`now()`,
      })
      .where('namespace', '=', input.namespace)
      .where('agent_name', '=', input.agentName)
      .where('idempotency_key', '=', input.idempotencyKey)
      .returningAll()
      .executeTakeFirst()
    return row ? toAgentRunIdempotencyRecord(row) : null
  }

  const markAgentRunIdempotencyKeyTerminal: PrimitivesStore['markAgentRunIdempotencyKeyTerminal'] = async (input) => {
    await ready
    const row = await db
      .updateTable('agent_run_idempotency_keys')
      .set({
        terminal_phase: input.terminalPhase,
        terminal_at: input.terminalAt !== undefined ? input.terminalAt : sql.ref('terminal_at'),
        updated_at: sql`now()`,
      })
      .where('namespace', '=', input.namespace)
      .where('agent_name', '=', input.agentName)
      .where('idempotency_key', '=', input.idempotencyKey)
      .returningAll()
      .executeTakeFirst()
    return row ? toAgentRunIdempotencyRecord(row) : null
  }

  const deleteAgentRunIdempotencyKey: PrimitivesStore['deleteAgentRunIdempotencyKey'] = async (input) => {
    await ready
    const result = await db
      .deleteFrom('agent_run_idempotency_keys')
      .where('namespace', '=', input.namespace)
      .where('agent_name', '=', input.agentName)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst()
    return Number(result.numDeletedRows ?? 0) > 0
  }

  const pruneAgentRunIdempotencyKeys: PrimitivesStore['pruneAgentRunIdempotencyKeys'] = async (retentionDays) => {
    await ready
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0

    const result = await sql<{ deleted: number }>`
      WITH deleted AS (
        DELETE FROM agent_run_idempotency_keys
        WHERE terminal_at IS NOT NULL
          AND terminal_at < now() - (${retentionDays} * INTERVAL '1 day')
        RETURNING 1
      )
      SELECT count(*)::int AS deleted FROM deleted;
    `.execute(db)

    return result.rows[0]?.deleted ?? 0
  }

  const getRunById: PrimitivesStore['getRunById'] = async (id) => {
    await ready
    const agentRun = await db.selectFrom('agent_runs').selectAll().where('id', '=', id).executeTakeFirst()
    if (agentRun) return { kind: 'agent', record: toAgentRunRecord(agentRun) }
    const orchestrationRun = await db
      .selectFrom('orchestration_runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    if (orchestrationRun) return { kind: 'orchestration', record: toOrchestrationRunRecord(orchestrationRun) }
    return null
  }

  return {
    ready,
    close,
    createAgentRun,
    updateAgentRunStatus,
    updateAgentRunDetails,
    getAgentRunById,
    getAgentRunByDeliveryId,
    getAgentRunByExternalRunId,
    getAgentRunsByAgent,
    createOrchestrationRun,
    updateOrchestrationRunStatus,
    updateOrchestrationRunDetails,
    getOrchestrationRunById,
    getOrchestrationRunByDeliveryId,
    getOrchestrationRunByExternalRunId,
    getOrchestrationRunsByName,
    upsertMemoryResource,
    getMemoryResourceById,
    getMemoryResourceByName,
    createAuditEvent,
    getAgentRunIdempotencyKey,
    reserveAgentRunIdempotencyKey,
    assignAgentRunIdempotencyKey,
    markAgentRunIdempotencyKeyTerminal,
    deleteAgentRunIdempotencyKey,
    pruneAgentRunIdempotencyKeys,
    getRunById,
  }
}
