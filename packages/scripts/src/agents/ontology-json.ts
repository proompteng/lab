import { format } from 'oxfmt'

import formatterConfig from '../../../../.oxfmtrc.json'

export const maxOntologyJsonBytes = 1024 * 1024

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export const serializeSortedJson = (value: unknown): string =>
  `${JSON.stringify(
    value,
    (_key, child: unknown) =>
      isJsonObject(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => compare(a, b))) : child,
    2,
  )}\n`

const { printWidth, tabWidth, useTabs } = formatterConfig

export const formatOntologyJson = async (value: unknown, sortKeys: boolean): Promise<string> => {
  const source = sortKeys ? serializeSortedJson(value) : JSON.stringify(value, null, 2)
  const result = await format('knowledge.json', source, { printWidth, tabWidth, useTabs }).catch(() => undefined)
  if (!result || result.errors.length) throw new Error('Could not format knowledge JSON')
  return result.code
}
