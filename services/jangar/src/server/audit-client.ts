import { randomUUID } from 'node:crypto'

import { type AuditEventContext, buildAuditPayload } from '~/server/audit-logging'
import { emitAuditEventToOptionalSink } from '~/server/audit-sink'

export type CreateAuditEventInput = {
  entityType: string
  entityId: string
  eventType: string
  context?: AuditEventContext
  details?: Record<string, unknown>
}

export const emitAuditEventBestEffort = async (
  input: CreateAuditEventInput,
  deps: { emit?: typeof emitAuditEventToOptionalSink } = {},
) => {
  try {
    await (deps.emit ?? emitAuditEventToOptionalSink)({
      id: randomUUID(),
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.eventType,
      payload: buildAuditPayload({ context: input.context, details: input.details }),
      createdAt: new Date(),
    })
  } catch {
    // audit is best-effort
  }
}
