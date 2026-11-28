import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Argument, CliError, Command, Completions, Flag } from 'effect/cli'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { outputFleet, outputKubeHealth } from '../../kube/fleet'
import { loadConfig, resolveConfigPath, saveConfig } from '../../config'
import { callUnary, DEFAULT_NAMESPACE, getVersion, maskSecret, outputStatus } from '../../runtime'
import { TransportService } from '../../transport'
import { AgentctlContext } from '../context'
import { asAgentctlError, validationError } from '../errors'
import { kubeCall } from '../run-observation'
import { renderExamples } from '../examples'
import { renderShortHelp, renderTopicHelp } from '../help'
import { promptConfirm, promptText } from '../prompt'

const formatConfig = (config: Record<string, unknown>) => JSON.stringify(config, null, 2)

export const makeHelpCommand = () => {
  const topicArg = Argument.optional(Argument.String('topic').pipe(Argument.withDescription('Choose a command topic.')))
  return Command.make('help', { topic: topicArg }, ({ topic }) =>
    Effect.gen(function* () {
      const value = Option.getOrUndefined(topic) ?? ''
      if (value.toLowerCase() === 'all') {
        return yield* new CliError.ShowHelp({ commandPath: ['agentctl'], errors: [] })
      }
      const topicHelp = renderTopicHelp(value)
      console.log(topicHelp ?? renderShortHelp(getVersion()))
    }),
  ).pipe(Command.withDescription('Show help for a command topic, or use help all for the full command list.'))
}

export const makeExamplesCommand = () => {
  const topicArg = Argument.optional(Argument.String('topic').pipe(Argument.withDescription('Choose a command topic.')))
  return Command.make('examples', { topic: topicArg }, ({ topic }) =>
    Effect.sync(() => {
      console.log(renderExamples(Option.getOrUndefined(topic)))
    }),
  ).pipe(Command.withDescription('Print example invocations by topic.'))
}

export const makeQuickstartCommand = () =>
  Command.make('quickstart', {}, () =>
    Effect.sync(() => {
      console.log(
        `Quickstart (kube mode default):\n  agentctl status\n  agentctl get agent\n  agentctl init impl --apply\n  agentctl run submit --agent <name> --impl <name> --runtime workflow --wait\n\nOptional gRPC:\n  kubectl -n agents port-forward svc/agents-grpc 50051:50051\n  agentctl --grpc --server 127.0.0.1:50051 status\n`,
      )
    }),
  ).pipe(Command.withDescription('Show the shortest path to your first AgentRun.'))

export const makeCompletionCommand = (getRoot: () => Command.Command.Any) => {
  const shellArg = Argument.String('shell').pipe(Argument.withDescription('Shell name: bash, zsh, or fish.'))
  const generateCompletion = (shell: string) => {
    const normalized = shell.trim().toLowerCase()
    if (normalized !== 'bash' && normalized !== 'zsh' && normalized !== 'fish') {
      throw new Error(`Unsupported shell: ${shell}`)
    }
    return {
      shell: normalized,
      script: Completions.generate('agentctl', normalized, Completions.fromCommand(getRoot())),
    }
  }

  const printCompletion = Command.make('completion', { shell: shellArg }, ({ shell }) =>
    Effect.try({
      try: () => generateCompletion(shell),
      catch: (error) => asAgentctlError(error, 'ValidationError'),
    }).pipe(Effect.tap(({ script }) => Effect.sync(() => console.log(script)))),
  ).pipe(Command.withDescription('Print a shell completion script.'))

  const install = Command.make('install', { shell: shellArg }, ({ shell }) =>
    Effect.gen(function* () {
      const { shell: normalized, script } = yield* Effect.try({
        try: () => generateCompletion(shell),
        catch: (error) => asAgentctlError(error, 'ValidationError'),
      })
      const base = process.env.XDG_CONFIG_HOME?.trim() || `${process.env.HOME}/.config`
      const filePath = `${base}/agentctl/completions/agentctl.${normalized}`
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(filePath), { recursive: true })
          await writeFile(filePath, `${script}\n`, 'utf8')
        },
        catch: (error) => asAgentctlError(error, 'IoError'),
      })
      console.log(`Wrote ${filePath}`)
      if (normalized === 'fish') {
        console.log(`Run: set -U fish_complete_path $fish_complete_path ${base}/agentctl/completions`)
      } else if (normalized === 'zsh') {
        console.log(`Add to ~/.zshrc: source ${filePath}`)
      } else {
        console.log(`Add to ~/.bashrc: source ${filePath}`)
      }
    }),
  ).pipe(Command.withDescription('Install a shell completion script in the agentctl config directory.'))

  return Command.withSubcommands(printCompletion, [install])
}

