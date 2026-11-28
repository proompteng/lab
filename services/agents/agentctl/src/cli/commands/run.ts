import { randomUUID } from 'node:crypto'

import { Argument, Command, Flag } from 'effect/cli'
import type * as grpc from '@grpc/grpc-js'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import YAML from 'yaml'

import { normalizeKubernetesLabelValue } from '../../../../src/kubernetes-labels'
import { createImplementationContractTools } from '../../../../src/server/agents-controller/implementation-contract'
import { runCodex } from '../../codex'
import type { KubeBackend } from '../../kube/backend'
import {
  hasRunUid,
  isJobRuntime,
  isTerminalPhase,
  jobTerminalPhase,
  readRunObservation,
  runtimeType,
} from '../../kube/runs'
import {
  AGENT_RUN_SPEC,
  callUnary,
  outputResource,
  parseJson,
  readFileContent,
  readNestedValue,
  RESOURCE_SPECS,
} from '../../runtime'
import { type AgentRunParams, buildAgentRunSpec } from '../../templates/agent-run'
import { type Transport, TransportService } from '../../transport'
import { AgentctlContext } from '../context'
import { asAgentctlError, validationError } from '../errors'
import { promptText } from '../prompt'
import { parseRunValues } from '../run-input'
import { makeRunListCommand } from '../run-list'
import {
  DEFAULT_RUN_INTERVAL_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  kubeCall,
  runnerContainer,
  type Verification,
  verifyRun,
  waitForRunCompletion,
  waitForRunCompletionKube,
} from '../run-observation'

const textFlag = (name: string, description: string) => Flag.String(name).pipe(Flag.withDescription(description))
const optionalText = (name: string, description: string) => Flag.optional(textFlag(name, description))
const bool = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.withDescription(description))
const runtimeFlag = Flag.Literals('runtime', ['job', 'workflow', 'temporal', 'custom']).pipe(
  Flag.withDescription('Runtime adapter to execute the run.'),
)
const commonFlags = {
  inlinePrompt: optionalText(
    'inline-prompt',
    'Use literal task text as the inline implementation, without local Codex.',
  ),
  promptFile: optionalText('prompt-file', 'Read the inline task text from this file (or - for stdin).'),
  repo: optionalText('repo', 'Set the VCS repository (owner/name).'),
  base: optionalText('base', 'Set the VCS base branch.'),
  head: optionalText('head', 'Set the VCS head branch.'),
  runtimeConfig: Flag.atLeast(textFlag('runtime-config', 'Set a runtime config key=value; repeat as needed.'), 0),
  param: Flag.atLeast(
    textFlag('param', 'Set a run parameter key=value; repeat as needed. Prompt is not a parameter.'),
    0,
  ),
  idempotencyKey: optionalText('idempotency-key', 'Set the controller idempotency key for this task.'),
  workloadImage: optionalText('workload-image', 'Override the runner image.'),
  cpu: optionalText('cpu', 'Set the runner CPU request as a Kubernetes quantity.'),
  memory: Flag.optional(
    textFlag('memory-request', 'Set the runner memory request as a Kubernetes quantity.').pipe(
      Flag.withAlias('memory'),
    ),
  ),
  memoryLimit: optionalText('memory-limit', 'Set the runner memory limit (kube only).'),
  memoryRef: optionalText('memory-ref', 'Reference an Agents Memory resource.'),
  ttl: Flag.optional(
    Flag.Int('ttl').pipe(
      Flag.withDescription('Set AgentRun retention after completion in seconds; 0 disables per-run TTL (kube only).'),
    ),
  ),
  secret: Flag.atLeast(textFlag('secret', 'Reference a Kubernetes Secret by name; repeat as needed (kube only).'), 0),
  vcs: optionalText('vcs', 'Reference a VersionControlProvider.'),
  vcsMode: Flag.optional(
    Flag.Literals('vcs-mode', ['read-write', 'read-only', 'none']).pipe(
      Flag.withDescription('Set the run VCS access policy.'),
    ),
  ),
  vcsRequired: bool('vcs-required', 'Fail the run when VCS setup is unavailable.'),
  wait: bool('wait', 'Wait for the submitted run to finish.'),
  verify: bool(
    'verify',
    'Confirm the rendered prompt, inherited service account, and projected MCP token mount (kube only).',
  ),
}
type CommonFlags = { [K in keyof typeof commonFlags]: (typeof commonFlags)[K] extends Flag.Flag<infer A> ? A : never }

