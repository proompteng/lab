import { metadataHeadersSchema } from './validation'

export const createDefaultHeaders = (apiKey?: string): Record<string, string> => {
  if (!apiKey) {
    return {}
  }
  return metadataHeadersSchema.parse({
    Authorization: `Bearer ${apiKey}`,
  })
}

export const mergeHeaders = (current: Record<string, string>, next: Record<string, string>): Record<string, string> => {
  return { ...current, ...next }
}
