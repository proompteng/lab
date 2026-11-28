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

type Reservation = {
  phase: 'creating' | 'unobserved'
  requestId: string
  runtimeSpec: string
  caller: string
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const createColabRuntimePolicy = (upstream: ColabUpstream, maxConcurrentRuntimes: number) => {
  // Keep reservations after the call returns until Google lists the runtime or confirms a rejection.
  const reservations = new Map<string, Reservation>()
  let admission = Promise.resolve()

  return async (name: string, args: Record<string, unknown>, context: UpstreamContext, caller = '') => {
    const token = await upstream.getToken()
    if (name !== 'create_runtime') {
      const result = await upstream.callTool(name, args, token, context)
      if (
        name === 'delete_runtime' &&
        !result.isError &&
        typeof args.name === 'string' &&
        reservations.get(args.name)?.phase === 'unobserved' &&
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
    const runtimeSpec = canonicalJson(parsed.data.runtime)
    let isRetry = false
    const check = admission.then(async () => {
      context.signal.throwIfAborted()
      const list = await upstream.callTool('list_runtimes', {}, token, context, COLAB_DISCOVERY_TIMEOUT_MS)
      const payload = runtimeList.safeParse(toolPayload(list))
      if (list.isError || !payload.success) {
        throw new ColabError('colab_runtime_count_unavailable', 'Could not verify the current Colab runtime count.')
      }
      const active = new Set('runtimes' in payload.data ? payload.data.runtimes.map((runtime) => runtime.name) : [])
      const existing = reservations.get(resource)
      const matchingRetry =
        existing !== undefined &&
        existing.phase === 'unobserved' &&
        existing.requestId === requestId &&
        existing.runtimeSpec === runtimeSpec &&
        existing.caller === caller
      let unlisted = 0
      for (const [reserved, entry] of reservations) {
        if (!active.has(reserved)) unlisted++
        else if (entry.phase === 'unobserved' && !(reserved === resource && matchingRetry)) {
          reservations.delete(reserved)
        }
      }
      if (!matchingRetry) {
        if (active.has(resource) || reservations.has(resource)) {
          throw new ColabError(
            'colab_runtime_already_reserved',
            'That Colab runtime already exists or is being created.',
          )
        }
        if (active.size + unlisted >= maxConcurrentRuntimes) {
          throw new ColabError(
            'colab_runtime_limit_reached',
            `Colab allows at most ${maxConcurrentRuntimes} concurrent runtimes. Reuse an active runtime or call delete_runtime first.`,
          )
        }
      }
      context.signal.throwIfAborted()
      isRetry = matchingRetry
      reservations.set(resource, { phase: 'creating', requestId, runtimeSpec, caller })
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
      rejected = result.isError === true && creationRejected(toolPayload(result), { allowAlreadyExists: isRetry })
      return result
    } catch (error) {
      rejected = error instanceof ColabError && error.creationRejected && !(isRetry && error.alreadyExists)
      if (rejected) throw error
      throw new ColabError(
        'colab_runtime_creation_unconfirmed',
        `Colab did not confirm creation of ${resource}. Check list_runtimes before trying again.`,
      )
    } finally {
      if (rejected) reservations.delete(resource)
      else reservations.set(resource, { phase: 'unobserved', requestId, runtimeSpec, caller })
    }
  }
}
