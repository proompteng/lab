import 'server-only'

import { createHash } from 'node:crypto'
import { request } from 'node:https'
import { z } from 'zod'
import { githubLoginSchema } from './access-schemas'
import { OfzError } from './ofz'

const profile = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  login: githubLoginSchema,
  type: z.literal('User'),
})

export async function resolveGithubIdentity(login: string) {
  const requested = githubLoginSchema.parse(login)
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const call = request(
      new URL(`https://api.github.com/users/${encodeURIComponent(requested)}`),
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'tengri-ofz-administration',
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(
            new OfzError(
              response.statusCode === 404
                ? 400
                : response.statusCode === 403 || response.statusCode === 429
                  ? 429
                  : 503,
            ),
          )
          return
        }
        let size = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 65536) call.destroy(new OfzError(503))
          else chunks.push(chunk)
        })
        response.on('error', () => reject(new OfzError(503)))
        response.on('aborted', () => reject(new OfzError(503)))
        response.on('end', () => resolve(Buffer.concat(chunks)))
      },
    )
    const timer = setTimeout(() => call.destroy(new OfzError(503)), 2000)
    call.on('close', () => clearTimeout(timer))
    call.on('error', () => reject(new OfzError(503)))
    call.end()
  })
  return verifyGithubIdentity(requested, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
}

export function verifyGithubIdentity(requested: string, value: unknown) {
  githubLoginSchema.parse(requested)
  const verified = profile.parse(value)
  if (verified.login.toLowerCase() !== requested.toLowerCase()) throw new OfzError(400)
  const githubId = String(verified.id)
  return { githubId, humanId: createHash('sha256').update(`github:${githubId}`).digest('hex') }
}