export const makeConfigCommand = () => {
  const showSecrets = Flag.Boolean('show-secrets').pipe(
    Flag.withDefault(false),
    Flag.withDescription('Include the configured token instead of masking it.'),
  )
  const view = Command.make('view', { showSecrets }, ({ showSecrets }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(() => loadConfig())
      if (!showSecrets && config.token) {
        config.token = maskSecret(config.token)
      }
      console.log(formatConfig(config))
    }).pipe(Effect.mapError((error) => asAgentctlError(error, 'IoError'))),
  ).pipe(Command.withDescription('Print the local config with the token masked by default.'))

  const set = Command.make('set', {}, () =>
    Effect.gen(function* () {
      const { config, flags } = yield* AgentctlContext
      const { namespace, address, token, kubeconfig, context, tls } = flags
      const changes = {
        ...(namespace !== undefined ? { namespace } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(token !== undefined ? { token } : {}),
        ...(kubeconfig !== undefined ? { kubeconfig } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(tls !== undefined ? { tls } : {}),
      }
      if (!Object.keys(changes).length) {
        return yield* Effect.fail(
          validationError(
            'config set requires at least one of --namespace, --server, --token, --kubeconfig, --context, or --tls/--no-tls.',
          ),
        )
      }
      yield* Effect.tryPromise({
        try: () => saveConfig({ ...config, ...changes }),
        catch: (error) => asAgentctlError(error, 'IoError'),
      })
      console.log(`Updated ${resolveConfigPath()}`)
    }),
  ).pipe(Command.withDescription('Save selected global settings without prompting.'))

  const init = Command.make('init', {}, () =>
    Effect.gen(function* () {
      const {
        config,
        flags: { namespace, address, token, kubeconfig, context, tls },
      } = yield* AgentctlContext
      const resolvedNamespace =
        namespace !== undefined
          ? namespace
          : yield* Effect.tryPromise({
              try: () => promptText('Namespace', { defaultValue: config.namespace ?? DEFAULT_NAMESPACE }),
              catch: (error) => asAgentctlError(error, 'ValidationError'),
            })
      const resolvedKubeconfig =
        kubeconfig !== undefined
          ? kubeconfig
          : yield* Effect.tryPromise({
              try: () => promptText('Kubeconfig path (optional)', { allowEmpty: true }),
              catch: (error) => asAgentctlError(error, 'ValidationError'),
            })
      const resolvedContext =
        context !== undefined
          ? context
          : yield* Effect.tryPromise({
              try: () => promptText('Kube context (optional)', { allowEmpty: true }),
              catch: (error) => asAgentctlError(error, 'ValidationError'),
            })
      const hasGrpcFlags = address !== undefined || token !== undefined || tls !== undefined
      const wantsGrpc = hasGrpcFlags
        ? true
        : yield* Effect.tryPromise({
            try: () => promptConfirm('Configure gRPC access?', false),
            catch: (error) => asAgentctlError(error, 'ValidationError'),
          })
      let resolvedAddress = config.address
      let resolvedToken = config.token
      let resolvedTls = config.tls
      if (wantsGrpc) {
        resolvedAddress =
          address ??
          (yield* Effect.tryPromise({
            try: () => promptText('gRPC address', { defaultValue: config.address ?? '127.0.0.1:50051' }),
            catch: (error) => asAgentctlError(error, 'ValidationError'),
          }))
        resolvedToken =
          token !== undefined
            ? token
            : yield* Effect.tryPromise({
                try: () => promptText('Token (optional)', { allowEmpty: true }),
                catch: (error) => asAgentctlError(error, 'ValidationError'),
              })
        resolvedTls = tls ?? resolvedTls
        if (resolvedTls === undefined) {
          resolvedTls = yield* Effect.tryPromise({
            try: () => promptConfirm('Enable TLS?', false),
            catch: (error) => asAgentctlError(error, 'ValidationError'),
          })
        }
      }

      const next = {
        ...config,
        namespace: resolvedNamespace,
        ...(resolvedAddress ? { address: resolvedAddress } : {}),
        ...(resolvedToken ? { token: resolvedToken } : {}),
        ...(resolvedTls !== undefined ? { tls: resolvedTls } : {}),
        ...(resolvedKubeconfig ? { kubeconfig: resolvedKubeconfig } : {}),
        ...(resolvedContext ? { context: resolvedContext } : {}),
      }
      yield* Effect.promise(() => saveConfig(next))
      console.log(`Updated ${resolveConfigPath()}`)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, 'IoError'))),
  ).pipe(Command.withDescription('Configure namespace, Kubernetes context, and optional gRPC access.'))

  return Command.make('config').pipe(
    Command.withDescription('Inspect or update local agentctl configuration.'),
    Command.withSubcommands([view, set, init]),
  )
}

