import {
  clampUtf8,
  fitRepoContext,
  type ContextCodeHit,
  type ContextMemoryHit,
  type ContextSource,
  type ResolvedRepoContextInput,
  type AgentsFetch,
  type RepoContextResponse,
} from '@proompteng/agent-contracts'

import type { MemoriesStore } from './memory-notes-store'
import { asRecord } from './primitives'

const message = (error: unknown) => clampUtf8(error instanceof Error ? error.message : String(error), 128).value
const unavailable = <T>(error: unknown): ContextSource<T> => ({
  state: 'unavailable',
  message: message(error),
  items: [],
})

const loadMemory = async (
  input: ResolvedRepoContextInput,
  store: Pick<MemoriesStore, 'retrieve'>,
  signal?: AbortSignal,
) => {
  const deadline = new AbortController()
  const timeout = setTimeout(() => deadline.abort(new Error('Memory retrieval exceeded its 15000ms deadline.')), 15_000)
  const scopedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<Awaited<ReturnType<MemoriesStore['retrieve']>>>((resolve, reject) => {
      onAbort = () => reject(scopedSignal.reason)
      if (scopedSignal.aborted) return onAbort()
      scopedSignal.addEventListener('abort', onAbort, { once: true })
      store
        .retrieve(
          { query: input.query, repository: input.repository, tags: input.tags, limit: input.limit },
          scopedSignal,
        )
        .then(resolve, reject)
    })
  } finally {
    clearTimeout(timeout)
    if (onAbort) scopedSignal.removeEventListener('abort', onAbort)
  }
}

const loadCode = async (input: ResolvedRepoContextInput, fetcher: AgentsFetch, signal?: AbortSignal) => {
  const baseUrl = (process.env.ATLAS_BASE_URL ?? 'http://jangar.jangar.svc.cluster.local').replace(/\/+$/, '')
  const response = await fetcher(`${baseUrl}/api/code-search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: input.query,
      repository: input.repository,
      ref: 'main',
      pathPrefix: input.pathPrefix,
      limit: Math.min(30, input.limit * 3),
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  })
  const body = asRecord(await response.json())
  const health = asRecord(body?.indexHealth)
  const indexedCommit = typeof health?.indexedCommit === 'string' ? health.indexedCommit : null
  const failure = (state: 'unavailable' | 'stale' | 'degraded', reason: string) => ({
    indexedCommit,
    source: { state, message: clampUtf8(reason, 128).value, items: [] } satisfies ContextSource<ContextCodeHit>,
  })
  if (!response.ok || body?.ok !== true || health?.status !== 'ok') {
    return failure(
      'unavailable',
      typeof body?.error === 'string' ? body.error : `Atlas is unavailable (${response.status}).`,
    )
  }
  if (!indexedCommit || !/^[0-9a-f]{40}$/.test(indexedCommit) || !Array.isArray(body.items)) {
    return failure('unavailable', 'Atlas returned an invalid snapshot or result list.')
  }
  if (input.expectedCommit && input.expectedCommit !== indexedCommit) {
    return failure(
      'stale',
      `Atlas indexes ${indexedCommit}; the requested checkout is ${input.expectedCommit}. Use local Git and rg for this checkout.`,
    )
  }
  const items: ContextCodeHit[] = []
  const seenPaths = new Set<string>()
  for (const raw of body.items) {
    const item = asRecord(raw)
    if (!item || item.repository !== input.repository || item.ref !== 'main' || item.commit !== indexedCommit) {
      return failure('degraded', 'Atlas results disagree with the requested repository or indexed snapshot.')
    }
    if (item.degradation) return failure('degraded', `Atlas reported degraded retrieval: ${String(item.degradation)}`)
    const { path, contentHash, snippet, startLine, endLine } = item
    if (
      typeof path !== 'string' ||
      path.startsWith('/') ||
      path.split('/').includes('..') ||
      (input.pathPrefix && !path.startsWith(input.pathPrefix)) ||
      typeof contentHash !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(contentHash) ||
      (snippet !== null && typeof snippet !== 'string') ||
      (startLine !== null && (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1)) ||
      (endLine !== null && (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < (startLine ?? 1)))
    ) {
      return failure('degraded', 'Atlas returned invalid source provenance or line bounds.')
    }
    const preview = clampUtf8(snippet ?? '', 1_000)
    if (seenPaths.has(path) || items.length >= input.limit) continue
    seenPaths.add(path)
    items.push({
      path,
      contentHash,
      commit: indexedCommit,
      startLine,
      endLine,
      excerpt: preview.value,
      truncated: preview.truncated,
    })
  }
  return { indexedCommit, source: { state: 'ready', items, omitted: 0 } satisfies ContextSource<ContextCodeHit> }
}

export const retrieveRepoContext = async (
  input: ResolvedRepoContextInput,
  store: Pick<MemoriesStore, 'retrieve'>,
  options: { fetch?: AgentsFetch; signal?: AbortSignal } = {},
): Promise<RepoContextResponse> => {
  const [codeResult, memoryResult] = await Promise.allSettled([
    loadCode(input, options.fetch ?? fetch, options.signal),
    loadMemory(input, store, options.signal),
  ])
  const code =
    codeResult.status === 'fulfilled' ? codeResult.value.source : unavailable<ContextCodeHit>(codeResult.reason)
  let memory: ContextSource<ContextMemoryHit>
  if (memoryResult.status === 'rejected') {
    memory = unavailable(memoryResult.reason)
  } else {
    memory = {
      state: 'ready',
      omitted: 0,
      items: memoryResult.value.map((note) => {
        const preview = clampUtf8(note.content, 1_000)
        const commit = note.metadata.commit
        const model = note.metadata.noteModel
        return {
          id: note.id,
          namespace: note.namespace,
          summary: clampUtf8(note.summary ?? '', 320).value,
          excerpt: preview.value,
          truncated: preview.truncated,
          createdAt: note.createdAt,
          commit: typeof commit === 'string' && /^[0-9a-f]{40}$/i.test(commit) ? commit : null,
          model: typeof model === 'string' ? clampUtf8(model, 128).value : null,
        }
      }),
    }
  }
  const indexedCommit = codeResult.status === 'fulfilled' ? codeResult.value.indexedCommit : null
  const result: RepoContextResponse = {
    ok: true,
    repository: input.repository,
    expectedCommit: input.expectedCommit ?? null,
    indexedCommit,
    snapshotVerified: code.state === 'ready' && Boolean(input.expectedCommit && input.expectedCommit === indexedCommit),
    code,
    memory,
    maxBytes: input.maxBytes,
  }
  return fitRepoContext(result, result.maxBytes)
}
