import { Command, Flag } from 'effect/cli'
import * as Effect from 'effect/Effect'
import YAML from 'yaml'
import { resolveRunHeadBranch } from '../../../src/server/agents-controller/run-utils'
import { asRecord, asString } from '../../../src/server/primitives'
import type { KubeBackend } from '../kube/backend'
import { isJobRuntime, observeRuns, RUN_LABEL } from '../kube/runs'
import {
  AGENT_RUN_SPEC,
  outputResource,
  readFileContent,
  readNestedValue,
  renderTable,
  RESOURCE_SPECS,
} from '../runtime'
import { TransportService } from '../transport'
import { AgentctlContext } from './context'
import { asAgentctlError, validationError } from './errors'
import { buildEventContext } from './run-input'
import { kubeCall, readVerificationIdentity, verifyRun } from './run-observation'
import { kubeStatusSuffix, redactRunText } from './run-redaction'

const apiVersion = `${AGENT_RUN_SPEC.group}/${AGENT_RUN_SPEC.version}`
const apiName = (name: unknown, max = 253): name is string =>
  typeof name === 'string' && name.length <= max && /^[a-z0-9](?:[-.a-z0-9]*[a-z0-9])?$/.test(name)

type Implementation = { source: 'inline'; spec: Record<string, unknown> } | { source: 'ref'; name: string }
type Task = { implementation: Implementation; parameters: Record<string, string>; executable: boolean }

export const parseRunBatch = (content: string, namespace: string, verify: boolean) => {
  const documents = YAML.parseAllDocuments(content)
  const manifests = documents.flatMap((document, index) => {
    if (document.errors.length) throw validationError(`Batch document ${index + 1}: invalid YAML or JSON.`)
    let value: unknown
    try {
      value = document.toJS()
    } catch {
      throw validationError(`Batch document ${index + 1}: could not read YAML or JSON values.`)
    }
    if (Array.isArray(value)) return value as unknown[]
    if (asRecord(value)?.kind === 'List') {
      const items = asRecord(value)?.items
      if (!Array.isArray(items)) throw validationError(`Batch document ${index + 1}: List.items must be an array.`)
      return items as unknown[]
    }
    return [value]
  })
  if (!manifests.length) throw validationError('Batch must contain at least one AgentRun.')

  const names = new Set<string>()
  return manifests.map((manifest, offset) => {
    const index = offset + 1
    const invalid = (message: string) => validationError(`Batch entry ${index}: ${message}`)
    const resource = asRecord(manifest)
    const metadata = asRecord(resource?.metadata)
    const spec = asRecord(resource?.spec)
    if (
      !resource ||
      resource.kind !== AGENT_RUN_SPEC.kind ||
      resource.apiVersion !== apiVersion ||
      !metadata ||
      !spec
    ) {
      throw invalid(`expected an ${apiVersion} AgentRun with metadata and spec.`)
    }
    if (metadata.namespace !== undefined && metadata.namespace !== namespace) {
      throw invalid('metadata.namespace must match the selected namespace.')
    }
    if (metadata.name !== undefined) {
      if (!apiName(metadata.name, 63))
        throw invalid('metadata.name must be a Kubernetes name of at most 63 characters.')
      if (names.has(metadata.name)) throw invalid('duplicate metadata.name.')
      names.add(metadata.name)
    } else if (
      typeof metadata.generateName !== 'string' ||
      !apiName(metadata.generateName.replace(/-$/, ''), 58) ||
      metadata.generateName.length > 58
    ) {
      throw invalid('provide metadata.name or a metadata.generateName prefix of at most 58 characters.')
    }

    const agent = asRecord(spec.agentRef)?.name
    if (!apiName(agent)) throw invalid('provide a valid spec.agentRef.name.')
    const runtime = asRecord(spec.runtime)
    const type = asString(runtime?.type)
    if (!type || !['job', 'workflow', 'temporal', 'custom'].includes(type))
      throw invalid('provide a valid spec.runtime.type.')
    if (verify && !isJobRuntime(type)) throw invalid('--verify requires the job or workflow runtime.')

    const checkIdentity = (...values: unknown[]) => {
      for (const field of ['serviceAccount', 'serviceAccountName']) {
        if (values.some((value) => Object.hasOwn(asRecord(value) ?? {}, field))) {
          throw invalid(`${field} overrides are forbidden; inherit the AgentProvider identity.`)
        }
      }
    }
    checkIdentity(spec, runtime?.config, spec.workload)

    const implementation = (value: Record<string, unknown>): Implementation | undefined => {
      if (value.implementation !== undefined && value.implementationSpecRef !== undefined) {
        throw invalid('choose only one implementation source (inline text or ImplementationSpec reference).')
      }
      if (value.implementation !== undefined) {
        const inline = asRecord(asRecord(value.implementation)?.inline)
        if (!inline || !asString(inline.text)) throw invalid('implementation.inline.text must be a non-empty prompt.')
        return { source: 'inline', spec: inline }
      }
      if (value.implementationSpecRef !== undefined) {
        const name = asRecord(value.implementationSpecRef)?.name
        if (!apiName(name)) throw invalid('provide a valid implementationSpecRef.name for the prompt.')
        return { source: 'ref', name }
      }
      return undefined
    }
    const parameters = (value: unknown) => {
      if (value === undefined) return {}
      const record = asRecord(value)
      if (!record) throw invalid('parameters must be an object with string values.')
      return Object.fromEntries(
        Object.entries(record).map(([key, value]) => {
          if (key.trim().toLowerCase() === 'prompt')
            throw invalid('parameters.prompt is forbidden; use implementation text.')
          if (typeof value !== 'string') throw invalid('parameters must have string values.')
          return [key, value]
        }),
      )
    }

    const baseImpl = implementation(spec)
    if (!baseImpl) throw invalid('provide a prompt in spec.implementation.inline.text or spec.implementationSpecRef.')
    const baseParameters = parameters(spec.parameters)
    const tasks: Task[] = [{ implementation: baseImpl, parameters: baseParameters, executable: type !== 'workflow' }]
    if (type === 'workflow') {
      const steps = asRecord(spec.workflow)?.steps
      if (!Array.isArray(steps) || !steps.length) throw invalid('workflow runs require spec.workflow.steps.')
      const stepNames = new Set<string>()
      for (const raw of steps) {
        const step = asRecord(raw)
        const name = asString(step?.name)
        if (!step || !name || stepNames.has(name)) throw invalid('workflow steps must have unique, non-empty names.')
        stepNames.add(name)
        checkIdentity(step, step.workload)
        tasks.push({
          implementation: implementation(step) ?? baseImpl,
          parameters: { ...baseParameters, ...parameters(step.parameters) },
          executable: true,
        })
      }
    }
    return { index, agent, tasks, manifest: { ...resource, metadata: { ...metadata, namespace } } }
  })
}

