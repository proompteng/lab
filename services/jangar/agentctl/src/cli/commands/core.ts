import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Args, CliConfig, Command, HelpDoc, Options } from '@effect/cli'
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
} from '../../legacy'
import { TransportService } from '../../transport'
import { AgentctlContext } from '../context'
import { asAgentctlError } from '../errors'
import { renderExamples } from '../examples'
import { renderGlobalFlags, renderShortHelp, renderTopicHelp } from '../help'

const formatConfig = (config: Record<string, unknown>) => JSON.stringify(config, null, 2)

export const makeHelpCommand = (getRoot: () => Command.Command<unknown, unknown, unknown, unknown>) => {
  const topicArg = Args.optional(Args.text({ name: 'topic' }))
  return Command.make('help', { topic: topicArg }, ({ topic }) =>
    Effect.sync(() => {
      const value = Option.getOrUndefined(topic) ?? ''
      if (value.toLowerCase() === 'all') {
        const helpDoc = Command.getHelp(getRoot(), CliConfig.defaultConfig)
        console.log(HelpDoc.toAnsiText(helpDoc))
        console.log(renderGlobalFlags())
        return
      }
      const topicHelp = renderTopicHelp(value)
      if (topicHelp) {
        console.log(topicHelp)
        return
      }
      console.log(renderShortHelp(getVersion()))
    }),
  )
}

export const makeExamplesCommand = () => {
  const topicArg = Args.optional(Args.text({ name: 'topic' }))
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
        `Quickstart (kube mode default):\n  agentctl status\n  agentctl agent list\n  agentctl impl init --apply\n  agentctl run init --apply --wait\n\nOptional gRPC:\n  kubectl -n agents port-forward svc/agents-grpc 50051:50051\n  agentctl --grpc --server 127.0.0.1:50051 status\n`,
      )
    }),
  )

export const makeCompletionCommand = (getRoot: () => Command.Command<unknown, unknown, unknown, unknown>) => {
  const shellArg = Args.text({ name: 'shell' })

  const printCompletion = Command.make('completion', { shell: shellArg }, ({ shell }) =>
    Effect.gen(function* () {
      const command = getRoot()
      const normalized = shell.trim().toLowerCase()
      if (normalized === 'bash') {
        const lines = yield* Command.getBashCompletions(command, 'agentctl')
        console.log(lines.join('\n'))
        return
      }
      if (normalized === 'zsh') {
        const lines = yield* Command.getZshCompletions(command, 'agentctl')
        console.log(lines.join('\n'))
        return
      }
      if (normalized === 'fish') {
        const lines = yield* Command.getFishCompletions(command, 'agentctl')
        console.log(lines.join('\n'))
        return
      }
      throw new Error(`Unsupported shell: ${shell}`)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, 'ValidationError'))),
  )

  const install = Command.make('install', { shell: shellArg }, ({ shell }) =>
    Effect.gen(function* () {
      const command = getRoot()
      const normalized = shell.trim().toLowerCase()
      let lines: string[] = []
      if (normalized === 'bash') {
        lines = yield* Command.getBashCompletions(command, 'agentctl')
      } else if (normalized === 'zsh') {
        lines = yield* Command.getZshCompletions(command, 'agentctl')
      } else if (normalized === 'fish') {
        lines = yield* Command.getFishCompletions(command, 'agentctl')
      } else {
        throw new Error(`Unsupported shell: ${shell}`)
      }
      const base = process.env.XDG_CONFIG_HOME?.trim() || `${process.env.HOME}/.config`
      const filePath = `${base}/agentctl/completions/agentctl.${normalized}`
      yield* Effect.promise(() => mkdir(dirname(filePath), { recursive: true }))
      yield* Effect.promise(() => writeFile(filePath, `${lines.join('\n')}\n`, 'utf8'))
      console.log(`Wrote ${filePath}`)
      if (normalized === 'fish') {
        console.log(`Run: set -U fish_complete_path $fish_complete_path ${base}/agentctl/completions`)
      } else if (normalized === 'zsh') {
        console.log(`Add to ~/.zshrc: source ${filePath}`)
      } else {
        console.log(`Add to ~/.bashrc: source ${filePath}`)
      }
    }).pipe(Effect.mapError((error) => asAgentctlError(error, 'IoError'))),
  )

  return Command.withSubcommands(printCompletion, [install])
}

export const makeConfigCommand = () => {
  const showSecrets = Options.boolean('show-secrets')
  const view = Command.make('view', { showSecrets }, ({ showSecrets }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(() => loadConfig())
      if (!showSecrets && config.token) {
        config.token = maskSecret(config.token)
      }
      console.log(formatConfig(config))
    }).pipe(Effect.mapError((error) => asAgentctlError(error, 'IoError'))),
  )

  const namespace = Options.optional(Options.text('namespace'))
  const server = Options.optional(Options.text('server'))
  const address = Options.optional(Options.text('address'))
  const token = Options.optional(Options.text('token'))
  const kubeconfig = Options.optional(Options.text('kubeconfig'))
  const context = Options.optional(Options.text('context'))
  const tls = Options.boolean('tls', { negationNames: ['no-tls'] })

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

  return Command.make('config').pipe(Command.withSubcommands([view, set]))
}

export const makeVersionCommand = () =>
  Command.make(
    'version',
    { clientOnly: Options.boolean('client').pipe(Options.withAlias('client-only')) },
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
          const clients = transport.clients
          console.log(`agentctl ${version}`)
          try {
            const response = yield* Effect.promise(() =>
              clients.apps.listNamespacedDeployment({
                namespace: resolved.namespace || DEFAULT_NAMESPACE,
                labelSelector: 'app.kubernetes.io/name=agents',
              }),
            )
            const body = 'body' in response ? response.body : (response as { body?: unknown }).body
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
        yield* Effect.promise(() => outputStatusKube(transport.clients, resolved.namespace, output))
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
