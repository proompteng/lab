import { createImplementationContractTools } from '../../../src/server/agents-controller/implementation-contract'
import { validationError } from './errors'

export const { buildEventContext } = createImplementationContractTools((params, keys) => {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
})

export const parseRunValues = (values: readonly string[], flag: string) =>
  Object.fromEntries(
    values.map((value) => {
      const eq = value.indexOf('=')
      const key = value.slice(0, eq < 0 ? undefined : eq).trim()
      if (flag === '--param' && key.toLowerCase() === 'prompt') {
        throw validationError(
          '--param prompt=... is not supported. Use --impl, --inline-prompt, or --prompt-file for the task.',
        )
      }
      if (!key || eq < 0) throw validationError(`${flag} expects key=value.`)
      return [key, value.slice(eq + 1)]
    }),
  )
