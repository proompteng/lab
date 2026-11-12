import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Argument, CliError, Command, Completions, Flag } from 'effect/cli'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { loadConfig, resolveConfigPath, saveConfig } from '../../config'
import {
  DEFAULT_NAMESPACE,
  getVersion,
  maskSecret,
  outputStatus,
  outputStatusKube,
  readNestedValue,
} from '../../runtime'
import { TransportService } from '../../transport'
import { AgentctlContext } from '../context'
import { asAgentctlError } from '../errors'
import { renderExamples } from '../examples'
import { renderShortHelp, renderTopicHelp } from '../help'
import { promptConfirm, promptText } from '../prompt'

const formatConfig = (config: Record<string, unknown>) => JSON.stringify(config, null, 2)

export const makeHelpCommand = () => {
  const topicArg = Argument.optional(Argument.String('topic'))
  return Command.make('help', { topic: topicArg }, ({ topic }) =>
    Effect.gen(function* () {
      const value = Option.getOrUndefined(topic) ?? ''
      if (value.toLowerCase() === 'all') {
        return yield* new CliError.ShowHelp({ commandPath: ['agentctl'], errors: [] })
      }
      const topicHelp = renderTopicHelp(value)
      console.log(topicHelp ?? renderShortHelp(getVersion()))
    }),
  )
}

export const makeExamplesCommand = () => {
  const topicArg = Argument.optional(Argument.String('topic'))
  return Command.make('examples', { topic: topicArg }, ({ topic }) =>
    Effect.sync(() => {
      console.log(renderExamples(Option.getOrUndefined(topic)))
    }),
  )
}

export const makeQuickstartCommand = () =>
  Command.make('quickstart', {}, () =>
    Effect.sync(() => {
      console.log(
        `Quickstart (kube mode default):\n  agentctl status\n  agentctl get agent\n  agentctl init impl --apply\n  agentctl run submit --agent <name> --impl <name> --runtime workflow --wait\n\nOptional gRPC:\n  kubectl -n agents port-forward svc/agents-grpc 50051:50051\n  agentctl --grpc --server 127.0.0.1:50051 status\n`,
      )
    }),
  )

export const makeCompletionCommand = (getRoot: () => Command.Command.Any) => {
  const shellArg = Argument.String('shell')
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
  )

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
  )

  return Command.withSubcommands(printCompletion, [install])
}

