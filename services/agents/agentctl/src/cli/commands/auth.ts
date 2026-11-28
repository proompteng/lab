import { Command, Flag } from 'effect/cli'
import * as Effect from 'effect/Effect'
import { loadConfig, resolveConfigPath, saveConfig } from '../../config'
import { maskSecret } from '../../runtime'
import { AgentctlContext } from '../context'
import { asAgentctlError } from '../errors'
import { promptText } from '../prompt'

const readStdin = async () =>
  new Promise<string>((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data.trim()))
    process.stdin.on('error', (error) => reject(error))
  })

const makeLoginCommand = () => {
  const withToken = Flag.Boolean('with-token').pipe(
    Flag.withDefault(false),
    Flag.withDescription('Read the gRPC token from stdin.'),
  )
  return Command.make('login', { withToken }, ({ withToken }) =>
    Effect.gen(function* () {
      const { flags } = yield* AgentctlContext
      if (withToken && flags.token) {
        return yield* Effect.fail(asAgentctlError('Use either --token or --with-token, not both.', 'ValidationError'))
      }
      let resolvedToken = flags.token ?? ''
      if (withToken) {
        resolvedToken = (yield* Effect.tryPromise({
          try: () => readStdin(),
          catch: (error) => asAgentctlError(error, 'IoError'),
        })).trim()
      }
      if (!resolvedToken) {
        resolvedToken = yield* Effect.tryPromise({
          try: () => promptText('Token'),
          catch: (error) => asAgentctlError(error, 'ValidationError'),
        })
      }
      if (!resolvedToken) {
        throw new Error('Token is required')
      }
      const config = yield* Effect.tryPromise({
        try: () => loadConfig(),
        catch: (error) => asAgentctlError(error, 'IoError'),
      })
      yield* Effect.tryPromise({
        try: () => saveConfig({ ...config, token: resolvedToken }),
        catch: (error) => asAgentctlError(error, 'IoError'),
      })
      console.log(`Saved token to ${resolveConfigPath()}`)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, 'IoError'))),
  ).pipe(Command.withDescription('Save a gRPC token in the local config.'))
}

const makeStatusCommand = () =>
  Command.make('status', {}, () =>
    Effect.gen(function* () {
      const config = yield* Effect.tryPromise({
        try: () => loadConfig(),
        catch: (error) => asAgentctlError(error, 'IoError'),
      })
      if (!config.token) {
        console.log('No token configured.')
        return
      }
      console.log(`Token: ${maskSecret(config.token)}`)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, 'IoError'))),
  ).pipe(Command.withDescription('Show whether a gRPC token is configured.'))

const makeLogoutCommand = () =>
  Command.make('logout', {}, () =>
    Effect.gen(function* () {
      const config = yield* Effect.tryPromise({
        try: () => loadConfig(),
        catch: (error) => asAgentctlError(error, 'IoError'),
      })
      if (!config.token) {
        console.log('No token configured.')
        return
      }
      const next = { ...config }
      delete next.token
      yield* Effect.tryPromise({
        try: () => saveConfig(next),
        catch: (error) => asAgentctlError(error, 'IoError'),
      })
      console.log(`Removed token from ${resolveConfigPath()}`)
    }).pipe(Effect.mapError((error) => asAgentctlError(error, 'IoError'))),
  ).pipe(Command.withDescription('Remove the local gRPC token without revoking it on the server.'))

export const makeAuthCommand = () => {
  const base = Command.make('auth', {}, () =>
    Effect.sync(() => {
      console.log('Usage: agentctl auth <login|status|logout>')
    }),
  ).pipe(Command.withDescription('Manage local gRPC credentials.'))
  return Command.withSubcommands(base, [makeLoginCommand(), makeStatusCommand(), makeLogoutCommand()])
}