export const prepareRunBatch = (
  entries: ReturnType<typeof parseRunBatch>,
  implementations: ReadonlyMap<string, unknown>,
) => {
  const branchOwners = new Map<string, number>()
  return entries.map((entry) => {
    const prompts = entry.tasks.flatMap(({ implementation, parameters, executable }) => {
      const spec =
        implementation.source === 'inline' ? implementation.spec : asRecord(implementations.get(implementation.name))
      if (!spec || !asString(spec.text))
        throw validationError(`Batch entry ${entry.index}: ImplementationSpec must have non-empty spec.text.`)
      const { payload } = buildEventContext(spec, parameters)
      const prompt = asString(payload.prompt)
      if (!prompt) throw validationError(`Batch entry ${entry.index}: rendered prompt is empty.`)
      // The workflow base must be valid, but only its steps execute.
      if (!executable) return []
      const head = asString(payload.head) ?? resolveRunHeadBranch({ spec: { parameters } })
      if (head) {
        const owner = branchOwners.get(head)
        if (owner !== undefined && owner !== entry.index)
          throw validationError(`Batch entry ${entry.index}: duplicate head branch (also used by entry ${owner}).`)
        branchOwners.set(head, entry.index)
      }
      return [prompt]
    })
    return { ...entry, prompts }
  })
}

