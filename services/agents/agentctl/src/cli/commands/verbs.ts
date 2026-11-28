import { Argument, Command, Flag } from 'effect/cli'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import YAML from 'yaml'

import { readRun, readRunObservation } from '../../kube/runs'
import {
  AGENT_RUN_SPEC,
  applyManifest,
  callUnary,
  clearScreen,
  DEFAULT_WATCH_INTERVAL_MS,
  deleteCustomObject,
  getCustomObjectOptional,
  listCustomObjects,
  outputList,
  outputResource,
  outputResources,
  parseJson,
  parseYamlDocuments,
  RESOURCE_SPECS,
  RPC_RESOURCE_MAP,
  readFileContent,
} from '../../runtime'
import { TransportService } from '../../transport'
import { AgentctlContext } from '../context'
import { asAgentctlError, validationError } from '../errors'
import { promptConfirm } from '../prompt'
import { resolveResource } from '../resource-registry'
import { hasRunFilters, listRuns, renderRunRows, runFilters, selectorOption } from '../run-list'
import { describeRun, kubeCall } from '../run-observation'

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

const transportErrorTag = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error) return 'GrpcError'
  return 'KubeError'
}

const intervalOption = Flag.optional(
  Flag.String('interval').pipe(Flag.withDescription('Seconds between snapshots (default: 5).')),
)
const fileOption = Flag.String('file').pipe(
  Flag.withAlias('f'),
  Flag.withDescription('Read YAML manifests from this file or - for stdin.'),
)
const dryRunOption = Flag.Boolean('dry-run').pipe(
  Flag.withDefault(false),
  Flag.withDescription('Show what would change without writing to the backend.'),
)
const resourceArg = Argument.String('resource').pipe(
  Argument.withDescription('Resource type, for example agent, impl, or run.'),
)
const nameArg = Argument.String('name').pipe(
  Argument.withDescription('Name of the resource in the selected namespace.'),
)

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

const getRun = (name: string, describe: boolean) =>
  Effect.gen(function* () {
    const {
      resolved: { namespace, output },
      flags,
    } = yield* AgentctlContext
    const transport = yield* TransportService
    if (transport.mode === 'kube') {
      const backend = transport.backend
      if (output === 'table' || output === 'wide') {
        const observation = yield* kubeCall((signal) => readRunObservation(backend, namespace, name, signal))
        if (describe) yield* kubeCall(() => describeRun(backend, namespace, observation))
        else renderRunRows([observation], output)
      } else {
        const resource = yield* kubeCall((signal) => readRun(backend, namespace, name, signal))
        outputResource(resource, output)
      }
      return
    }
    const response = yield* Effect.tryPromise({
      try: () => callUnary<{ json: string }>(transport.client, 'GetAgentRun', { name, namespace }, transport.metadata),
      catch: (error) => asAgentctlError(error, 'GrpcError'),
    })
    const resource = parseJson(response.json)
    if (resource) outputResource(resource, describe && !flags.output ? 'yaml' : output)
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

const getGenericResource = (resourceName: string, name: string, describe = false) =>
  Effect.gen(function* () {
    const resource = resolveResourceOrThrow(resourceName)
    if (resource.isRun) {
      yield* getRun(name, describe)
      return
    }
    const rpc = resource.rpc
    if (!rpc) throw new Error(`No RPC mapping for ${resource.name}`)
    const { resolved, flags } = yield* AgentctlContext
    const output = describe && !flags.output ? 'yaml' : resolved.output
    const transport = yield* TransportService
    if (transport.mode === 'kube') {
      const response = yield* Effect.promise(() =>
        getCustomObjectOptional(transport.backend, resource.spec, name, resolved.namespace),
      )
      if (!response) throw new Error(`${resource.name} ${name} not found`)
      outputResource(response, output)
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
    if (body) outputResource(body, output)
  })

export const makeGetCommand = () =>
  Command.make(
    'get',
    { resource: resourceArg, name: Argument.optional(nameArg), selector: selectorOption, ...runFilters },
    ({ resource, name, selector, ...filters }) =>
      Effect.gen(function* () {
        if (Option.isSome(name)) {
          if (Option.isSome(selector) || hasRunFilters(filters)) {
            return yield* Effect.fail(
              validationError('Selectors and filters are only supported when listing resources.'),
            )
          }
          yield* getGenericResource(resource, name.value)
        } else {
          yield* listResource(resource, Option.getOrUndefined(selector), filters)
        }
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  ).pipe(Command.withDescription('Get one resource or list resources of the requested type.'))

export const makeDescribeCommand = () =>
  Command.make('describe', { resource: resourceArg, name: nameArg }, ({ resource, name }) =>
    getGenericResource(resource, name, true).pipe(
      Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error))),
    ),
  ).pipe(Command.withDescription('Show resource details, including live workload and Events for an AgentRun.'))

const listResource = (resource: string, selector: string | undefined, filters: Parameters<typeof listRuns>[0]) =>
  Effect.gen(function* () {
    if (resolveResourceOrThrow(resource).isRun) {
      yield* listRuns(filters, selector)
    } else {
      if (hasRunFilters(filters)) {
        return yield* Effect.fail(validationError('Run filters are only supported for resource "run".'))
      }
      yield* listGenericResource(resource, selector)
    }
  })

export const makeListCommand = () =>
  Command.make(
    'list',
    { resource: resourceArg, selector: selectorOption, ...runFilters },
    ({ resource, selector, ...filters }) =>
      listResource(resource, Option.getOrUndefined(selector), filters).pipe(
        Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error))),
      ),
  ).pipe(Command.withDescription('List resources, optionally filtering AgentRuns by phase or workload state.'))

export const makeWatchCommand = () =>
  Command.make(
    'watch',
    { resource: resourceArg, selector: selectorOption, interval: intervalOption, ...runFilters },
    ({ resource, selector, interval, ...filters }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const intervalMs = parseIntervalMs(Option.getOrUndefined(interval))
        const structured = resolved.output !== 'table' && resolved.output !== 'wide'
        let iteration = 0
        while (true) {
          if (!structured) clearScreen()
          else if (iteration > 0) console.log('')
          yield* listResource(resource, Option.getOrUndefined(selector), filters)
          iteration += 1
          yield* Effect.sleep(intervalMs)
        }
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  ).pipe(Command.withDescription('Refresh a resource list until interrupted.'))

export const makeDeleteCommand = () => {
  return Command.make(
    'delete',
    { resource: resourceArg, name: nameArg, dryRun: dryRunOption },
    ({ resource, name, dryRun }) =>
      Effect.gen(function* () {
        const entry = resolveResourceOrThrow(resource)
        if (entry.isRun || entry.supportsDelete === false) {
          throw new Error('Deleting runs is not supported. Use `agentctl run cancel <name>`.')
        }
        const rpc = entry.rpc
        if (!rpc) {
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
              rpc.get,
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
            rpc.del,
            { name, namespace: resolved.namespace },
            transport.metadata,
          ),
        )
        console.log(response.message ?? 'deleted')
      }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  ).pipe(Command.withDescription('Delete a resource after confirming; use run cancel for AgentRuns.'))
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
  ).pipe(Command.withDescription('Apply one or more resource manifests.'))
}

export const makeExplainCommand = () => {
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
  ).pipe(Command.withDescription('Show the Kubernetes identity and an example for a resource type.'))
}
