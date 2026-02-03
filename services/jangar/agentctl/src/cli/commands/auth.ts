import { Command, Options } from '@effect/cli'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { loadConfig, resolveConfigPath, saveConfig } from '../../config'
import { maskSecret } from '../../legacy'
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
  const token = Options.optional(Options.text('token'))
  const withToken = Options.boolean('with-token')
  return Command.make('login', { token, withToken }, ({ token, withToken }) =>
    Effect.gen(function* () {
      if (withToken && Option.isSome(token)) {
        throw new Error('Use either --token or --with-token, not both.')
      }
      let resolvedToken = Option.isSome(token) ? token.value : ''
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
  )
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
  )

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
  )

export const makeAuthCommand = () => {
  const base = Command.make('auth', {}, () =>
    Effect.sync(() => {
      console.log('Usage: agentctl auth <login|status|logout>')
    }),
  )
  return Command.withSubcommands(base, [makeLoginCommand(), makeStatusCommand(), makeLogoutCommand()])
}
