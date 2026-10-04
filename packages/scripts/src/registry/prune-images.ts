#!/usr/bin/env bun

import { spawn } from 'node:child_process'

import { ensureCli, fatal, run } from '../shared/cli'

type PruneOptions = {
  apply: boolean
  baseUrl: string | null
  catalogPageSize: number
  concurrency: number
  deleteUntagged: boolean
  gc: boolean
  restartRegistry: boolean
  keep: number
  keepTags: string[]
  namespace: string
  portForward: boolean
  portForwardPort: number
  repositories: string[]
  tagPattern: RegExp
  unsafeAllTags: boolean
}

type TagInfo = {
  createdAtMs: number | null
  manifestDigest: string
  tag: string
}

type PrunePlan = {
  delete: TagInfo[]
  keep: TagInfo[]
  skipped: Array<{ reason: string; tag: string }>
}

const DEFAULT_TAG_PATTERN = /^[0-9a-f]{7,}$/i

const parseArgs = (args: string[]): PruneOptions => {
  const options: PruneOptions = {
    apply: false,
    baseUrl: null,
    catalogPageSize: 250,
    concurrency: 8,
    deleteUntagged: true,
    gc: false,
    restartRegistry: true,
    keep: 5,
    keepTags: ['latest'],
    namespace: 'registry',
    portForward: true,
    portForwardPort: 5000,
    repositories: [],
    tagPattern: DEFAULT_TAG_PATTERN,
    unsafeAllTags: false,
  }

  for (const arg of args) {
    if (arg === '--apply') {
      options.apply = true
      continue
    }
    if (arg === '--gc') {
      options.gc = true
      continue
    }
    if (arg === '--no-gc') {
      options.gc = false
      continue
    }
    if (arg === '--delete-untagged') {
      options.deleteUntagged = true
      continue
    }
    if (arg === '--no-delete-untagged') {
      options.deleteUntagged = false
      continue
    }
    if (arg === '--restart-registry') {
      options.restartRegistry = true
      continue
    }
    if (arg === '--no-restart-registry') {
      options.restartRegistry = false
      continue
    }
    if (arg === '--no-port-forward') {
      options.portForward = false
      continue
    }
    if (arg === '--no-keep-tags') {
      options.keepTags = []
      continue
    }
    if (arg === '--no-keep-tag-latest') {
      options.keepTags = options.keepTags.filter((tag) => tag !== 'latest')
      continue
    }
    if (arg === '--unsafe-all-tags') {
      options.unsafeAllTags = true
      continue
    }
    if (arg.startsWith('--keep=')) {
      const value = Number(arg.slice('--keep='.length))
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`--keep must be a non-negative number (received '${arg}')`)
      }
      options.keep = value
      continue
    }
    if (arg.startsWith('--base-url=')) {
      const value = arg.slice('--base-url='.length)
      if (!value) throw new Error(`--base-url must be non-empty (received '${arg}')`)
      options.baseUrl = value
      options.portForward = false
      continue
    }
    if (arg.startsWith('--concurrency=')) {
      const value = Number(arg.slice('--concurrency='.length))
      if (!Number.isFinite(value) || value < 1) {
        throw new Error(`--concurrency must be a positive number (received '${arg}')`)
      }
      options.concurrency = value
      continue
    }
    if (arg.startsWith('--namespace=')) {
      options.namespace = arg.slice('--namespace='.length)
      continue
    }
    if (arg.startsWith('--repo=')) {
      const repo = arg.slice('--repo='.length)
      if (!repo) throw new Error(`--repo must be non-empty (received '${arg}')`)
      options.repositories.push(repo)
      continue
    }
    if (arg.startsWith('--keep-tag=')) {
      const tag = arg.slice('--keep-tag='.length)
      if (!tag) throw new Error(`--keep-tag must be non-empty (received '${arg}')`)
      options.keepTags.push(tag)
      continue
    }
    if (arg.startsWith('--tag-pattern=')) {
      const pattern = arg.slice('--tag-pattern='.length)
      if (!pattern) throw new Error(`--tag-pattern must be non-empty (received '${arg}')`)
      options.tagPattern = new RegExp(pattern)
      continue
    }
    if (arg.startsWith('--catalog-page-size=')) {
      const value = Number(arg.slice('--catalog-page-size='.length))
      if (!Number.isFinite(value) || value < 1) {
        throw new Error(`--catalog-page-size must be a positive number (received '${arg}')`)
      }
      options.catalogPageSize = value
      continue
    }
    if (arg.startsWith('--port=')) {
      const value = Number(arg.slice('--port='.length))
      if (!Number.isFinite(value) || value < 1 || value > 65535) {
        throw new Error(`--port must be a valid TCP port (received '${arg}')`)
      }
      options.portForwardPort = value
    }
  }

  options.keepTags = [...new Set(options.keepTags)]
  options.repositories = [...new Set(options.repositories)]

  return options
}

