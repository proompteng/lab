import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export const jsonTextResult = (structuredContent: Record<string, unknown>): CallToolResult => ({
  structuredContent,
  content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
})

export const errorResult = (message: string, challenge?: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
  ...(challenge ? { _meta: { 'mcp/www_authenticate': [challenge] } } : {}),
})

export const parseJsonOrNull = (value: string) => {
  try {
    return value.trim() ? (JSON.parse(value) as unknown) : null
  } catch {
    return null
  }
}
