import { Data, Effect } from 'effect'

import { asRecord, asString, readNested } from '../primitives'
import { isNonBlankString, sha256Hex } from './template-hash'
import { evaluateSystemPromptPolicy } from './system-prompt-policy'

export const SYSTEM_PROMPT_INLINE_MAX_LENGTH = 16_384

export type SystemPromptRef = {
  kind: 'Secret' | 'ConfigMap'
  name: string
  key: string
}

type KubeClient = {
  get: (kind: string, name: string, namespace: string) => Promise<Record<string, unknown> | null>
}

type ResolveSystemPromptOptions = {
  kube: KubeClient
  namespace: string
  agentRun: Record<string, unknown>
  agent: Record<string, unknown> | null
  runSecrets: string[]
  allowedSecrets: string[]
  maxInlineLength?: number
}

export type ResolvedSystemPrompt = {
  ok: true
  systemPrompt: string | null
  systemPromptRef: SystemPromptRef | null
  systemPromptHash: string
  resolvedSystemPrompt: string
}

export type RejectedSystemPrompt = {
  ok: false
  reason:
    | 'InvalidSystemPrompt'
    | 'InvalidSystemPromptRef'
    | 'MissingSystemPromptConfiguration'
    | 'MissingSystemPromptRef'
    | 'SecretNotAllowed'
    | 'SystemPromptOverrideNotAllowed'
    | 'SystemPromptRefReadFailed'
    | 'SystemPromptTooLong'
  message: string
}

export type SystemPromptResolution = ResolvedSystemPrompt | RejectedSystemPrompt

type SystemPromptRefParseResult =
  | {
      ok: true
      ref: SystemPromptRef
    }
  | {
      ok: false
      reason: 'InvalidSystemPromptRef'
      message: string
    }

class SystemPromptRefReadError extends Data.TaggedError('SystemPromptRefReadError')<{
  readonly ref: SystemPromptRef
  readonly namespace: string
  readonly cause: unknown
}> {}

const normalizeSystemPromptKind = (value: string): SystemPromptRef['kind'] | null => {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'secret') return 'Secret'
  if (normalized === 'configmap' || normalized === 'config-map') return 'ConfigMap'
  return null
}

export const parseSystemPromptRef = (raw: unknown): SystemPromptRefParseResult => {
  const record = asRecord(raw)
  if (!record) {
    return {
      ok: false as const,
      reason: 'InvalidSystemPromptRef',
      message: 'systemPromptRef must be an object',
    }
  }
  const kindRaw = asString(record.kind) ?? ''
  const kind = kindRaw ? normalizeSystemPromptKind(kindRaw) : null
  const name = asString(record.name)
  const key = asString(record.key)
  if (!kind || !name || !key) {
    return {
      ok: false as const,
      reason: 'InvalidSystemPromptRef',
      message: 'systemPromptRef.kind (Secret|ConfigMap), systemPromptRef.name, and systemPromptRef.key are required',
    }
  }
  return { ok: true as const, ref: { kind, name, key } satisfies SystemPromptRef }
}

const describeUnknownError = (error: unknown) => {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  if (typeof error === 'string' && error.trim() !== '') return error
  return 'unknown error'
}

const readSystemPromptResource = (options: ResolveSystemPromptOptions, ref: SystemPromptRef) =>
  Effect.tryPromise({
    try: () => options.kube.get(ref.kind === 'Secret' ? 'secret' : 'configmap', ref.name, options.namespace),
    catch: (cause) => new SystemPromptRefReadError({ ref, namespace: options.namespace, cause }),
  })

const readSystemPromptResourceResult = (options: ResolveSystemPromptOptions, ref: SystemPromptRef) =>
  readSystemPromptResource(options, ref).pipe(
    Effect.map((resource) => ({ ok: true as const, resource })),
    Effect.catchAll((error) =>
      Effect.succeed({
        ok: false as const,
        reason: 'SystemPromptRefReadFailed' as const,
        message: `failed to read ${error.ref.kind} ${error.ref.name}: ${describeUnknownError(error.cause)}`,
      }),
    ),
  )

