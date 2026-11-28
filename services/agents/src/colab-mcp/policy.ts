import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { COLAB_DISCOVERY_TIMEOUT_MS } from './config'
import { ColabError } from './errors'
import { creationRejected, toolPayload, type ColabUpstream, type UpstreamContext } from './upstream'

const runtimeId = z.string().regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
const runtimeName = z
  .string()
  .startsWith('runtimes/')
  .min('runtimes/'.length + 1)
const createArgs = z.strictObject({
  runtime: z.record(z.string(), z.unknown()),
  runtimeId: runtimeId.optional(),
  requestId: z.uuidv4().optional(),
})
const runtimeList = z.union([
  z.strictObject({ runtimes: z.array(z.object({ name: runtimeName })) }),
  z.strictObject({}), // Protobuf JSON may omit an empty repeated field.
])

export const createColabRuntimePolicy = (upstream: ColabUpstream, maxConcurrentRuntimes: number) => {
  // Keep reservations after the call returns until Google lists the runtime or confirms a rejection.
  const reservations = new Map<string, 'creating' | 'unobserved'>()
  let admission = Promise.resolve()

  return async (name: string, args: Record<string, unknown>, context: UpstreamContext) => {
    const token = await upstream.getToken()
    if (name !== 'create_runtime') {
      const result = await upstream.callTool(name, args, token, context)
      if (
        name === 'delete_runtime' &&
        !result.isError &&
        typeof args.name === 'string' &&
        reservations.get(args.name) === 'unobserved' &&
        !args.allowMissing &&
        !args.allow_missing
      ) {
        reservations.delete(args.name)
      }
      return result
    }

    const parsed = createArgs.safeParse(args)
    if (!parsed.success) throw new ColabError('colab_invalid_runtime_arguments', 'Invalid create_runtime arguments.')
    const requestId = parsed.data.requestId?.toLowerCase() ?? randomUUID()
    const id = parsed.data.runtimeId ?? `agent-${requestId}`
    const resource = `runtimes/${id}`
    const check = admission.then(async () => {
      context.signal.throwIfAborted()
      const list = await upstream.callTool('list_runtimes', {}, token, context, COLAB_DISCOVERY_TIMEOUT_MS)
      const payload = runtimeList.safeParse(toolPayload(list))
      if (list.isError || !payload.success) {
        throw new ColabError('colab_runtime_count_unavailable', 'Could not verify the current Colab runtime count.')
      }
      const active = new Set('runtimes' in payload.data ? payload.data.runtimes.map((runtime) => runtime.name) : [])
      let unlisted = 0
      for (const [reserved, phase] of reservations) {
        if (!active.has(reserved)) unlisted++
        else if (phase === 'unobserved') reservations.delete(reserved)
      }
      if (active.size + unlisted >= maxConcurrentRuntimes) {
        throw new ColabError(
          'colab_runtime_limit_reached',
          `Colab allows at most ${maxConcurrentRuntimes} concurrent runtimes. Reuse an active runtime or call delete_runtime first.`,
        )
      }
      if (active.has(resource) || reservations.has(resource)) {
        throw new ColabError('colab_runtime_already_reserved', 'That Colab runtime already exists or is being created.')
      }
      context.signal.throwIfAborted()
      reservations.set(resource, 'creating')
    })
    // Only admission takes the lock. The slow creates can run concurrently up to the available slots.
    admission = check.then(
      () => undefined,
      () => undefined,
    )
    await check

    let rejected = false
    try {
      const result = await upstream.callTool(name, { ...parsed.data, requestId, runtimeId: id }, token, context)
      rejected = result.isError === true && creationRejected(toolPayload(result))
      return result
    } catch (error) {
      rejected = error instanceof ColabError && error.creationRejected
      if (rejected) throw error
      throw new ColabError(
        'colab_runtime_creation_unconfirmed',
        `Colab did not confirm creation of ${resource}. Check list_runtimes before trying again.`,
      )
    } finally {
      if (rejected) reservations.delete(resource)
      else reservations.set(resource, 'unobserved')
    }
  }
}
