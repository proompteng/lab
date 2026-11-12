import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Command, Flag } from 'effect/cli'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  applyManifest,
  callUnary,
  outputResource,
  outputResources,
  parseJson,
  parseKeyValueList,
  readTextInput,
  toKeyValueMap,
  waitForRunCompletion,
  waitForRunCompletionKube,
} from '../../runtime'
import { buildAgentRunYaml } from '../../templates/agent-run'
import { buildImplementationSpecYaml } from '../../templates/implementation-spec'
import { TransportService } from '../../transport'
import { AgentctlContext } from '../context'
import { asAgentctlError } from '../errors'
import { promptList, promptText } from '../prompt'

const resolvePromptText = (value: Option.Option<string>, question: string, allowEmpty = false, defaultValue?: string) =>
  Option.isSome(value)
    ? Effect.succeed(value.value)
    : Effect.tryPromise({
        try: () => promptText(question, { allowEmpty, defaultValue }),
        catch: (error) => asAgentctlError(error, 'ValidationError'),
      })

const resolvePromptList = (values: readonly string[], question: string) =>
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

const transportErrorTag = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error) return 'GrpcError'
  return 'KubeError'
}

const makeInitImplCommand = () => {
  const name = Flag.optional(Flag.String('name'))
  const text = Flag.optional(Flag.String('text'))
  const summary = Flag.optional(Flag.String('summary'))
  const acceptance = Flag.atLeast(Flag.String('acceptance').pipe(Flag.withAlias('criteria')), 0)
  const labels = Flag.atLeast(Flag.String('label').pipe(Flag.withAlias('labels')), 0)
  const source = Flag.optional(Flag.String('source'))
  const file = Flag.optional(Flag.String('file'))
  const apply = Flag.Boolean('apply').pipe(Flag.withDefault(false))

  return Command.make(
    'impl',
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

        const parsedSource = sourceInput
          ? sourceInput
              .split(',')
              .map((entry) => entry.trim())
              .reduce<Record<string, string>>((acc, entry) => {
                const [key, ...rest] = entry.split('=')
                if (key) acc[key] = rest.join('=')
                return acc
              }, {})
          : undefined

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
          source: parsedSource?.provider
            ? {
                provider: parsedSource.provider,
                externalId: parsedSource.externalId ?? parsedSource.external_id,
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
            'ApplyImplementationSpec',
            { namespace: resolved.namespace, manifest_yaml: manifestYaml },
            transport.metadata,
          ),
        )
        const resource = parseJson(response.json)
        if (resource) outputResource(resource, resolved.output)
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )
}

const makeInitRunCommand = () => {
  const name = Flag.optional(Flag.String('name'))
  const agent = Flag.optional(Flag.String('agent'))
  const impl = Flag.optional(Flag.String('impl'))
  const runtime = Flag.optional(Flag.String('runtime'))
  const runtimeConfig = Flag.atLeast(Flag.String('runtime-config'), 0)
  const param = Flag.atLeast(Flag.String('param'), 0)
  const workloadImage = Flag.optional(Flag.String('workload-image'))
  const cpu = Flag.optional(Flag.String('cpu'))
  const memory = Flag.optional(Flag.String('memory'))
  const memoryRef = Flag.optional(Flag.String('memory-ref'))
  const file = Flag.optional(Flag.String('file'))
  const apply = Flag.Boolean('apply').pipe(Flag.withDefault(false))
  const wait = Flag.Boolean('wait').pipe(Flag.withDefault(false))

  return Command.make(
    'run',
    {
      name,
      agent,
      impl,
      runtime,
      runtimeConfig,
      param,
      workloadImage,
      cpu,
      memory,
      memoryRef,
      file,
      apply,
      wait,
    },
    ({ name, agent, impl, runtime, runtimeConfig, param, workloadImage, cpu, memory, memoryRef, file, apply, wait }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const transport = yield* TransportService
        const resolvedAgent = yield* resolvePromptText(agent, 'Agent name')
        const resolvedImpl = yield* resolvePromptText(impl, 'ImplementationSpec name')
        const resolvedRuntime = yield* resolvePromptText(
          runtime,
          'Runtime (workflow|job|temporal|custom)',
          false,
          'workflow',
        )
        const params = yield* resolvePromptList(param, 'Parameters (key=value, comma-separated, optional)')
        const runtimeParams = yield* resolvePromptList(
          runtimeConfig,
          'Runtime config (key=value, comma-separated, optional)',
        )
        const resolvedWorkloadImage = Option.getOrUndefined(workloadImage)
        const resolvedCpu = Option.getOrUndefined(cpu)
        const resolvedMemory = Option.getOrUndefined(memory)
        const resolvedMemoryRef = Option.getOrUndefined(memoryRef)

        const yaml = buildAgentRunYaml({
          name: Option.getOrUndefined(name),
          generateName: Option.isSome(name) ? undefined : `${resolvedAgent}-`,
          namespace: resolved.namespace,
          agentName: resolvedAgent,
          implName: resolvedImpl,
          runtimeType: resolvedRuntime,
          runtimeConfig: toKeyValueMap(parseKeyValueList(runtimeParams)),
          parameters: toKeyValueMap(parseKeyValueList(params)),
          memoryRef: resolvedMemoryRef,
          workloadImage: resolvedWorkloadImage,
          cpu: resolvedCpu,
          memory: resolvedMemory,
        })

        const filePath = Option.getOrUndefined(file)
        if (filePath) {
          yield* Effect.promise(() => writeYamlFile(filePath, yaml))
          console.log(`Wrote ${filePath}`)
        }

        if (!apply) {
          if (!filePath) {
            console.log(yaml.trim())
          }
          return
        }

        if (transport.mode === 'kube') {
          const resources = yield* Effect.promise(() => applyManifest(transport.backend, yaml, resolved.namespace))
          outputResources(resources, resolved.output)
          if (wait) {
            const resource = resources[0]
            const runName = (resource?.metadata as { name?: string } | undefined)?.name
            if (typeof runName === 'string' && runName) {
              yield* Effect.promise(() =>
                waitForRunCompletionKube(transport.backend, runName, resolved.namespace, resolved.output),
              )
            }
          }
          return
        }

        const response = yield* Effect.promise(() =>
          callUnary<{ json: string }>(
            transport.client,
            'ApplyAgentRun',
            { namespace: resolved.namespace, manifest_yaml: yaml },
            transport.metadata,
          ),
        )
        const resource = parseJson(response.json)
        if (resource) {
          outputResource(resource, resolved.output)
          if (wait) {
            const runName = (resource.metadata as { name?: string } | undefined)?.name
            if (runName) {
              const exitCode = yield* Effect.promise(() =>
                waitForRunCompletion(
                  transport.client,
                  transport.metadata,
                  runName,
                  resolved.namespace,
                  resolved.output,
                ),
              )
              if (exitCode !== 0) {
                throw { _tag: 'GrpcError', message: '' }
              }
            }
          }
        }
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )
}

export const makeInitCommand = () => {
  const base = Command.make('init', {}, () =>
    Effect.sync(() => {
      console.log('Usage: agentctl init <impl|run>')
    }),
  )

  return Command.withSubcommands(base, [makeInitImplCommand(), makeInitRunCommand()])
}
