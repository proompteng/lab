import { createFileRoute } from '@tanstack/react-router'

import {
  DEFAULT_ATLAS_REF,
  ensureGitRef,
  normalizeSearchParam,
  resolveAtlasRepository,
  runGitCommand,
} from '~/server/git-utils'

const MAX_PREVIEW_CHARS = 120_000

export const Route = createFileRoute('/api/atlas/file')({
  server: {
    handlers: {
      GET: async ({ request }) => getAtlasFileHandler(request),
      POST: async () => new Response('Method Not Allowed', { status: 405 }),
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

const errorResponse = (message: string, status = 500) => jsonResponse({ ok: false, message, error: message }, status)

const resolveServiceError = (message: string) => {
  const normalized = message.toLowerCase()
  if (
    normalized.includes('econnrefused') ||
    normalized.includes('connection terminated unexpectedly') ||
    normalized.includes('server closed the connection unexpectedly') ||
    normalized.includes('terminating connection')
  ) {
    return errorResponse(message, 503)
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return errorResponse(message, 504)
  }
  return errorResponse(message, 500)
}

const readFileAtRef = async (ref: string, path: string) => {
  const result = await runGitCommand(['show', `${ref}:${path}`])
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    throw new Error(detail || 'git show failed')
  }
  return result.stdout
}

export const getAtlasFileHandler = async (request: Request) => {
  try {
    const url = new URL(request.url)
    const repository = normalizeSearchParam(url.searchParams.get('repository'))
    const ref = normalizeSearchParam(url.searchParams.get('ref')) || DEFAULT_ATLAS_REF
    const path = normalizeSearchParam(url.searchParams.get('path'))

    if (!path) return errorResponse('Path is required.', 400)
    if (ref !== DEFAULT_ATLAS_REF) {
      return errorResponse('Atlas file previews are limited to the main branch.', 400)
    }

    const repoResult = resolveAtlasRepository(repository)
    if (!repoResult.ok) return errorResponse(repoResult.message, 400)

    const refResult = await ensureGitRef(ref)
    if (!refResult.ok) return errorResponse(refResult.message, 404)

    const content = await readFileAtRef(ref, path)
    const truncated = content.length > MAX_PREVIEW_CHARS
    const preview = truncated ? content.slice(0, MAX_PREVIEW_CHARS) : content

    return jsonResponse({
      ok: true,
      repository: repoResult.repository,
      ref,
      path,
      truncated,
      content: preview,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return resolveServiceError(message)
  }
}
