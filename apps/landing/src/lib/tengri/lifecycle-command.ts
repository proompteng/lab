import 'server-only'

import { createHash } from 'node:crypto'
import { type MessageInitShape } from '@bufbuild/protobuf'
import * as grpc from '@grpc/grpc-js'
import type { TengriIdentity } from './auth'
import { humanContext } from './authorization'
import {
  AuthorizationService,
  CommandState,
  ExecuteCommandRequestSchema,
  type CommandReceipt,
} from './generated/proompteng/authz/v1/authz_pb'
import { OfzError, ofzCall } from './ofz'

type LifecycleCommand = MessageInitShape<typeof ExecuteCommandRequestSchema>['command']

export type LifecycleIntent =
  | { operationId: string; action: 'create'; displayName: string }
  | { operationId: string; action: 'sleep' | 'resume' | 'delete'; agentId: string; workspaceUid: string }

function requestHash(intent: LifecycleIntent) {
  const request =
    intent.action === 'create'
      ? [intent.operationId, intent.action, intent.displayName]
      : [intent.operationId, intent.action, intent.agentId, intent.workspaceUid]
  return createHash('sha256').update(JSON.stringify(request)).digest()
}

export async function recoverLifecycleCommand(
  identity: TengriIdentity,
  intent: LifecycleIntent,
  phase: string,
  workspaceUid = '',
  runtimeEpoch = '',
) {
  const id = lifecycleId(identity, intent.operationId, phase)
  try {
    const recovered = await ofzCall(AuthorizationService.method.getCommand, {
      context: humanContext(identity, workspaceUid, runtimeEpoch),
      operationId: id,
      clientRequestHash: requestHash(intent),
    })
    return checkedReceipt(recovered.receipt, id)
  } catch (error) {
    if (error instanceof OfzError && error.status === 404) return undefined
    throw error
  }
}

export function lifecycleId(identity: TengriIdentity, operationId: string, phase: string) {
  const bytes = createHash('sha256')
    .update(`tengri.lifecycle.v1\n${identity.session.humanId}\n${operationId}\n${phase}`)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 128
  bytes[8] = (bytes[8] & 63) | 128
  const value = bytes.toString('hex')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export async function lifecycleCommand(
  identity: TengriIdentity,
  intent: LifecycleIntent,
  phase: string,
  command: LifecycleCommand,
  workspaceUid = '',
  runtimeEpoch = '',
): Promise<CommandReceipt> {
  const id = lifecycleId(identity, intent.operationId, phase)
  const context = () => humanContext(identity, workspaceUid, runtimeEpoch)
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const recovered = await recoverLifecycleCommand(identity, intent, phase, workspaceUid, runtimeEpoch)
      if (recovered) return recovered
      const policy = await ofzCall(AuthorizationService.method.getPolicyState, {})
      if (policy.recoveryGeneration !== identity.session.recoveryGeneration) throw new OfzError(401)
      const result = await ofzCall(AuthorizationService.method.executeCommand, {
        context: context(),
        operationId: id,
        expectedVersion: policy.version,
        reason: 'workspace lifecycle requested by authenticated user',
        command,
        clientRequestHash: requestHash(intent),
      })
      return checkedReceipt(result.receipt, id)
    } catch (error) {
      lastError = error
      if (
        error instanceof OfzError &&
        error.cause instanceof Error &&
        'code' in error.cause &&
        error.cause.code === grpc.status.ALREADY_EXISTS
      ) {
        const recovered = await recoverLifecycleCommand(identity, intent, phase, workspaceUid, runtimeEpoch)
        if (recovered) return recovered
        throw error
      }
      const versionConflict =
        error instanceof OfzError &&
        typeof error.cause === 'object' &&
        error.cause !== null &&
        'code' in error.cause &&
        error.cause.code === grpc.status.ABORTED
      if (!(error instanceof OfzError) || (error.status !== 503 && !versionConflict)) throw error
    }
  }
  throw lastError
}

function checkedReceipt(receipt: CommandReceipt | undefined, operationId: string) {
  if (
    !receipt ||
    receipt.operationId !== operationId ||
    receipt.state !== CommandState.COMMITTED ||
    receipt.version === BigInt(0) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(receipt.auditReceiptId) ||
    receipt.revision === ''
  )
    throw new OfzError(503)
  return receipt
}
