import { Args, Command, Options } from '@effect/cli'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import YAML from 'yaml'

import {
  AGENT_RUN_SPEC,
  applyManifest,
  callUnary,
  clearScreen,
  DEFAULT_WATCH_INTERVAL_MS,
  deleteCustomObject,
  filterAgentRunsList,
  getCustomObjectOptional,
  listCustomObjects,
  outputList,
  outputResource,
  outputResources,
  parseJson,
  parseYamlDocuments,
  readFileContent,
  RESOURCE_SPECS,
  RPC_RESOURCE_MAP,
} from '../../legacy'
import { TransportService } from '../../transport'
import { AgentctlContext } from '../context'
import { asAgentctlError } from '../errors'
import { promptConfirm } from '../prompt'
import { resolveResource } from '../resource-registry'
import { sleep } from '../utils'

type RpcMapping = { list: string; get: string; apply: string; del: string; create?: string }

const runRpc: RpcMapping = {
  list: 'ListAgentRuns',
  get: 'GetAgentRun',
  apply: 'ApplyAgentRun',
  del: 'DeleteAgentRun',
}

const kindToRpc = new Map<string, RpcMapping>()
for (const [name, spec] of Object.entries(RESOURCE_SPECS)) {
  const rpc = RPC_RESOURCE_MAP[name]
  kindToRpc.set(spec.kind.toLowerCase(), rpc)
}
kindToRpc.set(AGENT_RUN_SPEC.kind.toLowerCase(), runRpc)

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
const phaseOption = Options.optional(Options.text('phase'))
const runtimeOption = Options.optional(Options.text('runtime'))
const fileOption = Options.text('file').pipe(Options.withAlias('f'))
const dryRunOption = Options.boolean('dry-run')

const confirmOrThrow = (message: string, flags: { yes?: boolean; noInput?: boolean }) =>
  Effect.gen(function* () {
    if (flags.yes) return true
    if (flags.noInput || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Confirmation required; pass --yes to proceed.')
    }
    const confirmed = yield* Effect.promise(() => promptConfirm(message, false))
    return confirmed
  })

const resolveResourceOrThrow = (raw: string) => {
  const resource = resolveResource(raw)
  if (!resource) {
    throw new Error(`Unknown resource: ${raw}`)
  }
  return resource
}

const listRuns = (phase: string | undefined, runtime: string | undefined, selector: string | undefined) =>
  Effect.gen(function* () {
    const { resolved } = yield* AgentctlContext
    const transport = yield* TransportService
    if (transport.mode === 'kube') {
      const resource = yield* Effect.promise(() =>
        listCustomObjects(transport.backend, AGENT_RUN_SPEC, resolved.namespace, selector),
      )
      outputList(filterAgentRunsList(resource, phase, runtime), resolved.output)
      return
    }
    const request: Record<string, string> = { namespace: resolved.namespace }
    if (selector) request.label_selector = selector
    if (phase) request.phase = phase
    if (runtime) request.runtime = runtime
    const response = yield* Effect.promise(() =>
      callUnary<{ json: string }>(transport.client, 'ListAgentRuns', request, transport.metadata),
    )
    const resource = parseJson(response.json)
    if (resource) outputList(resource, resolved.output)
  })

