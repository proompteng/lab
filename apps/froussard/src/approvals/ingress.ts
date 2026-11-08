import { Schema } from 'effect'
import { logger } from '@/logger'
import {
  ApprovalCommandSchema,
  approvalObjectKey,
  approvalServiceName,
  approvalSignaturePayload,
  type ApprovalCommand,
} from './contracts'

const ReceiptSchema = Schema.Struct({
  invocationId: Schema.String.check(Schema.isMinLength(1)),
  status: Schema.Literals(['Accepted', 'PreviouslyAccepted']),
})

export const enqueueApproval = async (options: {
  command: ApprovalCommand
  ingressOrigin: string
  sign: (text: string) => Promise<string>
  fetchImplementation?: (input: URL, init: RequestInit) => Promise<Response>
}): Promise<void> => {
  const command = Schema.decodeUnknownSync(ApprovalCommandSchema, { onExcessProperty: 'error' })(options.command)
  const origin = new URL(options.ingressOrigin)
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/'
  )
    throw new Error('Restate ingress must be an HTTP origin without credentials or a path')
  const response = await (options.fetchImplementation ?? fetch)(
    new URL(`/${approvalServiceName}/${encodeURIComponent(approvalObjectKey(command))}/approve/send`, origin),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': command.deliveryId },
      body: JSON.stringify({ ...command, signature: await options.sign(approvalSignaturePayload(command)) }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (response.status !== 202) throw new Error(`Restate rejected approval delivery with HTTP ${response.status}`)
  const receipt = Schema.decodeUnknownSync(ReceiptSchema)(await response.json())
  logger.info(
    {
      repository: command.repositoryFullName,
      pullNumber: command.pullNumber,
      deliveryId: command.deliveryId,
      invocationId: receipt.invocationId,
    },
    'ready approval durably enqueued',
  )
}
