import { createFileRoute } from '@tanstack/react-router'

import {
  DEFAULT_ATLAS_REF,
  normalizeSearchParam,
  resolveAtlasRepository,
  resolveLimit,
  runGitCommand,
} from '~/server/git-utils'

export const Route = createFileRoute('/api/atlas/paths')({
  server: {
    handlers: {
      GET: async ({ request }) => getAtlasPathsHandler(request),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

const errorResponse = (message: string, status = 500) => jsonResponse({ ok: false, message }, status)

const listPaths = async (ref: string, query: string, limit: number) => {
  if (!query) return []
  const args = ['ls-tree', '-r', '--name-only', ref, '--', query]
  const result = await runGitCommand(args)
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    throw new Error(detail || 'git ls-tree failed')
  }
  const paths = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (paths.length <= limit) return paths
  return paths.slice(0, limit)
}

export const getAtlasPathsHandler = async (request: Request) => {
  const url = new URL(request.url)
  const repository = normalizeSearchParam(url.searchParams.get('repository'))
  const ref = normalizeSearchParam(url.searchParams.get('ref')) || DEFAULT_ATLAS_REF
  const query = normalizeSearchParam(url.searchParams.get('query'))
  const limit = resolveLimit(normalizeSearchParam(url.searchParams.get('limit')), 200, 500)

  const repoResult = resolveAtlasRepository(repository)
  if (!repoResult.ok) return errorResponse(repoResult.message, 400)

  try {
    const paths = await listPaths(ref, query, limit)
    return jsonResponse({ ok: true, paths })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500)
  }
}