const getRun = (name: string, describeOutput?: string) =>
  Effect.gen(function* () {
    const { resolved } = yield* AgentctlContext
    const transport = yield* TransportService
    if (transport.mode === 'kube') {
      const resource = yield* Effect.promise(() =>
        getCustomObjectOptional(transport.backend, AGENT_RUN_SPEC, name, resolved.namespace),
      )
      if (!resource) throw new Error('AgentRun not found')
      outputResource(resource, describeOutput ?? resolved.output)
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
    if (resource) outputResource(resource, describeOutput ?? resolved.output)
  })

const listGenericResource = (resourceName: string, selector: string | undefined) =>
  Effect.gen(function* () {
    const resource = resolveResourceOrThrow(resourceName)
    if (resource.isRun) {
      throw new Error('Use run-specific filters with `get run` or `list run`.')
    }
    const rpc = resource.rpc
    if (!rpc) throw new Error(`No RPC mapping for ${resource.name}`)
    const { resolved } = yield* AgentctlContext
    const transport = yield* TransportService
    if (transport.mode === 'kube') {
      const response = yield* Effect.promise(() =>
        listCustomObjects(transport.backend, resource.spec, resolved.namespace, selector),
      )
      outputList(response, resolved.output)
      return
    }
    const request: Record<string, string> = { namespace: resolved.namespace }
    if (selector) request.label_selector = selector
    const response = yield* Effect.promise(() =>
      callUnary<{ json: string }>(transport.client, rpc.list, request, transport.metadata),
    )
    const body = parseJson(response.json)
    if (body) outputList(body, resolved.output)
  })

const getGenericResource = (resourceName: string, name: string, describeOutput?: string) =>
  Effect.gen(function* () {
    const resource = resolveResourceOrThrow(resourceName)
    if (resource.isRun) {
      yield* getRun(name, describeOutput)
      return
    }
    const rpc = resource.rpc
    if (!rpc) throw new Error(`No RPC mapping for ${resource.name}`)
    const { resolved } = yield* AgentctlContext
    const transport = yield* TransportService
    if (transport.mode === 'kube') {
      const response = yield* Effect.promise(() =>
        getCustomObjectOptional(transport.backend, resource.spec, name, resolved.namespace),
      )
      if (!response) throw new Error(`${resource.name} ${name} not found`)
      outputResource(response, describeOutput ?? resolved.output)
      return
    }
    const response = yield* Effect.promise(() =>
      callUnary<{ json: string }>(
        transport.client,
        rpc.get,
        { name, namespace: resolved.namespace },
        transport.metadata,
      ),
    )
    const body = parseJson(response.json)
    if (body) outputResource(body, describeOutput ?? resolved.output)
  })

export const makeGetCommand = () => {
  const resourceArg = Args.text({ name: 'resource' })
  const nameArg = Args.optional(Args.text({ name: 'name' }))
  return Command.make('get', { resource: resourceArg, name: nameArg, selector: selectorOption, phase: phaseOption, runtime: runtimeOption }, ({ resource, name, selector, phase, runtime }) =>
    Effect.gen(function* () {
      const resolvedName = Option.getOrUndefined(name)
      const resolvedSelector = Option.getOrUndefined(selector)
      const resolvedPhase = Option.getOrUndefined(phase)
      const resolvedRuntime = Option.getOrUndefined(runtime)

      if (!resolvedName) {
        const entry = resolveResourceOrThrow(resource)
        if (entry.isRun) {
          yield* listRuns(resolvedPhase, resolvedRuntime, resolvedSelector)
          return
        }
        if (resolvedPhase || resolvedRuntime) {
          throw new Error('Run filters are only supported for resource "run".')
        }
        yield* listGenericResource(resource, resolvedSelector)
        return
      }

      if (resolvedSelector || resolvedPhase || resolvedRuntime) {
        throw new Error('Selectors and filters are only supported when listing resources.')
      }
      yield* getGenericResource(resource, resolvedName)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )
}

export const makeDescribeCommand = () => {
  const resourceArg = Args.text({ name: 'resource' })
  const nameArg = Args.text({ name: 'name' })
  return Command.make('describe', { resource: resourceArg, name: nameArg }, ({ resource, name }) =>
    Effect.gen(function* () {
      const { resolved, flags } = yield* AgentctlContext
      const describeOutput = resolveDescribeOutput(resolved.output, flags.output)
      yield* getGenericResource(resource, name, describeOutput)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )
}

export const makeListCommand = () => {
  const resourceArg = Args.text({ name: 'resource' })
  return Command.make(
    'list',
    { resource: resourceArg, selector: selectorOption, phase: phaseOption, runtime: runtimeOption },
    ({ resource, selector, phase, runtime }) =>
      Effect.gen(function* () {
        const resolvedSelector = Option.getOrUndefined(selector)
        const resolvedPhase = Option.getOrUndefined(phase)
        const resolvedRuntime = Option.getOrUndefined(runtime)
        const entry = resolveResourceOrThrow(resource)
        if (entry.isRun) {
          yield* listRuns(resolvedPhase, resolvedRuntime, resolvedSelector)
          return
        }
        if (resolvedPhase || resolvedRuntime) {
          throw new Error('Run filters are only supported for resource "run".')
        }
        yield* listGenericResource(resource, resolvedSelector)
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )
}

export const makeWatchCommand = () => {
  const resourceArg = Args.text({ name: 'resource' })
  return Command.make(
    'watch',
    { resource: resourceArg, selector: selectorOption, phase: phaseOption, runtime: runtimeOption, interval: intervalOption },
    ({ resource, selector, phase, runtime, interval }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const resolvedSelector = Option.getOrUndefined(selector)
        const resolvedPhase = Option.getOrUndefined(phase)
        const resolvedRuntime = Option.getOrUndefined(runtime)
        const intervalMs = parseIntervalMs(Option.getOrUndefined(interval))
        const entry = resolveResourceOrThrow(resource)

        let iteration = 0
        const stop = () => process.exit(0)
        process.on('SIGINT', stop)
        while (true) {
          if (resolved.output === 'table' || resolved.output === 'wide') {
            clearScreen()
          } else if (iteration > 0) {
            console.log('')
          }
          if (entry.isRun) {
            yield* listRuns(resolvedPhase, resolvedRuntime, resolvedSelector)
          } else {
            if (resolvedPhase || resolvedRuntime) {
              throw new Error('Run filters are only supported for resource "run".')
            }
            yield* listGenericResource(resource, resolvedSelector)
          }
          iteration += 1
          yield* Effect.promise(() => sleep(intervalMs))
        }
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )
}

export const makeDeleteCommand = () => {
  const resourceArg = Args.text({ name: 'resource' })
  const nameArg = Args.text({ name: 'name' })
  return Command.make('delete', { resource: resourceArg, name: nameArg, dryRun: dryRunOption }, ({ resource, name, dryRun }) =>
    Effect.gen(function* () {
      const entry = resolveResourceOrThrow(resource)
      if (entry.isRun || entry.supportsDelete === false) {
        throw new Error('Deleting runs is not supported. Use `agentctl run cancel <name>`.')
      }
      if (!entry.rpc) {
        throw new Error(`No RPC mapping for ${entry.name}`)
      }
      const { resolved, flags } = yield* AgentctlContext
      const transport = yield* TransportService
      if (dryRun) {
        if (transport.mode === 'kube') {
          const resourceBody = yield* Effect.promise(() =>
            getCustomObjectOptional(transport.backend, entry.spec, name, resolved.namespace),
          )
          if (!resourceBody) throw new Error(`${entry.name} ${name} not found`)
          outputResource(resourceBody, resolved.output)
          return
        }
        const response = yield* Effect.promise(() =>
          callUnary<{ json: string }>(
            transport.client,
            entry.rpc.get,
            { name, namespace: resolved.namespace },
            transport.metadata,
          ),
        )
        const resourceBody = parseJson(response.json)
        if (resourceBody) outputResource(resourceBody, resolved.output)
        return
      }

      const confirmed = yield* confirmOrThrow(`Delete ${entry.name} ${name}?`, flags)
      if (!confirmed) {
        console.log('Cancelled')
        return
      }

      if (transport.mode === 'kube') {
        const result = yield* Effect.promise(() =>
          deleteCustomObject(transport.backend, entry.spec, resolved.namespace, name),
        )
        if (!result) throw new Error(`${entry.name} ${name} not found`)
        console.log('deleted')
        return
      }
      const response = yield* Effect.promise(() =>
        callUnary<{ ok: boolean; message?: string }>(
          transport.client,
          entry.rpc.del,
          { name, namespace: resolved.namespace },
          transport.metadata,
        ),
      )
      console.log(response.message ?? 'deleted')
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )
}

export const makeApplyCommand = () => {
  return Command.make('apply', { file: fileOption, dryRun: dryRunOption }, ({ file, dryRun }) =>
    Effect.gen(function* () {
      const { resolved, flags } = yield* AgentctlContext
      const transport = yield* TransportService
      const manifest = yield* Effect.promise(() => readFileContent(file))

      if (dryRun) {
        const docs = parseYamlDocuments(manifest)
        if (docs.length === 0) throw new Error('No resources found in manifest')
        outputResources(docs, resolved.output)
        return
      }

      const confirmed = yield* confirmOrThrow(`Apply manifest from ${file}?`, flags)
      if (!confirmed) {
        console.log('Cancelled')
        return
      }

      if (transport.mode === 'kube') {
        const resources = yield* Effect.promise(() => applyManifest(transport.backend, manifest, resolved.namespace))
        outputResources(resources, resolved.output)
        return
      }

      const docs = parseYamlDocuments(manifest)
      if (docs.length === 0) throw new Error('No resources found in manifest')
      const applied: Record<string, unknown>[] = []
      for (const doc of docs) {
        const kind = typeof doc.kind === 'string' ? doc.kind.toLowerCase() : ''
        if (!kind) {
          throw new Error('Manifest is missing kind')
        }
        const rpc = kindToRpc.get(kind)
        if (!rpc) {
          throw new Error(`No gRPC apply handler for kind ${doc.kind}`)
        }
        const response = yield* Effect.promise(() =>
          callUnary<{ json: string }>(
            transport.client,
            rpc.apply,
            { namespace: resolved.namespace, manifest_yaml: YAML.stringify(doc) },
            transport.metadata,
          ),
        )
        const resource = parseJson(response.json)
        if (resource) applied.push(resource)
      }
      outputResources(applied, resolved.output)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )
}

export const makeExplainCommand = () => {
  const resourceArg = Args.text({ name: 'resource' })
  return Command.make('explain', { resource: resourceArg }, ({ resource }) =>
    Effect.sync(() => {
      const entry = resolveResourceOrThrow(resource)
      const apiVersion = `${entry.spec.group}/${entry.spec.version}`
      const sample = {
        apiVersion,
        kind: entry.spec.kind,
        metadata: { name: `${entry.name}-example` },
        spec: {},
      }
      console.log(`Kind: ${entry.spec.kind}`)
      console.log(`API Version: ${apiVersion}`)
      console.log(`Plural: ${entry.spec.plural}`)
      console.log('')
      console.log('Sample manifest:')
      console.log(YAML.stringify(sample))
    }).pipe(Effect.mapError((error) => asAgentctlError(error, 'ValidationError'))),
  )
}
