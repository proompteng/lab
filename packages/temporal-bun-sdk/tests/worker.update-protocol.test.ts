import { expect, test } from 'bun:test'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { AnySchema } from '@bufbuild/protobuf/wkt'

import { createDefaultDataConverter } from '../src/common/payloads/converter'
import { PayloadsSchema } from '../src/proto/temporal/api/common/v1/message_pb'
import {
  AcceptanceSchema,
  RequestSchema,
  RejectionSchema,
  ResponseSchema,
} from '../src/proto/temporal/api/update/v1/message_pb'
import { MessageSchema as ProtocolMessageSchema } from '../src/proto/temporal/api/protocol/v1/message_pb'
import type { WorkflowUpdateDispatch } from '../src/workflow/executor'
import {
  buildUpdateProtocolMessages,
  collectWorkflowUpdates,
} from '../src/worker/update-protocol'

const UPDATE_REQUEST_TYPE_URL = 'type.googleapis.com/temporal.api.update.v1.Request'

const dataConverter = createDefaultDataConverter()

const encodeArgs = async (values: unknown[]) => {
  const payloads = await dataConverter.toPayloads(values)
  return create(PayloadsSchema, { payloads: payloads ?? [] })
}

const makeRequestMessage = async ({
  updateId,
  handlerName,
  args,
  messageId,
  protocolInstanceId,
  sequencingEventId,
}: {
  updateId: string
  handlerName: string
  args: unknown[]
  messageId: string
  protocolInstanceId: string
  sequencingEventId: bigint
}) => {
  const request = create(RequestSchema, {
    meta: { updateId, identity: 'client-sdk' },
    input: { name: handlerName, args: await encodeArgs(args) },
  })
  return create(ProtocolMessageSchema, {
    id: messageId,
    protocolInstanceId,
    sequencingId: { case: 'eventId', value: sequencingEventId },
    body: create(AnySchema, {
      typeUrl: UPDATE_REQUEST_TYPE_URL,
      value: toBinary(RequestSchema, request),
    }),
  })
}

test('collectWorkflowUpdates normalizes request payloads and metadata', async () => {
  const message = await makeRequestMessage({
    updateId: 'upd-1',
    handlerName: 'setMessage',
    args: ['hello'],
    messageId: 'msg-1',
    protocolInstanceId: 'proto-1',
    sequencingEventId: 5n,
  })

  const collected = await collectWorkflowUpdates({
    messages: [message],
    dataConverter,
  })

  expect(collected.invocations).toEqual([
    {
      protocolInstanceId: 'proto-1',
      requestMessageId: 'msg-1',
      updateId: 'upd-1',
      name: 'setMessage',
      payload: 'hello',
      identity: 'client-sdk',
      sequencingEventId: '5',
    },
  ])
  expect(collected.requestsByMessageId.get('msg-1')).toBeDefined()
  expect(collected.requestsByUpdateId.get('upd-1')).toBeDefined()
})

test('buildUpdateProtocolMessages emits acceptance, rejection, and completion messages', async () => {
  const requestMessage = await makeRequestMessage({
    updateId: 'upd-2',
    handlerName: 'setStatus',
    args: ['draft'],
    messageId: 'msg-2',
    protocolInstanceId: 'proto-2',
    sequencingEventId: 7n,
  })

  const collected = await collectWorkflowUpdates({
    messages: [requestMessage],
    dataConverter,
  })

  const dispatches: WorkflowUpdateDispatch[] = [
    {
      type: 'acceptance',
      protocolInstanceId: 'proto-2',
      requestMessageId: 'msg-2',
      updateId: 'upd-2',
      handlerName: 'setStatus',
      identity: 'client-sdk',
      sequencingEventId: '7',
    },
    {
      type: 'completion',
      protocolInstanceId: 'proto-2',
      updateId: 'upd-2',
      status: 'success',
      result: 'DONE',
      handlerName: 'setStatus',
      identity: 'client-sdk',
    },
  ]

  const ids = ['gen-1', 'gen-2']
  const messages = await buildUpdateProtocolMessages({
    dispatches,
    collected,
    dataConverter,
    defaultIdentity: 'worker-default',
    generateMessageId: () => ids.shift() ?? 'fallback-id',
  })

  expect(messages.map((msg) => msg.id)).toEqual(['gen-1', 'gen-2'])
  const acceptance = fromBinary(AcceptanceSchema, messages[0].body?.value ?? new Uint8Array())
  expect(acceptance.acceptedRequestMessageId).toBe('msg-2')
  expect(acceptance.acceptedRequest?.input?.name).toBe('setStatus')

  const response = fromBinary(ResponseSchema, messages[1].body?.value ?? new Uint8Array())
  expect(response.meta?.updateId).toBe('upd-2')
  expect(response.outcome?.value?.case).toBe('success')
})

test('buildUpdateProtocolMessages emits rejection and failure completion', async () => {
  const requestMessage = await makeRequestMessage({
    updateId: 'upd-3',
    handlerName: 'setFlag',
    args: [true],
    messageId: 'msg-3',
    protocolInstanceId: 'proto-3',
    sequencingEventId: 9n,
  })

  const collected = await collectWorkflowUpdates({ messages: [requestMessage], dataConverter })

  const dispatches: WorkflowUpdateDispatch[] = [
    {
      type: 'rejection',
      protocolInstanceId: 'proto-3',
      requestMessageId: 'msg-3',
      updateId: 'upd-3',
      reason: 'not-allowed',
      failure: new Error('nope'),
    },
    {
      type: 'completion',
      protocolInstanceId: 'proto-3',
      updateId: 'upd-3',
      status: 'failure',
      failure: new Error('failed execution'),
      handlerName: 'setFlag',
    },
  ]

  const ids = ['rej-1', 'resp-1']
  const messages = await buildUpdateProtocolMessages({
    dispatches,
    collected,
    dataConverter,
    defaultIdentity: 'worker-default',
    generateMessageId: () => ids.shift() ?? 'fallback-id',
  })

  const rejection = fromBinary(RejectionSchema, messages[0].body?.value ?? new Uint8Array())
  expect(rejection.rejectedRequestMessageId).toBe('msg-3')
  expect(rejection.failure?.message).toContain('nope')

  const response = fromBinary(ResponseSchema, messages[1].body?.value ?? new Uint8Array())
  expect(response.meta?.identity).toBe('client-sdk')
  expect(response.outcome?.value?.case).toBe('failure')
})