export const makeVersionCommand = () =>
  Command.make(
    'version',
    {
      clientOnly: Flag.Boolean('client').pipe(
        Flag.withDefault(false),
        Flag.withAlias('client-only'),
        Flag.withDescription('Show the client version without contacting the server.'),
      ),
    },
    ({ clientOnly }) =>
      Effect.gen(function* () {
        const { resolved } = yield* AgentctlContext
        const transport = yield* TransportService
        const version = getVersion()
        if (clientOnly) {
          console.log(`agentctl ${version}`)
          return
        }
        if (transport.mode === 'kube') {
          const backend = transport.backend
          console.log(`agentctl ${version}`)
          const deployments = yield* kubeCall(() =>
            backend.listDeployments(resolved.namespace, 'app.kubernetes.io/name=agents'),
          ).pipe(Effect.catch(() => Effect.succeed([])))
          const image = deployments.find((deployment) => deployment.metadata.name === 'agents')?.spec?.template?.spec
            ?.containers?.[0]?.image
          console.log(image ? `server image ${image}` : 'server info unavailable (kube mode)')
          return
        }

        const { metadata, client } = transport
        console.log(`agentctl ${version}`)
        const response = yield* Effect.promise(
          () =>
            new Promise<{ version: string; build_sha?: string; build_time?: string }>((resolve, reject) => {
              const fn = (client as unknown as Record<string, (...args: unknown[]) => void>).GetServerInfo
              fn.call(
                client,
                {},
                metadata,
                (error: unknown, data: { version: string; build_sha?: string; build_time?: string }) => {
                  if (error) reject(error)
                  else resolve(data)
                },
              )
            }),
        )
        console.log(`server ${response.version}`)
        if (response.build_sha) {
          console.log(`build ${response.build_sha}${response.build_time ? ` (${response.build_time})` : ''}`)
        }
      }).pipe(Effect.mapError((error) => asAgentctlError(error, 'GrpcError'))),
  ).pipe(Command.withDescription('Show client and server versions.'))

const makeStatusLikeCommand = (name: 'status' | 'diagnose', description: string) =>
  Command.make(name, {}, () =>
    Effect.gen(function* () {
      const {
        resolved: { namespace, output },
      } = yield* AgentctlContext
      const transport = yield* TransportService
      if (transport.mode === 'kube') {
        yield* kubeCall(() => outputKubeHealth(transport.backend, namespace, output, name === 'diagnose'))
        return
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          callUnary<Parameters<typeof outputStatus>[0]>(
            transport.client,
            'GetControlPlaneStatus',
            { namespace },
            transport.metadata,
          ),
        catch: (error) => asAgentctlError(error, 'GrpcError'),
      })
      outputStatus(response, output, namespace)
    }),
  ).pipe(Command.withDescription(description))

export const makeStatusCommand = () =>
  makeStatusLikeCommand('status', 'Show control-plane health and AgentRun fleet activity.')

export const makeDiagnoseCommand = () =>
  makeStatusLikeCommand('diagnose', 'Show health and suggest actions for Kubernetes fleet problems.')

export const makeFleetCommand = () =>
  Command.make('fleet', {}, () =>
    Effect.gen(function* () {
      const {
        resolved: { namespace, output },
      } = yield* AgentctlContext
      const transport = yield* TransportService
      if (transport.mode !== 'kube') return yield* Effect.fail(validationError('fleet requires Kubernetes mode.'))
      yield* kubeCall(() => outputFleet(transport.backend, namespace, output))
    }),
  ).pipe(
    Command.withAlias('capacity'),
    Command.withDescription('Show AgentRun activity, node capacity, and controller limits (kube only).'),
  )