const get = Option.getOrUndefined

const readInputs = (flags: CommonFlags, transport: Transport, implementationRef?: string, codexPrompt?: string) =>
  Effect.gen(function* () {
    const parameters = yield* Effect.try({
      try: () => parseRunValues(flags.param, '--param'),
      catch: (error) => asAgentctlError(error, 'ValidationError'),
    })
    const runtimeConfig = yield* Effect.try({
      try: () => parseRunValues(flags.runtimeConfig, '--runtime-config'),
      catch: (error) => asAgentctlError(error, 'ValidationError'),
    })
    const inline = get(flags.inlinePrompt)
    const file = get(flags.promptFile)
    const ttl = get(flags.ttl)
    const kubeOnly =
      inline !== undefined ||
      file !== undefined ||
      Option.isSome(flags.memoryLimit) ||
      ttl !== undefined ||
      flags.secret.length > 0 ||
      flags.verify
    if (transport.mode !== 'kube' && kubeOnly) {
      return yield* Effect.fail(
        validationError('Inline prompts, --memory-limit, --ttl, --secret, and --verify require Kubernetes mode.'),
      )
    }
    const sources = [implementationRef, codexPrompt, inline, file].filter((source) => source !== undefined)
    if (sources.length > 1) {
      return yield* Effect.fail(
        validationError('Choose only one of --impl, --prompt, --inline-prompt, or --prompt-file.'),
      )
    }
    if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > 2_147_483_647)) {
      return yield* Effect.fail(validationError('--ttl must be between 0 and 2147483647 seconds.'))
    }
    if (flags.verify && Object.hasOwn(runtimeConfig, 'serviceAccountName')) {
      return yield* Effect.fail(
        validationError('--verify requires provider identity; omit --runtime-config serviceAccountName.'),
      )
    }
    const implementationText =
      file === undefined
        ? inline
        : yield* Effect.tryPromise({
            try: () => readFileContent(file),
            catch: (error) => asAgentctlError(error, 'IoError'),
          })
    if (implementationText !== undefined && (!implementationText.trim() || implementationText.length > 131_072)) {
      return yield* Effect.fail(validationError('Inline task text must be non-empty and at most 131072 characters.'))
    }
    if (flags.secret.some((name) => !/^[a-z0-9](?:[-.a-z0-9]*[a-z0-9])?$/.test(name))) {
      return yield* Effect.fail(validationError('--secret expects a Kubernetes Secret name, never a credential value.'))
    }
    return {
      implementationText,
      runtimeConfig,
      parameters: {
        ...parameters,
        ...(Option.isSome(flags.repo) ? { repository: flags.repo.value } : {}),
        ...(Option.isSome(flags.base) ? { base: flags.base.value } : {}),
        ...(Option.isSome(flags.head) ? { head: flags.head.value } : {}),
      },
      idempotencyKey: get(flags.idempotencyKey),
      workloadImage: get(flags.workloadImage),
      cpu: get(flags.cpu),
      memory: get(flags.memory),
      memoryLimit: get(flags.memoryLimit),
      memoryRef: get(flags.memoryRef),
      ttl,
      secrets: flags.secret,
      vcsRef: get(flags.vcs),
      vcsPolicyMode: get(flags.vcsMode),
      vcsPolicyRequired: flags.vcsRequired,
    }
  })

const grpcCall = <T>(tryCall: (signal: AbortSignal) => Promise<T>) =>
  Effect.tryPromise({ try: tryCall, catch: (error) => asAgentctlError(error, 'GrpcError') })

const { buildEventContext } = createImplementationContractTools((params, keys) => {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
})

const readName = (resource: unknown) => {
  const name = readNestedValue(resource, ['metadata', 'name'])
  return typeof name === 'string' && name ? name : undefined
}

