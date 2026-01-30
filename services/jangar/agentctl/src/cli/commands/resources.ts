import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  applyManifest,
  callUnary,
  clearScreen,
  createCustomObject,
  DEFAULT_WATCH_INTERVAL_MS,
  deleteCustomObject,
  getCustomObjectOptional,
  listCustomObjects,
  outputList,
  outputResource,
  outputResources,
  parseJson,
  parseSource,
  RESOURCE_SPECS,
  RPC_RESOURCE_MAP,
  readFileContent,
  readTextInput,
} from '../../legacy'
import { buildImplementationSpecYaml } from '../../templates/implementation-spec'
import { TransportService } from '../../transport'
import { AgentctlContext } from '../context'
import { asAgentctlError } from '../errors'
import { promptList, promptText } from '../prompt'
import { sleep } from '../utils'

const parseIntervalMs = (value?: string) => {
  if (!value) return DEFAULT_WATCH_INTERVAL_MS
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WATCH_INTERVAL_MS
  return Math.floor(parsed * 1000)
}

const resolveDescribeOutput = (output: string, outputFlag?: string) => (outputFlag ? output : 'yaml')

const transportErrorTag = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error) return 'GrpcError'
  return 'KubeError'
}

const selectorOption = Options.optional(Options.text('selector').pipe(Options.withAlias('l')))
const intervalOption = Options.optional(Options.text('interval'))
const fileOption = Options.text('file').pipe(Options.withAlias('f'))

const resolvePromptText = (value: Option.Option<string>, question: string, allowEmpty = false) =>
  Option.isSome(value)
    ? Effect.succeed(value.value)
    : Effect.tryPromise({
        try: () => promptText(question, { allowEmpty }),
        catch: (error) => asAgentctlError(error, 'ValidationError'),
      })

const resolvePromptList = (values: string[], question: string) =>
  values.length > 0
    ? Effect.succeed(
        values
          .flatMap((value) => value.split(','))
          .map((value) => value.trim())
          .filter(Boolean),
      )
    : Effect.tryPromise({
        try: () => promptList(question),
        catch: (error) => asAgentctlError(error, 'ValidationError'),
      })

const writeYamlFile = async (path: string, contents: string) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