const dispatchBatch = (
  entries: ReturnType<typeof parseRunBatch>,
  backend: KubeBackend,
  namespace: string,
  output: string,
  verify: boolean,
  concurrency: number,
) =>
  Effect.gen(function* () {
    const refs = [
      ...new Set(
        entries.flatMap(({ tasks }) =>
          tasks.flatMap(({ implementation }) => (implementation.source === 'ref' ? [implementation.name] : [])),
        ),
      ),
    ]
    const implementations = new Map(
      yield* Effect.forEach(
        refs,
        (name) =>
          kubeCall((signal) => backend.getCustomObject(RESOURCE_SPECS.impl, namespace, name, signal)).pipe(
            Effect.map((resource) => [name, resource.spec] as const),
          ),
        { concurrency },
      ),
    )
    const prepared = yield* Effect.try({
      try: () => prepareRunBatch(entries, implementations),
      catch: (error) => asAgentctlError(error, 'ValidationError'),
    })
    const identities = new Map(
      yield* Effect.forEach(
        verify ? [...new Set(entries.map(({ agent }) => agent))] : [],
        (agent) =>
          readVerificationIdentity(backend, namespace, agent).pipe(
            Effect.map((identity) => [agent, identity] as const),
          ),
        { concurrency },
      ),
    )

    const create = (entry: (typeof prepared)[number], dryRun: boolean) =>
      kubeCall((signal) => backend.createCustomObject(AGENT_RUN_SPEC, namespace, entry.manifest, { dryRun, signal }))
    // Let the API validate the full CRD and admission contract without persisting any of the runs.
    yield* Effect.forEach(
      prepared,
      (entry) =>
        create(entry, true).pipe(
          Effect.mapError((error) => ({
            _tag: 'KubeError' as const,
            message: `Batch entry ${entry.index}: Kubernetes dry-run rejected the manifest${kubeStatusSuffix(error.message)}; no runs submitted.`,
          })),
        ),
      { concurrency, discard: true },
    )

    const submitted = yield* Effect.forEach(
      prepared,
      (entry) =>
        create(entry, false).pipe(
          Effect.match({
            onSuccess: (resource) => ({ entry, resource, error: '' }),
            onFailure: (error) => ({ entry, resource: null, error: kubeStatusSuffix(error.message) }),
          }),
        ),
      { concurrency },
    )
    type Row = { entry: number; name: string | null; node: string | null; status: string }
    const rows: Row[] = submitted.map(({ entry, resource, error }) => {
      const name = readNestedValue(resource, ['metadata', 'name'])
      if (!apiName(name, 63)) {
        console.error(
          `Batch entry ${entry.index}: create did not confirm an AgentRun${error}; inspect namespace ${namespace} before retrying.`,
        )
        return { entry: entry.index, name: null, node: null, status: 'Unconfirmed' }
      }
      return { entry: entry.index, name, node: null, status: 'Submitted' }
    })

    if (verify) {
      for (const { name } of rows) if (name) console.error(`Submitted AgentRun ${namespace}/${name}.`)
      yield* Effect.forEach(
        rows,
        (row, index) =>
          Effect.gen(function* () {
            if (!row.name) return
            const { entry } = submitted[index]
            const identity = identities.get(entry.agent)
            if (!identity) return yield* Effect.die(new Error('Missing preflight verification identity'))
            const result = yield* verifyRun(backend, namespace, row.name, {
              ...identity,
              stepPrompts: entry.prompts,
            }).pipe(
              Effect.match({
                onSuccess: ({ node }) => ({ node: node ?? null, status: 'Verified' }),
                onFailure: (error) => {
                  console.error(redactRunText(error.message))
                  return { node: null, status: 'Verification failed' }
                },
              }),
            )
            Object.assign(row, result)
          }),
        { concurrency, discard: true },
      )
    }
    if (rows.some(({ name, node }) => name && !node)) {
      // One scheduling snapshot, not a separate Job/Pod poll per submitted run.
      const nodes = yield* kubeCall(async (signal) => {
        const resources = submitted.flatMap(({ resource }, index) => (resource && rows[index].name ? [resource] : []))
        const pods = await backend.listPods(namespace, RUN_LABEL, signal)
        return new Map(observeRuns(resources, [], pods, namespace).map(({ name, node }) => [name, node]))
      }).pipe(
        Effect.catch((error) => {
          console.error(
            `Runs submitted, but Pod placement could not be read${kubeStatusSuffix(error.message)}; see agentctl run list -o wide.`,
          )
          return Effect.succeed(new Map<string, string | undefined>())
        }),
      )
      for (const row of rows) if (row.name && !row.node) row.node = nodes.get(row.name) ?? null
    }

    if (['json', 'yaml', 'yaml-stream'].includes(output)) outputResource({ runs: rows }, output)
    else
      renderTable(rows, [
        { label: 'ENTRY', value: ({ entry }) => String(entry) },
        { label: 'NAME', value: ({ name }) => name ?? '-' },
        { label: 'NODE', value: ({ node }) => node ?? '-' },
        { label: 'STATUS', value: ({ status }) => status },
      ])
    if (rows.some(({ status }) => status !== 'Submitted' && status !== 'Verified')) {
      return yield* Effect.fail({
        _tag: 'KubeError' as const,
        message: 'Batch incomplete; inspect the reported runs before retrying.',
      })
    }
  })

export const makeRunBatchCommand = () =>
  Command.make(
    'batch',
    {
      spec: Flag.String('spec').pipe(
        Flag.withDescription('YAML or JSON file containing AgentRun manifests (or - for stdin).'),
      ),
      verify: Flag.Boolean('verify').pipe(
        Flag.withDefault(false),
        Flag.withDescription('Verify every submitted runner Pod’s prompt and inherited identity.'),
      ),
      concurrency: Flag.Int('concurrency').pipe(
        Flag.withDefault(8),
        Flag.withDescription('Maximum parallel runs per stage (default: 8).'),
      ),
    },
    ({ spec, verify, concurrency }) =>
      Effect.gen(function* () {
        const {
          resolved: { namespace, output },
        } = yield* AgentctlContext
        const transport = yield* TransportService
        if (transport.mode !== 'kube') return yield* Effect.fail(validationError('run batch requires Kubernetes mode.'))
        if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
          return yield* Effect.fail(validationError('--concurrency must be a positive integer.'))
        }
        const content = yield* Effect.tryPromise({
          try: () => readFileContent(spec),
          catch: (error) => asAgentctlError(error, 'IoError'),
        })
        const entries = yield* Effect.try({
          try: () => parseRunBatch(content, namespace, verify),
          catch: (error) => asAgentctlError(error, 'ValidationError'),
        })
        yield* dispatchBatch(entries, transport.backend, namespace, output, verify, concurrency)
      }),
  ).pipe(
    Command.withDescription('Preflight and submit a batch of AgentRun manifests with bounded concurrency (kube only).'),
  )
