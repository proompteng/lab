import { readFile } from 'node:fs/promises'

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

type ReadFile = (path: string, encoding: BufferEncoding) => Promise<string>

export const createProjectedIdentityFetch = (options: {
  tokenPath: string
  fetch?: FetchLike
  readFile?: ReadFile
}): FetchLike => {
  const fetchImpl = options.fetch ?? fetch
  const readFileImpl = options.readFile ?? readFile

  const readIdentityToken = async () => {
    const token = (await readFileImpl(options.tokenPath, 'utf8')).trim()
    if (!token || token.length > 16_384) throw new Error('projected MCP identity token is invalid')
    return token
  }

  return async (input, init) => {
    const send = async () => {
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${await readIdentityToken()}`)
      return fetchImpl(input, { ...init, headers })
    }
    const response = await send()
    if (response.status !== 401) return response
    await response.body?.cancel().catch(() => undefined)
    return send()
  }
}