const readVerification = (backend: KubeBackend, namespace: string, input: AgentRunParams) =>
  Effect.gen(function* () {
    const agent = yield* kubeCall(() => backend.getCustomObject(RESOURCE_SPECS.agent, namespace, input.agentName))
    const providerName = readNestedValue(agent, ['spec', 'providerRef', 'name'])
    if (typeof providerName !== 'string' || !providerName) {
      return yield* Effect.fail(validationError('--verify requires an Agent with an AgentProvider reference.'))
    }
    const provider = yield* kubeCall(() => backend.getCustomObject(RESOURCE_SPECS.provider, namespace, providerName))
    const serviceAccountName = readNestedValue(provider, ['spec', 'workload', 'serviceAccountName'])
    const audience = readNestedValue(provider, ['spec', 'workload', 'serviceAccountToken', 'audience'])
    const mountPath = readNestedValue(provider, ['spec', 'workload', 'serviceAccountToken', 'mountPath'])
    if (
      typeof serviceAccountName !== 'string' ||
      !serviceAccountName ||
      typeof audience !== 'string' ||
      !audience ||
      typeof mountPath !== 'string' ||
      !mountPath
    ) {
      return yield* Effect.fail(
        validationError('--verify requires an AgentProvider with a service account and MCP token projection.'),
      )
    }
    let implementationSpec: Record<string, unknown> =
      input.implementationText !== undefined ? { text: input.implementationText } : {}
    if (input.implName && input.implementationText === undefined) {
      const impl = yield* kubeCall(() => backend.getCustomObject(RESOURCE_SPECS.impl, namespace, input.implName))
      const spec = readNestedValue(impl, ['spec'])
      if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
        implementationSpec = spec as Record<string, unknown>
      }
    }
    const prompt = buildEventContext(implementationSpec, input.parameters ?? {}).payload.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return yield* Effect.fail(validationError('--verify requires non-empty implementation text.'))
    }
    return { serviceAccountName, audience, mountPath, prompt }
  })

const submitRun = (
  transport: Transport,
  namespace: string,
  output: string,
  input: AgentRunParams,
  wait: boolean,
  expected?: Verification,
) =>
  Effect.gen(function* () {
    let resource: Record<string, unknown> | null
    if (transport.mode === 'kube') {
      const backend = transport.backend
      const manifest = {
        apiVersion: `${AGENT_RUN_SPEC.group}/${AGENT_RUN_SPEC.version}`,
        kind: AGENT_RUN_SPEC.kind,
        metadata: {
          // Kubernetes adds five characters to generateName; controller labels require <=63.
          generateName: `${input.agentName.slice(0, 57)}-`,
          namespace,
          labels: {
            'agents.proompteng.ai/delivery-id': normalizeKubernetesLabelValue(input.idempotencyKey ?? randomUUID()),
          },
        },
        spec: buildAgentRunSpec(input),
      }
      resource = yield* kubeCall(() => backend.createCustomObject(AGENT_RUN_SPEC, namespace, manifest))
    } else {
      const entries = (values: Record<string, string> = {}) =>
        Object.entries(values).map(([key, value]) => ({ key, value }))
      const response = yield* grpcCall(() =>
        callUnary<{ resource_json: string }>(
          transport.client,
          'SubmitAgentRun',
          {
            namespace,
            agent_name: input.agentName,
            implementation_name: input.implName,
            runtime_type: input.runtimeType,
            runtime_config: entries(input.runtimeConfig),
            parameters: entries(input.parameters),
            idempotency_key: input.idempotencyKey,
            workload: { image: input.workloadImage, cpu: input.cpu, memory: input.memory },
            memory_ref: input.memoryRef,
            vcs_ref: input.vcsRef,
            vcs_policy_mode: input.vcsPolicyMode,
            vcs_policy_required: input.vcsPolicyRequired,
          },
          transport.metadata,
        ),
      )
      resource = parseJson(response.resource_json)
    }
    const name = readName(resource)
    if (!name || !resource)
      return yield* Effect.fail({
        _tag: transport.mode === 'kube' ? ('KubeError' as const) : ('GrpcError' as const),
        message: 'Submission returned no AgentRun name; check the namespace before retrying.',
      })
    if (expected || wait) console.error(`Submitted AgentRun ${namespace}/${name}.`)
    if (expected && transport.mode === 'kube') yield* verifyRun(transport.backend, namespace, name, expected)
    if (!wait) {
      outputResource(resource, output)
    } else if (transport.mode === 'kube') {
      yield* waitForRunCompletionKube(transport.backend, name, namespace, output)
    } else {
      yield* waitForRunCompletion(transport.client, transport.metadata, name, namespace, output)
    }
  })

