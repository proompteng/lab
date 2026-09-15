import { sql } from 'kysely'

import { type AuditEventContext, buildAuditPayload } from './audit-logging'
import { emitAuditEventToOptionalSink } from './audit-sink'
import { resolveStoreDb, type Db } from './db'
import { ensureMigrations } from './kysely-migrations'

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

export type AgentRunRerunSubmissionRecord = {
  id: string
  parentRef: string
  parentAgentRunId: string | null
  parentAgentRunName: string | null
  parentAgentRunNamespace: string | null
  attempt: number
  deliveryId: string
  status: string
  submissionAttempt: number
  responseStatus: number | null
  error: string | null
  requestPayload: Record<string, unknown>
  responsePayload: Record<string, unknown> | null
  createdAt: Timestamp
  updatedAt: Timestamp
  submittedAt: Timestamp | null
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
  context?: AuditEventContext
  details?: Record<string, unknown>
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

export type MarkAgentRunIdempotencyInput = {
  namespace: string
  agentName: string
  idempotencyKey: string
  terminalPhase: string
  terminalAt?: Timestamp | null
}

export type EnqueueAgentRunRerunSubmissionInput = {
  parentRef: string
  parentAgentRunId?: string | null
  parentAgentRunName?: string | null
  parentAgentRunNamespace?: string | null
  attempt: number
  deliveryId: string
  requestPayload: Record<string, unknown>
}

export type UpdateAgentRunRerunSubmissionInput = {
  id: string
  status: string
  responseStatus?: number | null
  error?: string | null
  responsePayload?: Record<string, unknown> | null
  submittedAt?: Timestamp | null
}

export type PrimitivesStore = {
  ready: Promise<void>
  close: () => Promise<void>
  createAgentRun: (input: CreateAgentRunInput) => Promise<AgentRunRecord>
  listAgentRuns: (input?: {
    agentName?: string | null
    statuses?: string[] | null
    limit?: number | null
  }) => Promise<AgentRunRecord[]>
  updateAgentRunStatus: (id: string, status: string, externalRunId?: string | null) => Promise<AgentRunRecord | null>
  updateAgentRunDetails: (input: UpdateRunDetailsInput) => Promise<AgentRunRecord | null>
  getAgentRunById: (id: string) => Promise<AgentRunRecord | null>
  getAgentRunByDeliveryId: (deliveryId: string) => Promise<AgentRunRecord | null>
  getAgentRunByExternalRunId: (externalRunId: string) => Promise<AgentRunRecord | null>
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
  markAgentRunIdempotencyKeyTerminal: (input: MarkAgentRunIdempotencyInput) => Promise<AgentRunIdempotencyRecord | null>
  deleteAgentRunIdempotencyKey: (input: ReserveAgentRunIdempotencyInput) => Promise<boolean>
  pruneAgentRunIdempotencyKeys: (retentionDays: number) => Promise<number>
  enqueueAgentRunRerunSubmission: (
    input: EnqueueAgentRunRerunSubmissionInput,
  ) => Promise<{ submission: AgentRunRerunSubmissionRecord; created: boolean }>
  claimAgentRunRerunSubmission: (input: {
    parentRef: string
    attempt: number
    deliveryId: string
  }) => Promise<{ submission: AgentRunRerunSubmissionRecord; shouldSubmit: boolean } | null>
  updateAgentRunRerunSubmission: (
    input: UpdateAgentRunRerunSubmissionInput,
  ) => Promise<AgentRunRerunSubmissionRecord | null>
  getRunById: (
    id: string,
  ) => Promise<{ kind: 'agent' | 'orchestration'; record: AgentRunRecord | OrchestrationRunRecord } | null>
}

type PrimitivesStoreOptions = {
  url?: string
  createDb?: (url: string) => Db
}

const DEFAULT_RUN_STATUS = 'Pending'
const AGENT_RUN_IDEMPOTENCY_RESERVATION_ATTEMPTS = 3

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

const toAgentRunRerunSubmissionRecord = (row: {
  id: string
  parent_ref: string
  parent_agent_run_id: string | null
  parent_agent_run_name: string | null
  parent_agent_run_namespace: string | null
  attempt: number
  delivery_id: string
  status: string
  submission_attempt: number
  response_status: number | null
  error: string | null
  request_payload: Record<string, unknown>
  response_payload: Record<string, unknown> | null
  created_at: Timestamp
  updated_at: Timestamp
  submitted_at: Timestamp | null
}): AgentRunRerunSubmissionRecord => ({
  id: row.id,
  parentRef: row.parent_ref,
  parentAgentRunId: row.parent_agent_run_id,
  parentAgentRunName: row.parent_agent_run_name,
  parentAgentRunNamespace: row.parent_agent_run_namespace,
  attempt: row.attempt,
  deliveryId: row.delivery_id,
  status: row.status,
  submissionAttempt: row.submission_attempt,
  responseStatus: row.response_status,
  error: row.error,
  requestPayload: row.request_payload ?? {},
  responsePayload: row.response_payload ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  submittedAt: row.submitted_at,
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
  const resolved = resolveStoreDb(options)
  if (!resolved.db) {
    throw new Error('DATABASE_URL is required for Agents primitives storage')
  }
  const db = resolved.db
  const ready = ensureMigrations(db)

  const close = async () => {
    if (resolved.shared) return
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

  const listAgentRuns: PrimitivesStore['listAgentRuns'] = async (input = {}) => {
    await ready
    let query = db.selectFrom('agent_runs').selectAll()
    const agentName = input.agentName?.trim()
    if (agentName) {
      query = query.where('agent_name', '=', agentName)
    }
    const statuses = (input.statuses ?? []).map((status) => status.trim()).filter((status) => status.length > 0)
    if (statuses.length > 0) {
      query = query.where('status', 'in', statuses)
    }
    const limit = input.limit && input.limit > 0 ? Math.min(Math.trunc(input.limit), 500) : 50
    const rows = await query.orderBy('created_at', 'desc').limit(limit).execute()
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
    const payload = buildAuditPayload({ context: input.context, details: input.details })
    const payloadJson = JSON.stringify(payload)
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
    const record = toAuditEventRecord(row)
    emitAuditEventToOptionalSink(record).catch((error) => {
      console.warn('[agents] audit sink emission failed', error)
    })
    return record
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
    for (let attempt = 1; attempt <= AGENT_RUN_IDEMPOTENCY_RESERVATION_ATTEMPTS; attempt += 1) {
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

      if (existing) {
        return { record: toAgentRunIdempotencyRecord(existing), created: false }
      }
    }

    throw new Error('failed to resolve agent run idempotency key after conflict')
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

  const enqueueAgentRunRerunSubmission: PrimitivesStore['enqueueAgentRunRerunSubmission'] = async (input) => {
    await ready
    const requestPayloadJson = JSON.stringify(input.requestPayload ?? {})
    const inserted = await db
      .insertInto('agent_run_rerun_submissions')
      .values({
        parent_ref: input.parentRef,
        parent_agent_run_id: input.parentAgentRunId ?? null,
        parent_agent_run_name: input.parentAgentRunName ?? null,
        parent_agent_run_namespace: input.parentAgentRunNamespace ?? null,
        attempt: input.attempt,
        delivery_id: input.deliveryId,
        status: 'queued',
        submission_attempt: 0,
        request_payload: sql`${requestPayloadJson}::jsonb`,
      })
      .onConflict((oc) => oc.columns(['parent_ref', 'attempt']).doNothing())
      .returningAll()
      .executeTakeFirst()

    if (inserted) {
      return { submission: toAgentRunRerunSubmissionRecord(inserted), created: true }
    }

    const existing = await db
      .selectFrom('agent_run_rerun_submissions')
      .selectAll()
      .where('parent_ref', '=', input.parentRef)
      .where('attempt', '=', input.attempt)
      .executeTakeFirst()

    if (!existing) {
      throw new Error('failed to resolve AgentRun rerun submission after conflict')
    }

    return { submission: toAgentRunRerunSubmissionRecord(existing), created: false }
  }

  const claimAgentRunRerunSubmission: PrimitivesStore['claimAgentRunRerunSubmission'] = async (input) => {
    await ready
    const updated = await db
      .updateTable('agent_run_rerun_submissions')
      .set({
        status: 'pending',
        submission_attempt: sql`submission_attempt + 1`,
        response_status: null,
        error: null,
        updated_at: sql`now()`,
      })
      .where('parent_ref', '=', input.parentRef)
      .where('attempt', '=', input.attempt)
      .where('delivery_id', '=', input.deliveryId)
      .where('status', 'in', ['failed', 'pending', 'queued'])
      .returningAll()
      .executeTakeFirst()

    if (updated) {
      return { submission: toAgentRunRerunSubmissionRecord(updated), shouldSubmit: true }
    }

    const existing = await db
      .selectFrom('agent_run_rerun_submissions')
      .selectAll()
      .where('delivery_id', '=', input.deliveryId)
      .executeTakeFirst()

    return existing ? { submission: toAgentRunRerunSubmissionRecord(existing), shouldSubmit: false } : null
  }

  const updateAgentRunRerunSubmission: PrimitivesStore['updateAgentRunRerunSubmission'] = async (input) => {
    await ready
    const responsePayloadJson =
      input.responsePayload === undefined ? undefined : JSON.stringify(input.responsePayload ?? {})
    const update: Record<string, unknown> = {
      status: input.status,
      updated_at: sql`now()`,
    }
    if (input.responseStatus !== undefined) update.response_status = input.responseStatus
    if (input.error !== undefined) update.error = input.error
    if (input.responsePayload !== undefined) {
      update.response_payload = input.responsePayload === null ? null : sql`${responsePayloadJson}::jsonb`
    }
    if (input.submittedAt !== undefined) update.submitted_at = input.submittedAt

    const row = await db
      .updateTable('agent_run_rerun_submissions')
      .set(update)
      .where('id', '=', input.id)
      .returningAll()
      .executeTakeFirst()

    return row ? toAgentRunRerunSubmissionRecord(row) : null
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
    listAgentRuns,
    updateAgentRunStatus,
    updateAgentRunDetails,
    getAgentRunById,
    getAgentRunByDeliveryId,
    getAgentRunByExternalRunId,
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
    enqueueAgentRunRerunSubmission,
    claimAgentRunRerunSubmission,
    updateAgentRunRerunSubmission,
    getRunById,
  }
}
