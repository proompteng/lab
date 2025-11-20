import { randomBytes, randomUUID } from 'node:crypto'

import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import type { Any } from '@bufbuild/protobuf/wkt'
import { AnySchema } from '@bufbuild/protobuf/wkt'
import type { DataConverter } from '../common/payloads/converter'
import { decodePayloadsToValues, encodeValuesToPayloads } from '../common/payloads/converter'
import { encodeErrorToFailure } from '../common/payloads/failure'
import type { LogFields, LogLevel } from '../observability/logger'
import { PayloadsSchema } from '../proto/temporal/api/common/v1/message_pb'
import {
  type Message as ProtocolMessage,
  MessageSchema as ProtocolMessageSchema,
} from '../proto/temporal/api/protocol/v1/message_pb'
import {
  AcceptanceSchema,
  OutcomeSchema,
  RejectionSchema,
  type Request,
  RequestSchema,
  ResponseSchema,
} from '../proto/temporal/api/update/v1/message_pb'
import type { WorkflowUpdateDispatch, WorkflowUpdateInvocation } from '../workflow/executor'

const UPDATE_REQUEST_TYPE_URL = 'type.googleapis.com/temporal.api.update.v1.Request'
const UPDATE_ACCEPTANCE_TYPE_URL = 'type.googleapis.com/temporal.api.update.v1.Acceptance'
const UPDATE_REJECTION_TYPE_URL = 'type.googleapis.com/temporal.api.update.v1.Rejection'
const UPDATE_RESPONSE_TYPE_URL = 'type.googleapis.com/temporal.api.update.v1.Response'

export type CollectedWorkflowUpdateRequest = {
  request: Request
  requestMessageId: string
  protocolInstanceId: string
  sequencingEventId?: string
}

export type CollectedWorkflowUpdates = {
  invocations: WorkflowUpdateInvocation[]
  requestsByMessageId: Map<string, CollectedWorkflowUpdateRequest>
  requestsByUpdateId: Map<string, CollectedWorkflowUpdateRequest>
}

export type WorkflowUpdateLogFn = (level: LogLevel, message: string, fields?: LogFields) => void

export interface CollectWorkflowUpdatesOptions {
  messages: ProtocolMessage[]
  dataConverter: DataConverter
  log?: WorkflowUpdateLogFn
}