export const makeConfigCommand = () => {
  const showSecrets = Flag.Boolean('show-secrets').pipe(Flag.withDefault(false))
  const view = Command.make('view', { showSecrets }, ({ showSecrets }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(() => loadConfig())
      if (!showSecrets && config.token) {
        config.token = maskSecret(config.token)
      }
      console.log(formatConfig(config))
    }).pipe(Effect.mapError((error) => asAgentctlError(error, 'IoError'))),
  )

  const namespace = Flag.optional(Flag.String('namespace'))
  const server = Flag.optional(Flag.String('server'))
  const address = Flag.optional(Flag.String('address'))
  const token = Flag.optional(Flag.String('token'))
  const kubeconfig = Flag.optional(Flag.String('kubeconfig'))
  const context = Flag.optional(Flag.String('context'))
  const tls = Flag.Boolean('tls').pipe(Flag.withDefault(false))

  const set = Command.make(
    'set',
    { namespace, server, address, token, kubeconfig, context, tls },
    ({ namespace, server, address, token, kubeconfig, context }) =>
      Effect.gen(function* () {
        const config = yield* Effect.promise(() => loadConfig())
        const next = { ...config }

        if (Option.isSome(namespace)) next.namespace = namespace.value
        if (Option.isSome(server)) next.address = server.value
        if (Option.isSome(address)) next.address = address.value
        if (Option.isSome(token)) next.token = token.value
        if (Option.isSome(kubeconfig)) next.kubeconfig = kubeconfig.value
        if (Option.isSome(context)) next.context = context.value

        const argv = process.argv.slice(2)
        if (argv.includes('--tls')) next.tls = true
        if (argv.includes('--no-tls')) next.tls = false

        if (
          !next.namespace &&
          !next.address &&
          !next.token &&
          !next.kubeconfig &&
          !next.context &&
          next.tls === undefined
        ) {
          throw new Error(
            'config set requires at least one of --namespace, --server, --token, --kubeconfig, --context, or --tls/--no-tls',
          )
        }

        yield* Effect.promise(() => saveConfig(next))
        console.log(`Updated ${resolveConfigPath()}`)
      }).pipe(Effect.mapError((error) => asAgentctlError(error, 'IoError'))),
  )

  const init = Command.make(
    'init',
    { namespace, server, address, token, kubeconfig, context, tls },
    ({ namespace, server, address, token, kubeconfig, context }) =>
      Effect.gen(function* () {
        const config = yield* Effect.promise(() => loadConfig())
        const resolvedNamespace = Option.isSome(namespace)
          ? namespace.value
          : yield* Effect.tryPromise({
              try: () => promptText('Namespace', { defaultValue: config.namespace ?? DEFAULT_NAMESPACE }),
              catch: (error) => asAgentctlError(error, 'ValidationError'),
            })
        const resolvedKubeconfig = Option.isSome(kubeconfig)
          ? kubeconfig.value
          : yield* Effect.tryPromise({
              try: () => promptText('Kubeconfig path (optional)', { allowEmpty: true }),
              catch: (error) => asAgentctlError(error, 'ValidationError'),
            })
        const resolvedContext = Option.isSome(context)
          ? context.value
          : yield* Effect.tryPromise({
              try: () => promptText('Kube context (optional)', { allowEmpty: true }),
              catch: (error) => asAgentctlError(error, 'ValidationError'),
            })
        const argv = process.argv.slice(2)
        const hasGrpcFlags =
          Option.isSome(server) ||
          Option.isSome(address) ||
          Option.isSome(token) ||
          argv.includes('--tls') ||
          argv.includes('--no-tls')
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
          resolvedAddress = Option.isSome(server)
            ? server.value
            : Option.isSome(address)
              ? address.value
              : yield* Effect.tryPromise({
                  try: () => promptText('gRPC address', { defaultValue: config.address ?? '127.0.0.1:50051' }),
                  catch: (error) => asAgentctlError(error, 'ValidationError'),
                })
          resolvedToken = Option.isSome(token)
            ? token.value
            : yield* Effect.tryPromise({
                try: () => promptText('Token (optional)', { allowEmpty: true }),
                catch: (error) => asAgentctlError(error, 'ValidationError'),
              })
          if (argv.includes('--tls')) resolvedTls = true
          if (argv.includes('--no-tls')) resolvedTls = false
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
  )

  return Command.make('config').pipe(Command.withSubcommands([view, set, init]))
}

export const makeVersionCommand = () =>
  Command.make(
    'version',
    { clientOnly: Flag.Boolean('client').pipe(Flag.withDefault(false)).pipe(Flag.withAlias('client-only')) },
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
          try {
            const body = yield* Effect.promise(() =>
              backend.listDeployments(resolved.namespace || DEFAULT_NAMESPACE, 'app.kubernetes.io/name=agents'),
            )
            const items = Array.isArray((body as { items?: unknown[] } | undefined)?.items)
              ? ((body as { items?: unknown[] }).items as Record<string, unknown>[])
              : []
            const deployment = items[0] ?? null
            const image = deployment
              ? readNestedValue(deployment, ['spec', 'template', 'spec', 'containers', 0, 'image'])
              : null
            if (typeof image === 'string' && image) {
              console.log(`server image ${image}`)
            } else {
              console.log('server info unavailable (kube mode)')
            }
          } catch {
            console.log('server info unavailable (kube mode)')
          }
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
  )

const makeStatusLikeCommand = (name: 'status' | 'diagnose') =>
  Command.make(name, {}, () =>
    Effect.gen(function* () {
      const { resolved } = yield* AgentctlContext
      const transport = yield* TransportService
      const output = resolved.output
      if (transport.mode === 'kube') {
        yield* Effect.promise(() => outputStatusKube(transport.backend, resolved.namespace, output))
        return
      }
      const response = yield* Effect.promise(
        () =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const fn = (transport.client as unknown as Record<string, (...args: unknown[]) => void>)
              .GetControlPlaneStatus
            fn.call(
              transport.client,
              { namespace: resolved.namespace },
              transport.metadata,
              (error: unknown, data: Record<string, unknown>) => {
                if (error) reject(error)
                else resolve(data)
              },
            )
          }),
      )
      outputStatus(response as never, output, resolved.namespace)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, transportErrorTag(error)))),
  )

export const makeStatusCommand = () => makeStatusLikeCommand('status')

export const makeDiagnoseCommand = () => makeStatusLikeCommand('diagnose')

const transportErrorTag = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error) return 'GrpcError'
  return 'KubeError'
}
