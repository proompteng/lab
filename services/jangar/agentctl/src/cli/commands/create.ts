import { Command, Options } from '@effect/cli'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  callUnary,
  createCustomObject,
  outputResource,
  parseJson,
  parseSource,
  readTextInput,
  RESOURCE_SPECS,
  RPC_RESOURCE_MAP,
} from '../../legacy'
import { TransportService } from '../../transport'
import { AgentctlContext } from '../context'
import { asAgentctlError } from '../errors'

const transportErrorTag = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error) return 'GrpcError'
  return 'KubeError'
}

const makeCreateImplCommand = () => {
  const text = Options.text('text')
  const summary = Options.optional(Options.text('summary'))
  const source = Options.optional(Options.text('source'))
  return Command.make('impl', { text, summary, source }, ({ text, summary, source }) =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      const content = yield* Effect.promise(() => readTextInput(text))
      if (!content.trim()) {
        throw new Error('--text is required')
      }
      const parsedSource = parseSource(Option.getOrUndefined(source))
      if (transport.mode === 'kube') {
        const manifest: Record<string, unknown> = {
          apiVersion: `${RESOURCE_SPECS.impl.group}/${RESOURCE_SPECS.impl.version}`,
          kind: RESOURCE_SPECS.impl.kind,
          metadata: { generateName: 'impl-', namespace: resolved.namespace },
          spec: {
            text: content,
            ...(Option.isSome(summary) ? { summary: summary.value } : {}),
            ...(parsedSource?.provider
              ? {
                  source: {
                    provider: parsedSource.provider,
                    ...(parsedSource.externalId ? { externalId: parsedSource.externalId } : {}),
                    ...(parsedSource.url ? { url: parsedSource.url } : {}),
                  },
                }
              : {}),
          },
        }
        const resource = yield* Effect.promise(() =>
          createCustomObject(transport.backend, RESOURCE_SPECS.impl, resolved.namespace, manifest),
        )
        outputResource(resource, resolved.output)
        return
      }
      const response = yield* Effect.promise(() =>
        callUnary<{ json: string }>(
          transport.client,
          RPC_RESOURCE_MAP.impl.create ?? 'CreateImplementationSpec',
          {
            namespace: resolved.namespace,
            text: content,
            summary: Option.isSome(summary) ? summary.value : '',
            source: parsedSource
              ? {
                  provider: parsedSource.provider,
                  external_id: parsedSource.externalId ?? '',
                  url: parsedSource.url ?? '',
                }
              : undefined,
          },
          transport.metadata,
        ),
      )
      const resource = parseJson(response.json)
      if (resource) outputResource(resource, resolved.output)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )
}

export const makeCreateCommand = () => {
  const base = Command.make('create', {}, () =>
    Effect.sync(() => {
      console.log('Usage: agentctl create <impl>')
    }),
  )
  return Command.withSubcommands(base, [makeCreateImplCommand()])
}