const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/')

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) => {
  const results = Array.from({ length: items.length }) as R[]
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })

  await Promise.all(workers)
  return results
}

const getCreatedAtMs = (payload: unknown): number | null => {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const created = typeof record.created === 'string' ? record.created : null
  if (created) {
    const value = Date.parse(created)
    if (Number.isFinite(value)) return value
  }

  const config = record.config
  if (config && typeof config === 'object') {
    const cfg = config as Record<string, unknown>
    const cfgCreated = typeof cfg.created === 'string' ? cfg.created : null
    if (cfgCreated) {
      const value = Date.parse(cfgCreated)
      if (Number.isFinite(value)) return value
    }
  }

  return null
}

const selectPrunePlan = (
  options: { keep: number; keepTags: string[]; tagPattern: RegExp; unsafeAllTags: boolean },
  tags: TagInfo[],
) => {
  const keepTagSet = new Set(options.keepTags)
  const sortable: TagInfo[] = []
  const skipped: Array<{ reason: string; tag: string }> = []

  for (const tag of tags) {
    if (keepTagSet.has(tag.tag)) {
      skipped.push({ reason: 'protected-tag', tag: tag.tag })
      continue
    }

    const versionLike = options.tagPattern.test(tag.tag)
    if (!options.unsafeAllTags && !versionLike) {
      skipped.push({ reason: 'non-version-tag', tag: tag.tag })
      continue
    }

    sortable.push(tag)
  }

  sortable.sort((a, b) => {
    const createdA = a.createdAtMs ?? 0
    const createdB = b.createdAtMs ?? 0
    if (createdA !== createdB) return createdB - createdA
    return b.tag.localeCompare(a.tag)
  })

  const keep = sortable.slice(0, options.keep)
  const deleteList = sortable.slice(options.keep)

  return {
    delete: deleteList,
    keep,
    skipped,
  } satisfies PrunePlan
}

const computeDeleteManifestPlan = (plan: PrunePlan, tags: TagInfo[]) => {
  const tagIndex = new Map(tags.map((tag) => [tag.tag, tag]))

  const protectedTagSet = new Set<string>([
    ...plan.keep.map((tag) => tag.tag),
    ...plan.skipped.map((entry) => entry.tag),
  ])

  const protectedDigests = new Set<string>()
  for (const tag of protectedTagSet) {
    const info = tagIndex.get(tag)
    if (info) protectedDigests.add(info.manifestDigest)
  }

  const deleteByDigest = new Map<string, string[]>()
  const skippedByProtectedDigest: Array<{ tag: string; manifestDigest: string }> = []

  for (const candidate of plan.delete) {
    if (protectedDigests.has(candidate.manifestDigest)) {
      skippedByProtectedDigest.push({ tag: candidate.tag, manifestDigest: candidate.manifestDigest })
      continue
    }
    const existing = deleteByDigest.get(candidate.manifestDigest)
    if (existing) {
      existing.push(candidate.tag)
    } else {
      deleteByDigest.set(candidate.manifestDigest, [candidate.tag])
    }
  }

  const deleteManifests = [...deleteByDigest.entries()].map(([manifestDigest, tagList]) => ({
    manifestDigest,
    tags: tagList,
  }))
  return { deleteManifests, protectedDigests: [...protectedDigests], skippedByProtectedDigest }
}

