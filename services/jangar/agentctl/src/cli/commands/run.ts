import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import type * as grpc from '@grpc/grpc-js'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { runCodex } from '../../codex'
import {
  AGENT_RUN_SPEC,
  applyManifest,
  callUnary,
  clearScreen,
  createCustomObject,
  DEFAULT_WATCH_INTERVAL_MS,
  deleteJobByName,
  deleteJobsBySelector,
  filterAgentRunsList,
  getCustomObjectOptional,
  isJobRuntime,
  listCustomObjects,
  outputList,
  outputResource,
  outputResources,
  parseJson,
  parseKeyValueList,
  pickPodForRun,
  RESOURCE_SPECS,
  readFileContent,
  readNestedValue,
  resolveAgentRunRuntime,
  resolvePodContainerName,
  runLabelSelector,
  streamPodLogs,
  toKeyValueEntries,
  toKeyValueMap,
  waitForRunCompletion,
  waitForRunCompletionKube,
} from '../../legacy'
import { buildAgentRunYaml } from '../../templates/agent-run'
import { buildImplementationSpecYaml } from '../../templates/implementation-spec'
import { TransportService } from '../../transport'
import { AgentctlContext } from '../context'
import { asAgentctlError } from '../errors'
import { promptList, promptText } from '../prompt'
import { sleep } from '../utils'

type RunSubmitInput = {
  agent: string
  impl: string
  runtime: string
  runtimeConfig: string[]
  parameters: string[]
  idempotencyKey?: string
  workloadImage?: string
  cpu?: string
  memory?: string
  memoryRef?: string
  vcsRef?: string
  vcsPolicyMode?: string
  vcsPolicyRequired?: boolean
  wait?: boolean
}

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