const durationMs = (value: string, flag: string) => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value)
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
  const unit = match?.[2] ?? 's'
  const ms = match && Object.hasOwn(units, unit) ? Number(match[1]) * units[unit as keyof typeof units] : NaN
  if (!Number.isFinite(ms) || ms < 1 || ms > 2_147_483_647) {
    throw validationError(`${flag} expects a positive duration (seconds or ms/s/m/h, e.g. 30s).`)
  }
  return Math.floor(ms)
}

export const makeRunCommand = () => {
  const nameArg = Argument.String('name').pipe(Argument.withDescription('AgentRun name in the selected namespace.'))

  const submit = Command.make(
    'submit',
    {
      agent: textFlag('agent', 'Reference the Agent that will execute the task.'),
      impl: optionalText('impl', 'Reference an existing ImplementationSpec instead of an inline prompt.'),
      runtime: runtimeFlag,
      ...commonFlags,
    },
    ({ agent, impl, runtime, ...flags }) =>
      Effect.gen(function* () {
        const {
          resolved: { namespace, output },
        } = yield* AgentctlContext
        const transport = yield* TransportService
        const { implementationText, ...inputs } = yield* readInputs(flags, transport, get(impl))
        if (flags.verify && !isJobRuntime(runtime)) {
          return yield* Effect.fail(validationError('--verify requires the job or workflow runtime.'))
        }
        const implName = get(impl)
        if (!implementationText && !implName) {
          return yield* Effect.fail(validationError('Provide --impl, --inline-prompt, or --prompt-file.'))
        }
        const input: AgentRunParams = {
          agentName: agent,
          runtimeType: runtime,
          ...inputs,
          ...(implementationText !== undefined ? { implementationText } : { implName: implName ?? '' }),
        }
        const expected =
          flags.verify && transport.mode === 'kube'
            ? yield* readVerification(transport.backend, namespace, input)
            : undefined
        yield* submitRun(transport, namespace, output, input, flags.wait, expected)
      }),
  ).pipe(Command.withDescription('Submit an AgentRun from a referenced or inline task.'))

  const codex = Command.make(
    'codex',
    {
      prompt: optionalText(
        'prompt',
        'Ask local Codex to generate an ImplementationSpec from this task. Use --inline-prompt to submit verbatim.',
      ),
      agent: textFlag('agent', 'Agent to execute the task (default: codex-agent).').pipe(
        Flag.withDefault('codex-agent'),
      ),
      runtime: runtimeFlag.pipe(Flag.withDefault('workflow')),
      ...commonFlags,
    },
    ({ prompt, agent, runtime, ...flags }) =>
      Effect.gen(function* () {
        const {
          resolved: { namespace, output },
        } = yield* AgentctlContext
        const transport = yield* TransportService
        const { implementationText, ...inputs } = yield* readInputs(flags, transport, undefined, get(prompt))
        if (flags.verify && !isJobRuntime(runtime)) {
          return yield* Effect.fail(validationError('--verify requires the job or workflow runtime.'))
        }
        const base = { agentName: agent, runtimeType: runtime, ...inputs }
        if (implementationText !== undefined) {
          const input = { ...base, implementationText }
          const expected =
            flags.verify && transport.mode === 'kube'
              ? yield* readVerification(transport.backend, namespace, input)
              : undefined
          yield* submitRun(transport, namespace, output, input, flags.wait, expected)
          return
        }
        const task =
          get(prompt) ??
          (yield* Effect.tryPromise({
            try: () => promptText('Codex prompt'),
            catch: (error) => asAgentctlError(error, 'ValidationError'),
          }))
        const spec = yield* Effect.tryPromise({
          try: () => runCodex(task),
          catch: (error) => asAgentctlError(error, 'CodexError'),
        })
        const expected =
          flags.verify && transport.mode === 'kube'
            ? yield* readVerification(transport.backend, namespace, { ...base, implementationText: spec.text })
            : undefined
        const resourceSpec = RESOURCE_SPECS.impl
        const manifest = {
          apiVersion: `${resourceSpec.group}/${resourceSpec.version}`,
          kind: resourceSpec.kind,
          metadata: {
            namespace,
            ...(transport.mode === 'kube' ? { generateName: 'impl-' } : { name: `impl-${randomUUID().slice(0, 8)}` }),
          },
          spec,
        }
        const resource =
          transport.mode === 'kube'
            ? yield* kubeCall(() => transport.backend.createCustomObject(resourceSpec, namespace, manifest))
            : yield* grpcCall(async () =>
                parseJson(
                  (
                    await callUnary<{ json: string }>(
                      transport.client,
                      'ApplyImplementationSpec',
                      { namespace, manifest_yaml: YAML.stringify(manifest) },
                      transport.metadata,
                    )
                  ).json,
                ),
              )
        const implName = readName(resource)
        if (!implName)
          return yield* Effect.fail({ _tag: 'CodexError', message: 'ImplementationSpec creation returned no name.' })
        yield* submitRun(transport, namespace, output, { ...base, implName }, flags.wait, expected)
      }),
  ).pipe(Command.withDescription('Submit a Codex run from a literal prompt or a locally generated ImplementationSpec.'))

  const logs = Command.make(
    'logs',
    {
      name: nameArg,
      follow: bool('follow', 'Stream new log lines until the pod exits.').pipe(Flag.withAlias('f')),
      tail: Flag.optional(
        Flag.Int('tail').pipe(Flag.withDescription('Show the last N lines; -1 shows all (kube only).')),
      ),
      since: optionalText('since', 'Show logs newer than this duration, e.g. 10m (kube only).'),
      timestamps: bool('timestamps', 'Include a timestamp on each line (kube only).'),
      previous: bool('previous', 'Read logs from the previous container instance (kube only).'),
    },
    ({ name, follow, tail, since, timestamps, previous }) =>
      Effect.gen(function* () {
        const {
          resolved: { namespace },
        } = yield* AgentctlContext
        const transport = yield* TransportService
        if (Option.isSome(tail) && (!Number.isSafeInteger(tail.value) || tail.value < -1)) {
          return yield* Effect.fail(validationError('--tail must be -1 or a non-negative integer.'))
        }
        if (transport.mode === 'kube') {
          const backend = transport.backend
          const { pod } = yield* kubeCall((signal) => readRunObservation(backend, namespace, name, signal))
          if (!pod)
            return yield* Effect.fail({
              _tag: 'KubeError',
              message: `No Pod found for AgentRun ${name}; see agentctl describe run ${name}.`,
            })
          const container = runnerContainer(pod.spec)?.name ?? pod.spec?.containers?.[0]?.name
          yield* kubeCall((signal) =>
            backend.streamPodLogs(
              namespace,
              pod.metadata.name,
              { container, follow, tail: get(tail), since: get(since), timestamps, previous },
              signal,
            ),
          )
          return
        }
        if (Option.isSome(tail) || Option.isSome(since) || timestamps || previous) {
          return yield* Effect.fail(
            validationError('--tail, --since, --timestamps, and --previous require Kubernetes mode.'),
          )
        }
        yield* grpcCall(
          (signal) =>
            new Promise<void>((resolve, reject) => {
              const stream = (
                transport.client as unknown as Record<
                  string,
                  (...args: unknown[]) => grpc.ClientReadableStream<{ stream?: string; message?: string }>
                >
              ).StreamAgentRunLogs
              if (!stream) return reject(new Error('StreamAgentRunLogs not available'))
              const call = stream.call(transport.client, { name, namespace, follow }, transport.metadata)
              const onAbort = () => call.cancel()
              signal.addEventListener('abort', onAbort, { once: true })
              call.once('status', () => signal.removeEventListener('abort', onAbort))
              call.on('data', (entry) =>
                (entry.stream === 'stderr' ? process.stderr : process.stdout).write(entry.message ?? ''),
              )
              call.on('end', resolve)
              call.on('error', reject)
            }),
        )
      }),
  ).pipe(Command.withDescription('Read logs from the run’s current runner Pod.'))

  const wait = Command.make(
    'wait',
    {
      name: nameArg,
      timeout: optionalText('timeout', 'Stop waiting after this duration (default: 2h).'),
      interval: optionalText('interval', 'Poll Kubernetes at this interval (default: 2s).'),
    },
    ({ name, timeout, interval }) =>
      Effect.gen(function* () {
        const {
          resolved: { namespace, output },
        } = yield* AgentctlContext
        const transport = yield* TransportService
        const durations = yield* Effect.try({
          try: () => ({
            timeout: Option.isSome(timeout) ? durationMs(timeout.value, '--timeout') : DEFAULT_RUN_TIMEOUT_MS,
            interval: Option.isSome(interval) ? durationMs(interval.value, '--interval') : DEFAULT_RUN_INTERVAL_MS,
          }),
          catch: (error) => asAgentctlError(error, 'ValidationError'),
        })
        if (transport.mode === 'kube') {
          yield* waitForRunCompletionKube(
            transport.backend,
            name,
            namespace,
            output,
            durations.timeout,
            durations.interval,
          )
        } else {
          if (Option.isSome(interval))
            return yield* Effect.fail(validationError('--interval requires Kubernetes mode; gRPC streams status.'))
          yield* waitForRunCompletion(transport.client, transport.metadata, name, namespace, output, durations.timeout)
        }
      }),
  ).pipe(Command.withDescription('Wait for a terminal run phase, checking Jobs and Pods when the CR lags.'))

  const cancel = Command.make('cancel', { name: nameArg }, ({ name }) =>
    Effect.gen(function* () {
      const {
        resolved: { namespace },
      } = yield* AgentctlContext
      const transport = yield* TransportService
      if (transport.mode === 'kube') {
        const backend = transport.backend
        const observation = yield* kubeCall((signal) => readRunObservation(backend, namespace, name, signal))
        if (!isJobRuntime(runtimeType(observation.run))) {
          return yield* Effect.fail({
            _tag: 'KubeError',
            message: 'No cancellable Job runtime found for this AgentRun.',
          })
        }
        const liveJobs = observation.jobs.filter((job) => !jobTerminalPhase(job) && !job.metadata.deletionTimestamp)
        if (!liveJobs.length) {
          if (
            isTerminalPhase(observation.phase) ||
            isTerminalPhase(observation.observedPhase) ||
            observation.jobs.some((job) => job.metadata.deletionTimestamp)
          ) {
            console.log(`AgentRun ${name}: no live Jobs to cancel.`)
            return
          }
          return yield* Effect.fail({
            _tag: 'KubeError',
            message: `AgentRun ${name} has no live Job to cancel; the run itself was not cancelled.`,
          })
        }
        if (liveJobs.some((job) => !hasRunUid(job, observation.run))) {
          return yield* Effect.fail({
            _tag: 'KubeError',
            message: `Refusing to delete Jobs without matching AgentRun UID evidence for ${name}.`,
          })
        }
        yield* kubeCall(() =>
          backend.deleteJobs(
            namespace,
            liveJobs.map((job) => job.metadata.name),
          ),
        )
        console.log(
          `Requested cancellation of ${liveJobs.length} Job(s) for AgentRun ${name}; check run status for the outcome.`,
        )
        return
      }
      const response = yield* grpcCall(() =>
        callUnary<{ ok: boolean; message?: string }>(
          transport.client,
          'CancelAgentRun',
          { name, namespace },
          transport.metadata,
        ),
      )
      if (!response.ok)
        return yield* Effect.fail({
          _tag: 'GrpcError',
          message: response.message || 'AgentRun cancellation was not accepted.',
        })
      console.log(response.message ?? 'cancelled')
    }),
  ).pipe(Command.withDescription('Request cancellation of live Jobs without deleting the AgentRun.'))

  return Command.make('run').pipe(
    Command.withDescription('Submit, list, and operate AgentRuns.'),
    Command.withSubcommands([submit, codex, makeRunListCommand(), logs, wait, cancel]),
  )
}