const ACCEPT_MANIFEST =
  'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'

const fetchJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Request failed: ${response.status} ${response.statusText} (${url})${body ? `\n${body}` : ''}`)
  }
  return response.json() as Promise<unknown>
}

const fetchJsonWithHeaders = async (url: URL, init?: RequestInit): Promise<{ payload: unknown; headers: Headers }> => {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Request failed: ${response.status} ${response.statusText} (${url})${body ? `\n${body}` : ''}`)
  }
  return { payload: (await response.json()) as unknown, headers: response.headers }
}

const fetchManifest = async (baseUrl: string, repo: string, reference: string) => {
  const response = await fetch(`${baseUrl}/v2/${encodePath(repo)}/manifests/${encodeURIComponent(reference)}`, {
    headers: { accept: ACCEPT_MANIFEST },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Failed to fetch manifest for ${repo}:${reference}: ${response.status} ${response.statusText}${body ? `\n${body}` : ''}`,
    )
  }
  const digest = response.headers.get('docker-content-digest')
  if (!digest) throw new Error(`Missing docker-content-digest header for ${repo}:${reference}`)
  const payload = (await response.json()) as unknown
  return { digest, payload }
}

const fetchBlobJson = async (baseUrl: string, repo: string, digest: string) => {
  return fetchJson(`${baseUrl}/v2/${encodePath(repo)}/blobs/${encodeURIComponent(digest)}`)
}

const sleep = async (ms: number) => {
  await Bun.sleep(ms)
}

const withRetry = async <T>(
  label: string,
  fn: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number },
): Promise<T> => {
  const maxAttempts = options?.maxAttempts ?? 5
  const baseDelayMs = options?.baseDelayMs ?? 150
  const maxDelayMs = options?.maxDelayMs ?? 2_000

  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1
    try {
      return await fn()
    } catch (error) {
      if (attempt >= maxAttempts) throw error
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      console.warn(`Retrying ${label} (attempt ${attempt}/${maxAttempts}) after ${delay}ms: ${String(error)}`)
      await sleep(delay)
    }
  }
}

const resolvePlatformManifestDigest = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const manifests = record.manifests
  if (!Array.isArray(manifests)) return null

  const candidates = manifests
    .map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null))
    .filter(Boolean) as Array<Record<string, unknown>>

  const pick = (candidate: Record<string, unknown>) => {
    const digest = typeof candidate.digest === 'string' ? candidate.digest : null
    if (!digest) return null
    const platform = candidate.platform
    if (!platform || typeof platform !== 'object') return { digest, score: 0 }
    const platformRecord = platform as Record<string, unknown>
    const os = typeof platformRecord.os === 'string' ? platformRecord.os : ''
    const arch = typeof platformRecord.architecture === 'string' ? platformRecord.architecture : ''
    const variant = typeof platformRecord.variant === 'string' ? platformRecord.variant : ''

    let score = 0
    if (os === 'linux') score += 10
    if (arch === 'amd64') score += 5
    if (variant) score -= 1
    return { digest, score }
  }

  const ranked = candidates.map(pick).filter(Boolean) as Array<{ digest: string; score: number }>
  ranked.sort((a, b) => b.score - a.score)
  return ranked[0]?.digest ?? null
}

const resolveConfigDigest = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const config = record.config
  if (!config || typeof config !== 'object') return null
  const configRecord = config as Record<string, unknown>
  return typeof configRecord.digest === 'string' ? configRecord.digest : null
}

const inspectTag = async (baseUrl: string, repo: string, tag: string): Promise<TagInfo> => {
  const top = await withRetry(`fetch manifest ${repo}:${tag}`, () => fetchManifest(baseUrl, repo, tag))

  let manifestPayload = top.payload
  const platformDigest = resolvePlatformManifestDigest(top.payload)
  if (platformDigest) {
    const platform = await withRetry(`fetch manifest ${repo}@${platformDigest}`, () =>
      fetchManifest(baseUrl, repo, platformDigest),
    )
    manifestPayload = platform.payload
  }

  const configDigest = resolveConfigDigest(manifestPayload)
  let createdAtMs: number | null = null
  if (configDigest) {
    try {
      const configPayload = await withRetry(`fetch config blob ${repo}@${configDigest}`, () =>
        fetchBlobJson(baseUrl, repo, configDigest),
      )
      createdAtMs = getCreatedAtMs(configPayload)
    } catch {
      createdAtMs = null
    }
  }

  return { createdAtMs, manifestDigest: top.digest, tag }
}

const deleteManifest = async (baseUrl: string, repo: string, digest: string): Promise<'deleted' | 'missing'> => {
  const response = await fetch(`${baseUrl}/v2/${encodePath(repo)}/manifests/${encodeURIComponent(digest)}`, {
    method: 'DELETE',
  })

  if (response.status === 202) return 'deleted'
  if (response.status === 404) return 'missing'

  const body = await response.text().catch(() => '')
  throw new Error(
    `Failed to delete manifest ${repo}@${digest}: ${response.status} ${response.statusText}${body ? `\n${body}` : ''}`,
  )
}

const deleteManifestBestEffort = async (
  baseUrl: string,
  repo: string,
  digest: string,
): Promise<{ ok: boolean; status: 'deleted' | 'missing' | 'failed'; error?: string }> => {
  try {
    const status = await withRetry(
      `delete manifest ${repo}@${digest}`,
      async () => {
        try {
          return await deleteManifest(baseUrl, repo, digest)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // Registry can transiently return 500 while under IO/space pressure; retry those cases.
          if (
            message.includes(' 500 ') ||
            message.includes(' 503 ') ||
            message.includes(' 429 ') ||
            message.includes(' 408 ')
          ) {
            throw error
          }
          throw error
        }
      },
      { maxAttempts: 6, baseDelayMs: 250, maxDelayMs: 3_000 },
    )
    return { ok: true, status }
  } catch (error) {
    return { ok: false, status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

const startPortForward = async (namespace: string, port: number) => {
  const subprocess = spawn(
    'kubectl',
    ['-n', namespace, 'port-forward', 'svc/registry', `${port}:80`, '--address', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let ready = false
  const buffer: string[] = []

  const onLine = (line: string) => {
    buffer.push(line)
    if (buffer.length > 20) buffer.shift()
    if (line.includes('Forwarding from 127.0.0.1')) ready = true
  }

  const parseChunks = (source: NodeJS.ReadableStream) => {
    let pending = ''
    source.on('data', (chunk) => {
      pending += chunk.toString('utf8')
      while (true) {
        const newline = pending.indexOf('\n')
        if (newline === -1) break
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        onLine(line)
      }
    })
  }

  if (subprocess.stdout) parseChunks(subprocess.stdout)
  if (subprocess.stderr) parseChunks(subprocess.stderr)

  const waitForReady = async () => {
    const start = Date.now()
    while (!ready) {
      const exitCode = subprocess.exitCode
      if (typeof exitCode === 'number') {
        fatal(`kubectl port-forward exited early (${exitCode})`, buffer.join('\n'))
      }
      if (Date.now() - start > 15_000) {
        fatal('Timed out waiting for kubectl port-forward to become ready', buffer.join('\n'))
      }
      await Bun.sleep(100)
    }
  }

  await waitForReady()

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      subprocess.kill('SIGTERM')
      await Bun.sleep(100)
      if (!subprocess.killed) subprocess.kill('SIGKILL')
    },
  }
}

const listRepositories = async (baseUrl: string, pageSize: number) => {
  const repos: string[] = []
  let last: string | null = null

  while (true) {
    const url = new URL(`${baseUrl}/v2/_catalog`)
    url.searchParams.set('n', String(pageSize))
    if (last) url.searchParams.set('last', last)

    const response = await fetch(url)
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(
        `Failed to list registry catalog: ${response.status} ${response.statusText}${body ? `\n${body}` : ''}`,
      )
    }

    const payload = (await response.json()) as { repositories?: string[] }
    const page = Array.isArray(payload.repositories) ? payload.repositories.filter((r) => typeof r === 'string') : []
    repos.push(...page)

    const link = response.headers.get('link')
    if (!link) break

    const match = link.match(/<[^>]*[?&]last=([^&>]+)[^>]*>;\s*rel="next"/)
    if (!match) break
    last = decodeURIComponent(match[1])
    if (!last) break
  }

  return [...new Set(repos)]
}

const listTags = async (baseUrl: string, repo: string) => {
  const tags: string[] = []
  let last: string | null = null
  const seenLast = new Set<string>()

  while (true) {
    const url = new URL(`${baseUrl}/v2/${encodePath(repo)}/tags/list`)
    url.searchParams.set('n', '1000')
    if (last) url.searchParams.set('last', last)

    const { payload, headers } = await fetchJsonWithHeaders(url)
    const tagList =
      (payload && typeof payload === 'object' ? (payload as { tags?: unknown }).tags : undefined) ?? undefined
    const page = Array.isArray(tagList)
      ? tagList.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
      : []
    tags.push(...page)

    const link = headers.get('link')
    if (!link) break

    const match = link.match(/<[^>]*[?&]last=([^&>]+)[^>]*>;\s*rel="next"/)
    if (!match) break

    last = decodeURIComponent(match[1])
    if (!last) break
    if (seenLast.has(last)) break
    seenLast.add(last)
  }

  return [...new Set(tags)]
}

export const main = async () => {
  ensureCli('kubectl')

  let options: PruneOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fatal(
      `${message}\n\nUsage: bun run packages/scripts/src/registry/prune-images.ts [--repo=lab/jangar] [--keep=5] [--apply] [--gc] [--no-restart-registry] [--no-keep-tags | --no-keep-tag-latest] [--base-url=https://registry.example] [--no-delete-untagged]\n\nDefaults:\n- Uses kubectl port-forward to the in-cluster registry service\n- Keeps 5 tags per repository matching ${DEFAULT_TAG_PATTERN} (keeps non-version tags like 'latest')\n- Does NOT run registry garbage collection unless --gc is set\n- GC deletes untagged manifests by default (use --no-delete-untagged to disable)\n- Restarts the registry after gc unless --no-restart-registry`,
    )
  }

  if (options.apply) {
    console.log('Running in APPLY mode (manifests will be deleted).')
  } else {
    console.log('Running in DRY-RUN mode (no deletes). Pass --apply to delete.')
  }

  const portForward =
    options.baseUrl || !options.portForward ? null : await startPortForward(options.namespace, options.portForwardPort)
  const baseUrl = options.baseUrl ?? portForward?.baseUrl ?? 'http://registry.registry.svc.cluster.local'

  try {
    const allRepos =
      options.repositories.length > 0 ? options.repositories : await listRepositories(baseUrl, options.catalogPageSize)

    if (allRepos.length === 0) {
      console.log('No repositories found.')
      return
    }

    console.log(`Found ${allRepos.length} repositories.`)
    if (options.repositories.length > 0) {
      console.log(`Restricting to repos: ${options.repositories.join(', ')}`)
    }

    if (options.apply && options.gc) {
      console.log('Disk usage before prune:')
      await run('kubectl', ['-n', options.namespace, 'exec', 'deploy/registry', '--', 'df', '-h', '/var/lib/registry'])
    }

    let attemptedDeletes = 0
    let successfulDeletes = 0
    let failedDeletes = 0
    const failures: Array<{ repo: string; digest: string; tag: string; error: string }> = []

    for (const repo of allRepos) {
      try {
        const tags = await listTags(baseUrl, repo)
        if (tags.length === 0) continue

        const tagInfos = await mapLimit(tags, options.concurrency, async (tag) => inspectTag(baseUrl, repo, tag))
        const plan = selectPrunePlan(
          {
            keep: options.keep,
            keepTags: options.keepTags,
            tagPattern: options.tagPattern,
            unsafeAllTags: options.unsafeAllTags,
          },
          tagInfos,
        )

        const manifestPlan = computeDeleteManifestPlan(plan, tagInfos)
        if (manifestPlan.deleteManifests.length === 0) continue

        console.log(`\n${repo}`)
        console.log(`- keep tags: ${plan.keep.length}`)
        console.log(`- delete tags: ${plan.delete.length}`)
        console.log(`- delete manifests: ${manifestPlan.deleteManifests.length}`)
        if (manifestPlan.skippedByProtectedDigest.length > 0) {
          console.warn(`- skip (shared digest): ${manifestPlan.skippedByProtectedDigest.length}`)
        }
        if (plan.skipped.length > 0) {
          const byReason = plan.skipped.reduce(
            (acc, entry) => {
              acc[entry.reason] = (acc[entry.reason] ?? 0) + 1
              return acc
            },
            {} as Record<string, number>,
          )
          console.log(
            `- skipped ${plan.skipped.length} (${Object.entries(byReason)
              .map(([k, v]) => `${k}:${v}`)
              .join(', ')})`,
          )
        }

        for (const entry of plan.delete.slice(0, 20)) {
          const created = entry.createdAtMs ? new Date(entry.createdAtMs).toISOString() : 'unknown'
          console.log(`  - ${entry.tag} (${created})`)
        }
        if (plan.delete.length > 20) console.log(`  - ... (${plan.delete.length - 20} more)`)

        if (!options.apply) continue

        const results = await mapLimit(
          manifestPlan.deleteManifests,
          Math.max(1, Math.min(options.concurrency, 4)),
          async (entry) => {
            attemptedDeletes += 1
            const result = await deleteManifestBestEffort(baseUrl, repo, entry.manifestDigest)
            if (result.ok) {
              successfulDeletes += 1
              return result
            }
            failedDeletes += 1
            failures.push({
              repo,
              digest: entry.manifestDigest,
              tag: entry.tags[0] ?? 'unknown',
              error: result.error ?? 'unknown error',
            })
            return result
          },
        )

        const failed = results.filter((r) => !r.ok).length
        if (failed > 0) console.warn(`- delete failures: ${failed}/${results.length}`)
      } catch (error) {
        console.warn(`Skipping repo ${repo} due to error: ${String(error)}`)
      }
    }

    if (options.apply) {
      console.log(
        `\nDelete summary: attempted=${attemptedDeletes} ok=${successfulDeletes} failed=${failedDeletes} (repos=${allRepos.length})`,
      )
      if (failures.length > 0) {
        console.warn('Some deletes failed; showing first 10:')
        for (const failure of failures.slice(0, 10)) {
          console.warn(`- ${failure.repo}:${failure.tag} (${failure.digest}): ${failure.error}`)
        }
        if (failures.length > 10) console.warn(`- ... (${failures.length - 10} more)`)
      }
    }

    if (options.apply && options.gc) {
      console.log('\nRunning registry garbage collection...')
      const gcArgs = ['-n', options.namespace, 'exec', 'deploy/registry', '--', 'registry', 'garbage-collect']
      if (options.deleteUntagged) {
        gcArgs.push('--delete-untagged')
      }
      gcArgs.push('/etc/distribution/config.yml')
      await run('kubectl', gcArgs)

      if (options.restartRegistry) {
        console.log('\nRestarting registry deployment to clear in-memory cache...')
        await run('kubectl', ['-n', options.namespace, 'scale', 'deploy/registry', '--replicas=0'])
        await run('kubectl', [
          '-n',
          options.namespace,
          'delete',
          'pod',
          '-l',
          'app=registry',
          '--ignore-not-found=true',
          '--wait=true',
        ])
        await run('kubectl', ['-n', options.namespace, 'scale', 'deploy/registry', '--replicas=1'])
        await run('kubectl', ['-n', options.namespace, 'rollout', 'status', 'deploy/registry', '--timeout=180s'])
      }

      console.log('Disk usage after gc:')
      await run('kubectl', ['-n', options.namespace, 'exec', 'deploy/registry', '--', 'df', '-h', '/var/lib/registry'])
    }
  } finally {
    if (portForward) await portForward.stop()
  }
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to prune registry images', error))
}

export const __private = {
  fetchJsonWithHeaders,
  listTags,
}

export { computeDeleteManifestPlan, parseArgs, selectPrunePlan }