const resolvePromptText = (
  value: Option.Option<string>,
  question: string,
  allowEmpty = false,
  defaultValue?: string,
) =>
  Option.isSome(value)
    ? Effect.succeed(value.value)
    : Effect.tryPromise({
        try: () => promptText(question, { allowEmpty, defaultValue }),
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

const buildRunSpec = (input: RunSubmitInput) => {
  const runtimeConfig = toKeyValueMap(parseKeyValueList(input.runtimeConfig))
  const parameters = toKeyValueMap(parseKeyValueList(input.parameters))
  const spec: Record<string, unknown> = {
    agentRef: { name: input.agent },
    implementationSpecRef: { name: input.impl },
    runtime: {
      type: input.runtime,
      ...(Object.keys(runtimeConfig).length > 0 ? { config: runtimeConfig } : {}),
    },
    ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
  }

  if (input.memoryRef) {
    spec.memoryRef = { name: input.memoryRef }
  }

  if (input.vcsRef) {
    spec.vcsRef = { name: input.vcsRef }
  }

  const vcsPolicy: Record<string, unknown> = {}
  if (input.vcsPolicyMode) {
    vcsPolicy.mode = input.vcsPolicyMode
  }
  if (input.vcsPolicyRequired) {
    vcsPolicy.required = input.vcsPolicyRequired
  }
  if (Object.keys(vcsPolicy).length > 0) {
    spec.vcsPolicy = vcsPolicy
  }

  if (input.runtime === 'workflow') {
    spec.workflow = { steps: [{ name: 'implement' }] }
  }

  if (input.workloadImage || input.cpu || input.memory) {
    const workload: Record<string, unknown> = {}
    if (input.workloadImage) {
      workload.image = input.workloadImage
    }
    if (input.cpu || input.memory) {
      workload.resources = { requests: {} as Record<string, string> }
      if (input.cpu) (workload.resources as { requests: Record<string, string> }).requests.cpu = input.cpu
      if (input.memory) (workload.resources as { requests: Record<string, string> }).requests.memory = input.memory
    }
    spec.workload = workload
  }

  return spec
}

const submitRunKube = async (
  backend: Parameters<typeof createCustomObject>[0],
  namespace: string,
  output: string,
  input: RunSubmitInput,
) => {
  const deliveryId = input.idempotencyKey || randomUUID()
  const manifest: Record<string, unknown> = {
    apiVersion: `${AGENT_RUN_SPEC.group}/${AGENT_RUN_SPEC.version}`,
    kind: AGENT_RUN_SPEC.kind,
    metadata: {
      generateName: `${input.agent}-`,
      namespace,
      labels: {
        'jangar.proompteng.ai/delivery-id': deliveryId,
      },
    },
    spec: buildRunSpec(input),
  }
  const resource = await createCustomObject(backend, AGENT_RUN_SPEC, namespace, manifest)
  outputResource(resource, output)
  if (input.wait) {
    const runName = readNestedValue(resource, ['metadata', 'name'])
    if (typeof runName !== 'string' || !runName) {
      throw new Error('AgentRun name not available for wait')
    }
    await waitForRunCompletionKube(backend, runName, namespace, output)
  }
}

const submitRunGrpc = async (
  client: Parameters<typeof callUnary>[0],
  metadata: Parameters<typeof callUnary>[3],
  namespace: string,
  output: string,
  input: RunSubmitInput,
) => {
  const response = await callUnary<{
    resource_json: string
    record_json: string
    idempotent?: boolean
  }>(
    client,
    'SubmitAgentRun',
    {
      namespace,
      agent_name: input.agent,
      implementation_name: input.impl,
      runtime_type: input.runtime,
      runtime_config: toKeyValueEntries(parseKeyValueList(input.runtimeConfig)),
      parameters: toKeyValueEntries(parseKeyValueList(input.parameters)),
      idempotency_key: input.idempotencyKey ?? '',
      workload: {
        image: input.workloadImage ?? '',
        cpu: input.cpu ?? '',
        memory: input.memory ?? '',
      },
      memory_ref: input.memoryRef ?? '',
      vcs_ref: input.vcsRef ?? '',
      vcs_policy_mode: input.vcsPolicyMode ?? '',
      vcs_policy_required: input.vcsPolicyRequired ?? false,
    },
    metadata,
  )

  if (response.resource_json) {
    const resource = parseJson(response.resource_json)
    const runName = readNestedValue(resource, ['metadata', 'name'])
    if (input.wait && typeof runName === 'string' && runName) {
      const exitCode = await waitForRunCompletion(client, metadata, runName, namespace, output)
      if (exitCode !== 0) {
        throw { _tag: 'GrpcError', message: '' }
      }
      return
    }
    if (resource) outputResource(resource, output)
  }
}

export const makeRunCommand = () => {
  const nameArg = Args.text({ name: 'name' })
  const fileOption = Options.text('file').pipe(Options.withAlias('f'))
  const selectorOption = Options.optional(Options.text('selector').pipe(Options.withAlias('l')))
  const intervalOption = Options.optional(Options.text('interval'))
  const phaseOption = Options.optional(Options.text('phase'))
  const runtimeFilterOption = Options.optional(Options.text('runtime'))

  const submit = Command.make(
    'submit',
    {
      agent: Options.text('agent'),
      impl: Options.text('impl'),
      runtime: Options.text('runtime'),
      runtimeConfig: Options.repeated(Options.text('runtime-config')),
      param: Options.repeated(Options.text('param')),
      idempotencyKey: Options.optional(Options.text('idempotency-key')),
      workloadImage: Options.optional(Options.text('workload-image')),
      cpu: Options.optional(Options.text('cpu')),
      memory: Options.optional(Options.text('memory')),
      memoryRef: Options.optional(Options.text('memory-ref')),
      vcs: Options.optional(Options.text('vcs')),
      vcsMode: Options.optional(Options.text('vcs-mode')),
      vcsRequired: Options.boolean('vcs-required'),
      wait: Options.boolean('wait'),
    },
    ({
      agent,
      impl,
      runtime,
      runtimeConfig,
      param,
      idempotencyKey,
      workloadImage,
      cpu,
      memory,
      memoryRef,
      vcs,
      vcsMode,
      vcsRequired,
      wait,
    }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const transport = yield* TransportService
        const input: RunSubmitInput = {
          agent,
          impl,
          runtime,
          runtimeConfig,
          parameters: param,
          idempotencyKey: Option.getOrUndefined(idempotencyKey),
          workloadImage: Option.getOrUndefined(workloadImage),
          cpu: Option.getOrUndefined(cpu),
          memory: Option.getOrUndefined(memory),
          memoryRef: Option.getOrUndefined(memoryRef),
          vcsRef: Option.getOrUndefined(vcs),
          vcsPolicyMode: Option.getOrUndefined(vcsMode),
          vcsPolicyRequired: vcsRequired,
          wait,
        }
        if (transport.mode === 'kube') {
          yield* Effect.promise(() => submitRunKube(transport.backend, resolved.namespace, resolved.output, input))
          return
        }
        yield* Effect.promise(() =>
          submitRunGrpc(transport.client, transport.metadata, resolved.namespace, resolved.output, input),
        )
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
          'ApplyAgentRun',
          { namespace: resolved.namespace, manifest_yaml: manifest },
          transport.metadata,
        ),
      )
      const resource = parseJson(response.json)
      if (resource) outputResource(resource, resolved.output)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const get = Command.make('get', { name: nameArg }, ({ name }) =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      if (transport.mode === 'kube') {
        const resource = yield* Effect.promise(() =>
          getCustomObjectOptional(transport.backend, AGENT_RUN_SPEC, name, resolved.namespace),
        )
        if (!resource) throw new Error('AgentRun not found')
        outputResource(resource, resolved.output)
        return
      }
      const response = yield* Effect.promise(() =>
        callUnary<{ json: string }>(
          transport.client,
          'GetAgentRun',
          { name, namespace: resolved.namespace },
          transport.metadata,
        ),
      )
      const resource = parseJson(response.json)
      if (resource) outputResource(resource, resolved.output)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const describe = Command.make('describe', { name: nameArg }, ({ name }) =>
    Effect.gen(function* () {
      const { resolved, flags } = yield* AgentctlContext
      const transport = yield* TransportService
      const describeOutput = resolveDescribeOutput(resolved.output, flags.output)
      if (transport.mode === 'kube') {
        const resource = yield* Effect.promise(() =>
          getCustomObjectOptional(transport.backend, AGENT_RUN_SPEC, name, resolved.namespace),
        )
        if (!resource) throw new Error('AgentRun not found')
        outputResource(resource, describeOutput)
        return
      }
      const response = yield* Effect.promise(() =>
        callUnary<{ json: string }>(
          transport.client,
          'GetAgentRun',
          { name, namespace: resolved.namespace },
          transport.metadata,
        ),
      )
      const resource = parseJson(response.json)
      if (resource) outputResource(resource, describeOutput)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const status = Command.make('status', { name: nameArg }, ({ name }) =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      if (transport.mode === 'kube') {
        const resource = yield* Effect.promise(() =>
          getCustomObjectOptional(transport.backend, AGENT_RUN_SPEC, name, resolved.namespace),
        )
        if (!resource) throw new Error('AgentRun not found')
        outputResource(resource, resolved.output)
        return
      }
      const response = yield* Effect.promise(() =>
        callUnary<{ json: string }>(
          transport.client,
          'GetAgentRun',
          { name, namespace: resolved.namespace },
          transport.metadata,
        ),
      )
      const resource = parseJson(response.json)
      if (resource) outputResource(resource, resolved.output)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const wait = Command.make('wait', { name: nameArg }, ({ name }) =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      if (transport.mode === 'kube') {
        yield* Effect.promise(() =>
          waitForRunCompletionKube(transport.backend, name, resolved.namespace, resolved.output),
        )
        return
      }
      const exitCode = yield* Effect.promise(() =>
        waitForRunCompletion(transport.client, transport.metadata, name, resolved.namespace, resolved.output),
      )
      if (exitCode !== 0) {
        throw { _tag: 'GrpcError', message: '' }
      }
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const list = Command.make(
    'list',
    { selector: selectorOption, phase: phaseOption, runtime: runtimeFilterOption },
    ({ selector, phase, runtime }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const transport = yield* TransportService
        const labelSelector = Option.getOrUndefined(selector)
        const phaseValue = Option.getOrUndefined(phase)
        const runtimeValue = Option.getOrUndefined(runtime)
        if (transport.mode === 'kube') {
          const resource = yield* Effect.promise(() =>
            listCustomObjects(transport.backend, AGENT_RUN_SPEC, resolved.namespace, labelSelector),
          )
          outputList(filterAgentRunsList(resource, phaseValue, runtimeValue), resolved.output)
          return
        }
        const request: Record<string, string> = { namespace: resolved.namespace }
        if (labelSelector) request.label_selector = labelSelector
        if (phaseValue) request.phase = phaseValue
        if (runtimeValue) request.runtime = runtimeValue
        const response = yield* Effect.promise(() =>
          callUnary<{ json: string }>(transport.client, 'ListAgentRuns', request, transport.metadata),
        )
        const resource = parseJson(response.json)
        if (resource) outputList(resource, resolved.output)
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const watch = Command.make(
    'watch',
    { selector: selectorOption, phase: phaseOption, runtime: runtimeFilterOption, interval: intervalOption },
    ({ selector, phase, runtime, interval }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const transport = yield* TransportService
        const labelSelector = Option.getOrUndefined(selector)
        const phaseValue = Option.getOrUndefined(phase)
        const runtimeValue = Option.getOrUndefined(runtime)
        const intervalMs = parseIntervalMs(Option.getOrUndefined(interval))
        let iteration = 0
        const stop = () => process.exit(0)
        process.on('SIGINT', stop)
        while (true) {
          if (transport.mode === 'kube') {
            const resource = yield* Effect.promise(() =>
              listCustomObjects(transport.backend, AGENT_RUN_SPEC, resolved.namespace, labelSelector),
            )
            if (resolved.output === 'table') {
              clearScreen()
            } else if (iteration > 0) {
              console.log('')
            }
            outputList(filterAgentRunsList(resource, phaseValue, runtimeValue), resolved.output)
          } else {
            const request: Record<string, string> = { namespace: resolved.namespace }
            if (labelSelector) request.label_selector = labelSelector
            if (phaseValue) request.phase = phaseValue
            if (runtimeValue) request.runtime = runtimeValue
            const response = yield* Effect.promise(() =>
              callUnary<{ json: string }>(transport.client, 'ListAgentRuns', request, transport.metadata),
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

  const logs = Command.make('logs', { name: nameArg, follow: Options.boolean('follow') }, ({ name, follow }) =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      if (transport.mode === 'kube') {
        const resource = yield* Effect.promise(() =>
          getCustomObjectOptional(transport.backend, AGENT_RUN_SPEC, name, resolved.namespace),
        )
        if (!resource) throw new Error('AgentRun not found')
        const { runtimeType, runtimeName } = resolveAgentRunRuntime(resource)
        const selector = isJobRuntime(runtimeType) && runtimeName ? `job-name=${runtimeName}` : runLabelSelector(name)
        const pod = yield* Effect.promise(() => pickPodForRun(transport.backend, resolved.namespace, selector))
        if (!pod) throw new Error('No pods found for AgentRun')
        const podName = readNestedValue(pod, ['metadata', 'name'])
        if (typeof podName !== 'string' || !podName) throw new Error('Pod name not available for logs')
        const containerName = resolvePodContainerName(pod)
        yield* Effect.promise(() =>
          streamPodLogs(transport.backend, resolved.namespace, podName, containerName, follow),
        )
        return
      }
      const stream = (
        transport.client as unknown as Record<string, (...args: unknown[]) => grpc.ClientReadableStream<unknown>>
      ).StreamAgentRunLogs
      if (!stream) throw new Error('StreamAgentRunLogs not available')
      const call = stream.call(transport.client, { name, namespace: resolved.namespace, follow }, transport.metadata)
      call.on('data', (entry: { stream?: string; message?: string }) => {
        const message = entry.message ?? ''
        if (entry.stream === 'stderr') {
          process.stderr.write(message)
        } else {
          process.stdout.write(message)
        }
      })
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            call.on('end', () => resolve())
            call.on('error', (error: unknown) => reject(error))
          }),
      )
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const cancel = Command.make('cancel', { name: nameArg }, ({ name }) =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      if (transport.mode === 'kube') {
        const resource = yield* Effect.promise(() =>
          getCustomObjectOptional(transport.backend, AGENT_RUN_SPEC, name, resolved.namespace),
        )
        if (!resource) throw new Error('AgentRun not found')
        const { runtimeType, runtimeName } = resolveAgentRunRuntime(resource)
        if (runtimeType === 'workflow') {
          yield* Effect.promise(() =>
            deleteJobsBySelector(transport.backend, resolved.namespace, runLabelSelector(name)),
          )
          console.log('cancelled')
          return
        }
        if (isJobRuntime(runtimeType) && runtimeName) {
          const deleted = yield* Effect.promise(() =>
            deleteJobByName(transport.backend, resolved.namespace, runtimeName),
          )
          console.log(deleted ? 'cancelled' : 'job not found')
          return
        }
        if (isJobRuntime(runtimeType)) {
          yield* Effect.promise(() =>
            deleteJobsBySelector(transport.backend, resolved.namespace, runLabelSelector(name)),
          )
          console.log('cancelled')
          return
        }
        throw new Error('No cancellable runtime found for this AgentRun')
      }
      const response = yield* Effect.promise(() =>
        callUnary<{ ok: boolean; message?: string }>(
          transport.client,
          'CancelAgentRun',
          { name, namespace: resolved.namespace },
          transport.metadata,
        ),
      )
      console.log(response.message ?? 'cancelled')
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const init = Command.make(
    'init',
    {
      name: Options.optional(Options.text('name')),
      agent: Options.optional(Options.text('agent')),
      impl: Options.optional(Options.text('impl')),
      runtime: Options.optional(Options.text('runtime')),
      runtimeConfig: Options.repeated(Options.text('runtime-config')),
      param: Options.repeated(Options.text('param')),
      workloadImage: Options.optional(Options.text('workload-image')),
      cpu: Options.optional(Options.text('cpu')),
      memory: Options.optional(Options.text('memory')),
      memoryRef: Options.optional(Options.text('memory-ref')),
      vcs: Options.optional(Options.text('vcs')),
      vcsMode: Options.optional(Options.text('vcs-mode')),
      vcsRequired: Options.boolean('vcs-required'),
      idempotencyKey: Options.optional(Options.text('idempotency-key')),
      file: Options.optional(Options.text('file')),
      apply: Options.boolean('apply'),
      wait: Options.boolean('wait'),
    },
    ({
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
      vcs,
      vcsMode,
      vcsRequired,
      idempotencyKey,
      file,
      apply,
      wait,
    }) =>
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
        const resolvedVcsRef = Option.getOrUndefined(vcs)
        const resolvedVcsMode = Option.getOrUndefined(vcsMode)
        const resolvedVcsRequired = vcsRequired

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
          vcsRef: resolvedVcsRef,
          vcsPolicyMode: resolvedVcsMode,
          vcsPolicyRequired: resolvedVcsRequired,
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

        const input: RunSubmitInput = {
          agent: resolvedAgent,
          impl: resolvedImpl,
          runtime: resolvedRuntime,
          runtimeConfig: runtimeParams,
          parameters: params,
          idempotencyKey: Option.getOrUndefined(idempotencyKey),
          workloadImage: resolvedWorkloadImage,
          cpu: resolvedCpu,
          memory: resolvedMemory,
          memoryRef: resolvedMemoryRef,
          vcsRef: resolvedVcsRef,
          vcsPolicyMode: resolvedVcsMode,
          vcsPolicyRequired: resolvedVcsRequired,
          wait,
        }

        if (transport.mode === 'kube') {
          const resources = yield* Effect.promise(() => applyManifest(transport.backend, yaml, resolved.namespace))
          outputResources(resources, resolved.output)
          if (wait) {
            const resource = resources[0]
            const runName = readNestedValue(resource, ['metadata', 'name'])
            if (typeof runName === 'string' && runName) {
              yield* Effect.promise(() =>
                waitForRunCompletionKube(transport.backend, runName, resolved.namespace, resolved.output),
              )
            }
          }
          return
        }

        yield* Effect.promise(() =>
          submitRunGrpc(transport.client, transport.metadata, resolved.namespace, resolved.output, input),
        )
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const codex = Command.make(
    'codex',
    {
      prompt: Options.optional(Options.text('prompt')),
      agent: Options.optional(Options.text('agent')),
      runtime: Options.optional(Options.text('runtime')),
      runtimeConfig: Options.repeated(Options.text('runtime-config')),
      param: Options.repeated(Options.text('param')),
      workloadImage: Options.optional(Options.text('workload-image')),
      cpu: Options.optional(Options.text('cpu')),
      memory: Options.optional(Options.text('memory')),
      memoryRef: Options.optional(Options.text('memory-ref')),
      vcs: Options.optional(Options.text('vcs')),
      vcsMode: Options.optional(Options.text('vcs-mode')),
      vcsRequired: Options.boolean('vcs-required'),
      idempotencyKey: Options.optional(Options.text('idempotency-key')),
      wait: Options.boolean('wait'),
    },
    ({
      prompt,
      agent,
      runtime,
      runtimeConfig,
      param,
      workloadImage,
      cpu,
      memory,
      memoryRef,
      vcs,
      vcsMode,
      vcsRequired,
      idempotencyKey,
      wait,
    }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const transport = yield* TransportService
        const resolvedPrompt = yield* resolvePromptText(prompt, 'Codex prompt')
        const resolvedAgent = yield* resolvePromptText(agent, 'Agent name')
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
        const resolvedVcsRef = Option.getOrUndefined(vcs)
        const resolvedVcsMode = Option.getOrUndefined(vcsMode)
        const resolvedVcsRequired = vcsRequired

        const spec = yield* Effect.tryPromise({
          try: () => runCodex(resolvedPrompt),
          catch: (error) => asAgentctlError(error, 'CodexError'),
        })
        let implName: string | null = null

        if (transport.mode === 'kube') {
          const manifest: Record<string, unknown> = {
            apiVersion: `${RESOURCE_SPECS.impl.group}/${RESOURCE_SPECS.impl.version}`,
            kind: RESOURCE_SPECS.impl.kind,
            metadata: { generateName: 'impl-', namespace: resolved.namespace },
            spec: {
              summary: spec.summary,
              text: spec.text,
              ...(spec.acceptanceCriteria.length > 0 ? { acceptanceCriteria: spec.acceptanceCriteria } : {}),
              ...(spec.labels && spec.labels.length > 0 ? { labels: spec.labels } : {}),
            },
          }
          const resource = yield* Effect.promise(() =>
            createCustomObject(transport.backend, RESOURCE_SPECS.impl, resolved.namespace, manifest),
          )
          const nameValue = readNestedValue(resource, ['metadata', 'name'])
          implName = typeof nameValue === 'string' ? nameValue : null
        } else {
          const generatedName = `impl-${randomUUID().slice(0, 8)}`
          const manifestYaml = buildImplementationSpecYaml({
            name: generatedName,
            namespace: resolved.namespace,
            summary: spec.summary,
            text: spec.text,
            acceptanceCriteria: spec.acceptanceCriteria,
            labels: spec.labels,
          })
          const response = yield* Effect.promise(() =>
            callUnary<{ json: string }>(
              transport.client,
              'ApplyImplementationSpec',
              { namespace: resolved.namespace, manifest_yaml: manifestYaml },
              transport.metadata,
            ),
          )
          const resource = parseJson(response.json)
          const nameValue = readNestedValue(resource, ['metadata', 'name'])
          implName = typeof nameValue === 'string' ? nameValue : null
        }

        if (!implName) {
          throw new Error('Unable to resolve ImplementationSpec name')
        }

        const input: RunSubmitInput = {
          agent: resolvedAgent,
          impl: implName,
          runtime: resolvedRuntime,
          runtimeConfig: runtimeParams,
          parameters: params,
          idempotencyKey: Option.getOrUndefined(idempotencyKey),
          workloadImage: resolvedWorkloadImage,
          cpu: resolvedCpu,
          memory: resolvedMemory,
          memoryRef: resolvedMemoryRef,
          vcsRef: resolvedVcsRef,
          vcsPolicyMode: resolvedVcsMode,
          vcsPolicyRequired: resolvedVcsRequired,
          wait,
        }

        if (transport.mode === 'kube') {
          yield* Effect.promise(() => submitRunKube(transport.backend, resolved.namespace, resolved.output, input))
          return
        }

        yield* Effect.promise(() =>
          submitRunGrpc(transport.client, transport.metadata, resolved.namespace, resolved.output, input),
        )
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

  const base = Command.make('run', {}, () =>
    Effect.sync(() => {
      console.log('Usage: agentctl run <submit|apply|get|describe|status|wait|list|watch|logs|cancel|init|codex>')
    }),
  )

  return Command.withSubcommands(base, [
    submit,
    apply,
    get,
    describe,
    status,
    wait,
    list,
    watch,
    logs,
    cancel,
    init,
    codex,
  ])
}