export const collectWorkflowUpdates = async (
  options: CollectWorkflowUpdatesOptions,
): Promise<CollectedWorkflowUpdates> => {
  const { messages, dataConverter, log } = options
  const invocations: WorkflowUpdateInvocation[] = []
  const requestsByMessageId = new Map<string, CollectedWorkflowUpdateRequest>()
  const requestsByUpdateId = new Map<string, CollectedWorkflowUpdateRequest>()

  for (const message of messages ?? []) {
    const body = message.body
    if (!body || body.typeUrl !== UPDATE_REQUEST_TYPE_URL) {
      continue
    }
    if (!message.protocolInstanceId || !message.id) {
      log?.('warn', 'workflow update message missing identifiers', {
        protocolInstanceId: message.protocolInstanceId,
        messageId: message.id,
      })
      continue
    }

    let request: Request
    try {
      request = fromBinary(RequestSchema, body.value ?? new Uint8Array())
    } catch (error) {
      log?.('warn', 'failed to decode workflow update request', {
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    const updateId = request.meta?.updateId?.trim()
    const handlerName = request.input?.name?.trim()
    if (!updateId || !handlerName) {
      log?.('warn', 'workflow update request missing update id or handler name', {
        messageId: message.id,
      })
      continue
    }

    const args = await decodePayloadsToValues(dataConverter, request.input?.args?.payloads ?? [])
    const payload = normalizeUpdateInput(args)
    const sequencingEventId = extractUpdateSequencingId(message)

    invocations.push({
      protocolInstanceId: message.protocolInstanceId,
      requestMessageId: message.id,
      updateId,
      name: handlerName,
      payload,
      identity: request.meta?.identity,
      sequencingEventId,
    })

    const metadata: CollectedWorkflowUpdateRequest = {
      request,
      requestMessageId: message.id,
      protocolInstanceId: message.protocolInstanceId,
      sequencingEventId,
    }
    requestsByMessageId.set(message.id, metadata)
    requestsByUpdateId.set(updateId, metadata)
  }

  return { invocations, requestsByMessageId, requestsByUpdateId }
}

export interface BuildUpdateProtocolMessagesOptions {
  dispatches: readonly WorkflowUpdateDispatch[]
  collected: CollectedWorkflowUpdates
  dataConverter: DataConverter
  defaultIdentity: string
  log?: WorkflowUpdateLogFn
  generateMessageId?: () => string
}

export const buildUpdateProtocolMessages = async (
  options: BuildUpdateProtocolMessagesOptions,
): Promise<ProtocolMessage[]> => {
  const { dispatches, collected, dataConverter, defaultIdentity, log } = options
  const generateId = options.generateMessageId ?? defaultProtocolMessageId

  if (!dispatches || dispatches.length === 0) {
    return []
  }

  const messages: ProtocolMessage[] = []

  for (const dispatch of dispatches) {
    switch (dispatch.type) {
      case 'acceptance': {
        const metadata = collected.requestsByMessageId.get(dispatch.requestMessageId)
        if (!metadata) {
          log?.('warn', 'missing workflow update request metadata for acceptance', {
            updateId: dispatch.updateId,
          })
          break
        }
        const sequencingValue = parseSequencingValue(dispatch.sequencingEventId ?? metadata.sequencingEventId)
        const acceptance = create(AcceptanceSchema, {
          acceptedRequestMessageId: dispatch.requestMessageId,
          ...(sequencingValue !== undefined ? { acceptedRequestSequencingEventId: sequencingValue } : {}),
          acceptedRequest: metadata.request,
        })
        messages.push(
          createProtocolMessage({
            protocolInstanceId: dispatch.protocolInstanceId,
            body: create(AnySchema, {
              typeUrl: UPDATE_ACCEPTANCE_TYPE_URL,
              value: toBinary(AcceptanceSchema, acceptance),
            }),
            sequencingEventId: sequencingValue,
            generateId,
          }),
        )
        break
      }
      case 'rejection': {
        const metadata = collected.requestsByMessageId.get(dispatch.requestMessageId)
        if (!metadata) {
          log?.('warn', 'missing workflow update request metadata for rejection', {
            updateId: dispatch.updateId,
          })
          break
        }
        const sequencingValue = parseSequencingValue(dispatch.sequencingEventId ?? metadata.sequencingEventId)
        const failure = await encodeErrorToFailure(dataConverter, dispatch.failure ?? new Error(dispatch.reason))
        const rejection = create(RejectionSchema, {
          rejectedRequestMessageId: dispatch.requestMessageId,
          ...(sequencingValue !== undefined ? { rejectedRequestSequencingEventId: sequencingValue } : {}),
          rejectedRequest: metadata.request,
          failure,
        })
        messages.push(
          createProtocolMessage({
            protocolInstanceId: dispatch.protocolInstanceId,
            body: create(AnySchema, {
              typeUrl: UPDATE_REJECTION_TYPE_URL,
              value: toBinary(RejectionSchema, rejection),
            }),
            sequencingEventId: sequencingValue,
            generateId,
          }),
        )
        break
      }
      case 'completion': {
        const requestMetadata = collected.requestsByUpdateId.get(dispatch.updateId)
        const identity = dispatch.identity ?? requestMetadata?.request.meta?.identity ?? defaultIdentity
        if (dispatch.status === 'success') {
          const payloadArray = await encodeValuesToPayloads(
            dataConverter,
            dispatch.result === undefined ? [] : [dispatch.result],
          )
          const payloadsMessage = create(PayloadsSchema, { payloads: payloadArray ?? [] })
          const response = create(ResponseSchema, {
            meta: { updateId: dispatch.updateId, identity: identity ?? '' },
            outcome: create(OutcomeSchema, {
              value: {
                case: 'success',
                value: payloadsMessage,
              },
            }),
          })
          messages.push(
            createProtocolMessage({
              protocolInstanceId: dispatch.protocolInstanceId,
              body: create(AnySchema, {
                typeUrl: UPDATE_RESPONSE_TYPE_URL,
                value: toBinary(ResponseSchema, response),
              }),
              generateId,
            }),
          )
        } else {
          const failure = await encodeErrorToFailure(dataConverter, dispatch.failure)
          const response = create(ResponseSchema, {
            meta: { updateId: dispatch.updateId, identity: identity ?? '' },
            outcome: create(OutcomeSchema, {
              value: {
                case: 'failure',
                value: failure,
              },
            }),
          })
          messages.push(
            createProtocolMessage({
              protocolInstanceId: dispatch.protocolInstanceId,
              body: create(AnySchema, {
                typeUrl: UPDATE_RESPONSE_TYPE_URL,
                value: toBinary(ResponseSchema, response),
              }),
              generateId,
            }),
          )
        }
        break
      }
      default:
        break
    }
  }

  return messages
}

const normalizeUpdateInput = (values: unknown[]): unknown => {
  if (!values || values.length === 0) {
    return undefined
  }
  return values.length === 1 ? values[0] : values
}

const extractUpdateSequencingId = (message: ProtocolMessage): string | undefined => {
  const sequencing = message.sequencingId
  if (!sequencing || sequencing.case !== 'eventId') {
    return undefined
  }
  return sequencing.value !== undefined ? sequencing.value.toString() : undefined
}

const parseSequencingValue = (value?: string): bigint | undefined => {
  if (!value) {
    return undefined
  }
  try {
    return BigInt(value)
  } catch {
    return undefined
  }
}

const createProtocolMessage = ({
  protocolInstanceId,
  body,
  sequencingEventId,
  generateId,
}: {
  protocolInstanceId: string
  body: Any
  sequencingEventId?: bigint
  generateId: () => string
}): ProtocolMessage =>
  create(ProtocolMessageSchema, {
    id: generateId(),
    protocolInstanceId,
    body,
    ...(sequencingEventId !== undefined
      ? {
          sequencingId: {
            case: 'eventId',
            value: sequencingEventId,
          },
        }
      : {}),
  })

const defaultProtocolMessageId = (): string => {
  if (typeof randomUUID === 'function') {
    return randomUUID()
  }
  return randomBytes(16).toString('hex')
}