const makeResourceCommand = (name: string, extras: Array<Command.Command<unknown, unknown, unknown, unknown>> = []) => {
  const spec = RESOURCE_SPECS[name]
  if (!spec) {
    throw new Error(`Unknown resource ${name}`)
  }
  const rpc = RPC_RESOURCE_MAP[name]

  const nameArg = Args.text({ name: 'name' })

  const get = Command.make('get', { name: nameArg }, ({ name: resourceName }) =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      if (transport.mode === 'kube') {
        const resource = yield* Effect.promise(() =>
          getCustomObjectOptional(transport.backend, spec, resourceName, resolved.namespace),
        )
        if (!resource) throw new Error(`${name} ${resourceName} not found`)
        outputResource(resource, resolved.output)
        return
      }
      const response = yield* Effect.promise(() =>
        callUnary<{ json: string }>(
          transport.client,
          rpc.get,
          { name: resourceName, namespace: resolved.namespace },
          transport.metadata,
        ),
      )
      const resource = parseJson(response.json)
      if (resource) outputResource(resource, resolved.output)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const describe = Command.make('describe', { name: nameArg }, ({ name: resourceName }) =>
    Effect.gen(function* () {
      const { resolved, flags } = yield* AgentctlContext
      const transport = yield* TransportService
      const describeOutput = resolveDescribeOutput(resolved.output, flags.output)
      if (transport.mode === 'kube') {
        const resource = yield* Effect.promise(() =>
          getCustomObjectOptional(transport.backend, spec, resourceName, resolved.namespace),
        )
        if (!resource) throw new Error(`${name} ${resourceName} not found`)
        outputResource(resource, describeOutput)
        return
      }
      const response = yield* Effect.promise(() =>
        callUnary<{ json: string }>(
          transport.client,
          rpc.get,
          { name: resourceName, namespace: resolved.namespace },
          transport.metadata,
        ),
      )
      const resource = parseJson(response.json)
      if (resource) outputResource(resource, describeOutput)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const list = Command.make('list', { selector: selectorOption }, ({ selector }) =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      const labelSelector = Option.getOrUndefined(selector)
      if (transport.mode === 'kube') {
        const resource = yield* Effect.promise(() =>
          listCustomObjects(transport.backend, spec, resolved.namespace, labelSelector),
        )
        outputList(resource, resolved.output)
        return
      }
      const request: Record<string, string> = { namespace: resolved.namespace }
      if (labelSelector) request.label_selector = labelSelector
      const response = yield* Effect.promise(() =>
        callUnary<{ json: string }>(transport.client, rpc.list, request, transport.metadata),
      )
      const resource = parseJson(response.json)
      if (resource) outputList(resource, resolved.output)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const watch = Command.make(
    'watch',
    { selector: selectorOption, interval: intervalOption },
    ({ selector, interval }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const transport = yield* TransportService
        const labelSelector = Option.getOrUndefined(selector)
        const intervalMs = parseIntervalMs(Option.getOrUndefined(interval))
        let iteration = 0
        const stop = () => process.exit(0)
        process.on('SIGINT', stop)
        while (true) {
          if (transport.mode === 'kube') {
            const resource = yield* Effect.promise(() =>
              listCustomObjects(transport.backend, spec, resolved.namespace, labelSelector),
            )
            if (resolved.output === 'table') {
              clearScreen()
            } else if (iteration > 0) {
              console.log('')
            }
            outputList(resource, resolved.output)
          } else {
            const request: Record<string, string> = { namespace: resolved.namespace }
            if (labelSelector) request.label_selector = labelSelector
            const response = yield* Effect.promise(() =>
              callUnary<{ json: string }>(transport.client, rpc.list, request, transport.metadata),
            )
            const resource = parseJson(response.json)
            if (resource) {
              if (resolved.output === 'table') {
                clearScreen()
              } else if (iteration > 0) {
                console.log('')
              }
              outputList(resource, resolved.output)
            }
          }
          iteration += 1
          yield* Effect.promise(() => sleep(intervalMs))
        }
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const apply = Command.make('apply', { file: fileOption }, ({ file }) =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      const manifest = yield* Effect.promise(() => readFileContent(file))
      if (transport.mode === 'kube') {
        const resources = yield* Effect.promise(() => applyManifest(transport.backend, manifest, resolved.namespace))
        outputResources(resources, resolved.output)
        return
      }
      const response = yield* Effect.promise(() =>
        callUnary<{ json: string }>(
          transport.client,
          rpc.apply,
          { namespace: resolved.namespace, manifest_yaml: manifest },
          transport.metadata,
        ),
      )
      const resource = parseJson(response.json)
      if (resource) outputResource(resource, resolved.output)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const del = Command.make('delete', { name: nameArg }, ({ name: resourceName }) =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      if (transport.mode === 'kube') {
        const result = yield* Effect.promise(() =>
          deleteCustomObject(transport.backend, spec, resolved.namespace, resourceName),
        )
        if (!result) throw new Error(`${name} ${resourceName} not found`)
        console.log('deleted')
        return
      }
      const response = yield* Effect.promise(() =>
        callUnary<{ ok: boolean; message?: string }>(
          transport.client,
          rpc.del,
          { name: resourceName, namespace: resolved.namespace },
          transport.metadata,
        ),
      )
      console.log(response.message ?? 'deleted')
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const base = Command.make(name, {}, () =>
    Effect.sync(() => {
      console.log(`Usage: agentctl ${name} <get|describe|list|watch|apply|delete>`)
    }),
  )

  return Command.withSubcommands(base, [get, describe, list, watch, apply, del, ...extras])
}

const makeImplCreateCommand = () => {
  const text = Options.text('text')
  const summary = Options.optional(Options.text('summary'))
  const source = Options.optional(Options.text('source'))
  return Command.make('create', { text, summary, source }, ({ text, summary, source }) =>
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

const makeImplInitCommand = () => {
  const name = Options.optional(Options.text('name'))
  const text = Options.optional(Options.text('text'))
  const summary = Options.optional(Options.text('summary'))
  const acceptance = Options.repeated(Options.text('acceptance').pipe(Options.withAlias('criteria')))
  const labels = Options.repeated(Options.text('label').pipe(Options.withAlias('labels')))
  const source = Options.optional(Options.text('source'))
  const file = Options.optional(Options.text('file'))
  const apply = Options.boolean('apply')

  return Command.make(
    'init',
    { name, text, summary, acceptance, labels, source, file, apply },
    ({ name, text, summary, acceptance, labels, source, file, apply }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const transport = yield* TransportService
        const resolvedSummary = yield* resolvePromptText(summary, 'Summary')
        const inputText = yield* resolvePromptText(text, 'Text (@file, -, or inline)')
        const resolvedText = yield* Effect.promise(() => readTextInput(inputText))
        if (!resolvedText.trim()) {
          throw new Error('Text is required')
        }
        const resolvedAcceptance = yield* resolvePromptList(
          acceptance,
          'Acceptance criteria (comma-separated, optional)',
        )
        const resolvedLabels = yield* resolvePromptList(labels, 'Labels (comma-separated, optional)')
        const sourceInput = yield* resolvePromptText(source, 'Source (provider=...,externalId=...,url=...)', true)
        const parsedSource = parseSource(sourceInput)

        let resolvedName = Option.getOrUndefined(name)
        let generateName = resolvedName ? undefined : 'impl-'

        if (apply && transport.mode === 'grpc' && !resolvedName) {
          const suffix = randomUUID().slice(0, 8)
          resolvedName = `${generateName ?? 'impl-'}${suffix}`
          generateName = undefined
        }

        const manifestYaml = buildImplementationSpecYaml({
          name: resolvedName,
          generateName,
          namespace: resolved.namespace,
          summary: resolvedSummary,
          text: resolvedText,
          acceptanceCriteria: resolvedAcceptance,
          labels: resolvedLabels,
          source: parsedSource
            ? {
                provider: parsedSource.provider,
                externalId: parsedSource.externalId,
                url: parsedSource.url,
              }
            : undefined,
        })

        const filePath = Option.getOrUndefined(file)
        if (filePath) {
          yield* Effect.promise(() => writeYamlFile(filePath, manifestYaml))
          console.log(`Wrote ${filePath}`)
        }

        if (!apply) {
          if (!filePath) {
            console.log(manifestYaml.trim())
          }
          return
        }

        if (transport.mode === 'kube') {
          const resources = yield* Effect.promise(() =>
            applyManifest(transport.backend, manifestYaml, resolved.namespace),
          )
          outputResources(resources, resolved.output)
          return
        }

        const response = yield* Effect.promise(() =>
          callUnary<{ json: string }>(
            transport.client,
            RPC_RESOURCE_MAP.impl.apply,
            { namespace: resolved.namespace, manifest_yaml: manifestYaml },
            transport.metadata,
          ),
        )
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, resolved.output)
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )
}

const makeImplCommand = () => {
  const create = makeImplCreateCommand()
  const init = makeImplInitCommand()
  return makeResourceCommand('impl', [create, init])
}

export const makeResourceCommands = () => {
  const commands: Array<Command.Command<unknown, unknown, unknown, unknown>> = []
  for (const name of Object.keys(RESOURCE_SPECS)) {
    if (name === 'impl') {
      commands.push(makeImplCommand())
    } else {
      commands.push(makeResourceCommand(name))
    }
  }
  return commands
}
