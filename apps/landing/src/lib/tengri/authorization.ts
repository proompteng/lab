import 'server-only'

import { randomUUID } from 'node:crypto'
import { create } from '@bufbuild/protobuf'
import type { TengriIdentity } from './auth'
import { RequestContextSchema } from './generated/proompteng/authz/v1/authz_pb'
import { OfzError } from './ofz'

export function humanContext(identity: TengriIdentity, workspaceUid = '', runtimeEpoch = '') {
  const origin = new URL(process.env.TENGRI_DESKTOP_ORIGIN?.trim() || 'https://proompteng.ai')
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new OfzError(503)
  return create(RequestContextSchema, {
    actor: { identity: { case: 'humanId', value: identity.session.humanId } },
    sessionId: identity.session.id,
    traceId: randomUUID(),
    deadlineUnixMs: BigInt(Date.now() + 5000),
    contractVersion: 1,
    workspaceUid,
    runtimeEpoch,
    origin: origin.origin,
  })
}
