import 'server-only'
import { type DescMessage, type DescMethodUnary, type MessageInitShape, type MessageShape } from '@bufbuild/protobuf'
import { attestedCaller } from './rpc'
import { platformRpcError } from './ofz'
const call = attestedCaller(() => ({
  target: process.env.RELAY_GRPC_ENDPOINT?.trim() || '',
  peer: 'spiffe://proompteng.ai/ns/relay/sa/relay',
}))
export async function relayCall<I extends DescMessage, O extends DescMessage>(
  method: DescMethodUnary<I, O>,
  input: MessageInitShape<I>,
  signal?: AbortSignal,
): Promise<MessageShape<O>> {
  try {
    return await call(method, input, signal)
  } catch (error) {
    throw platformRpcError(error)
  }
}