export const resolveSystemPromptEffect = (options: ResolveSystemPromptOptions): Effect.Effect<SystemPromptResolution> =>
  Effect.gen(function* () {
    const spec = asRecord(options.agentRun.spec) ?? {}
    const defaults = asRecord(readNested(options.agent, ['spec', 'defaults'])) ?? {}
    const maxInlineLength = options.maxInlineLength ?? SYSTEM_PROMPT_INLINE_MAX_LENGTH

    const policy = yield* evaluateSystemPromptPolicy({
      hasRunOverride: spec.systemPrompt != null || spec.systemPromptRef != null,
      hasDefaultRef: defaults.systemPromptRef != null,
      hasDefaultInline: defaults.systemPrompt != null,
    })
    if (!policy.ok) {
      return policy
    }

    const candidates: Array<{ type: 'ref'; raw: unknown } | { type: 'inline'; raw: unknown }> =
      policy.candidateOrder.map((type) =>
        type === 'ref' ? { type, raw: defaults.systemPromptRef } : { type, raw: defaults.systemPrompt },
      )

    for (const candidate of candidates) {
      if (candidate.raw == null) continue

      if (candidate.type === 'inline') {
        if (typeof candidate.raw !== 'string') {
          return {
            ok: false as const,
            reason: 'InvalidSystemPrompt',
            message: 'systemPrompt must be a string',
          }
        }
        const value = candidate.raw
        if (!isNonBlankString(value)) continue
        if (value.length > maxInlineLength) {
          return {
            ok: false as const,
            reason: 'SystemPromptTooLong',
            message: `systemPrompt exceeds ${maxInlineLength} characters`,
          }
        }
        return {
          ok: true as const,
          systemPrompt: value,
          systemPromptRef: null,
          systemPromptHash: sha256Hex(value),
          resolvedSystemPrompt: value,
        }
      }

      const parsed = parseSystemPromptRef(candidate.raw)
      if (!parsed.ok) return parsed
      const ref = parsed.ref

      if (ref.kind === 'Secret') {
        if (!options.runSecrets.includes(ref.name)) {
          return {
            ok: false as const,
            reason: 'SecretNotAllowed',
            message: `system prompt secret ${ref.name} is not included in spec.secrets`,
          }
        }
        if (options.allowedSecrets.length > 0 && !options.allowedSecrets.includes(ref.name)) {
          return {
            ok: false as const,
            reason: 'SecretNotAllowed',
            message: `system prompt secret ${ref.name} is not allowlisted by the Agent`,
          }
        }
      }

      const resourceRead = yield* readSystemPromptResourceResult(options, ref)
      if (!resourceRead.ok) return resourceRead

      const resource = resourceRead.resource
      if (!resource) {
        return {
          ok: false as const,
          reason: 'MissingSystemPromptRef',
          message: `${ref.kind} ${ref.name} not found`,
        }
      }

      const contents = (() => {
        if (ref.kind === 'ConfigMap') {
          const data = asRecord(resource.data) ?? {}
          const value = data[ref.key]
          return typeof value === 'string' ? value : null
        }

        const stringData = asRecord(resource.stringData) ?? null
        const fromStringData = stringData ? stringData[ref.key] : null
        if (typeof fromStringData === 'string') {
          return fromStringData
        }
        const data = asRecord(resource.data) ?? {}
        const encoded = data[ref.key]
        if (typeof encoded !== 'string' || encoded.length === 0) return null
        return Buffer.from(encoded, 'base64').toString('utf8')
      })()

      if (!isNonBlankString(contents)) {
        return {
          ok: false as const,
          reason: 'MissingSystemPromptRef',
          message: `${ref.kind} ${ref.name} is missing key ${ref.key}`,
        }
      }

      return {
        ok: true as const,
        systemPrompt: null,
        systemPromptRef: ref,
        systemPromptHash: sha256Hex(contents),
        resolvedSystemPrompt: contents,
      }
    }

    return {
      ok: false as const,
      reason: 'MissingSystemPromptConfiguration',
      message: 'Agent.spec.defaults.systemPrompt or Agent.spec.defaults.systemPromptRef is required',
    }
  })

export const resolveSystemPrompt = async (options: ResolveSystemPromptOptions) =>
  Effect.runPromise(resolveSystemPromptEffect(options))
