import { mergePullRequest, resolvePullRequestThread, submitPullRequestReview } from '~/server/github-review-actions'
import { isGithubRepoAllowed, loadGithubReviewConfig } from '~/server/github-review-config'
import { createGithubReviewStore } from '~/server/github-review-store'
import { refreshWorktreeSnapshot } from '~/server/github-worktree-snapshot'

const DEFAULT_REPOSITORY = 'proompteng/lab'

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

const parseNumberParam = (value: string | undefined) => {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

const parseLimit = (value: string | null, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(parsed, 100))
}

const GITHUB_LOGIN_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i

const resolveActor = (request: Request) => {
  const candidates = ['x-jangar-actor', 'x-forwarded-user', 'x-auth-request-user', 'x-remote-user', 'x-github-user']
  for (const header of candidates) {
    const value = request.headers.get(header)
    const raw = value?.split(',')[0]?.trim()
    if (!raw) continue
    if (!GITHUB_LOGIN_PATTERN.test(raw)) continue
    return raw
  }
  return null
}

const maybeAutoRefreshFiles = async (
  store: ReturnType<typeof createGithubReviewStore>,
  input: {
    repository: string
    prNumber: number
    headRef: string | null
    baseRef: string | null
    headSha: string | null
  },
) => {
  if (!input.headRef || !input.baseRef) return false
  const existing = await store.getPrWorktree({ repository: input.repository, prNumber: input.prNumber })
  if (existing?.headSha && input.headSha && existing.headSha === input.headSha) return false
  try {
    await refreshWorktreeSnapshot({
      repository: input.repository,
      prNumber: input.prNumber,
      headRef: input.headRef,
      baseRef: input.baseRef,
    })
    return true
  } catch (error) {
    console.warn('[github-review] worktree snapshot refresh failed', {
      repository: input.repository,
      prNumber: input.prNumber,
      error: String(error),
    })
  }
  return false
}

export const getPullsHandler = async (request: Request, createStore = createGithubReviewStore) => {
  const config = loadGithubReviewConfig()
  if (config.reposAllowed.length === 0) {
    return jsonResponse({ ok: false, error: 'Repository allowlist is empty' }, 403)
  }

  const url = new URL(request.url)
  const repositoryParam = url.searchParams.get('repository')?.trim() ?? ''
  const repository = repositoryParam || DEFAULT_REPOSITORY
  if (repository && !isGithubRepoAllowed(config, repository)) {
    return jsonResponse({ ok: false, error: 'Repository not allowed' }, 403)
  }

  const viewerLogin = resolveActor(request)
  const authorParam = url.searchParams.get('author')?.trim() ?? ''
  const store = createStore()

  try {
    const result = await store.listPulls({
      repository,
      state: url.searchParams.get('state')?.trim() || undefined,
      author: authorParam || viewerLogin || undefined,
      label: url.searchParams.get('label')?.trim() || undefined,
      reviewDecision: url.searchParams.get('reviewDecision')?.trim() || undefined,
      ciStatus: url.searchParams.get('ciStatus')?.trim() || undefined,
      limit: parseLimit(url.searchParams.get('limit'), 25),
      cursor: url.searchParams.get('cursor')?.trim() || undefined,
    })

    return jsonResponse({
      ok: true,
      items: result.items,
      nextCursor: result.nextCursor,
      capabilities: {
        reviewsWriteEnabled: config.reviewsWriteEnabled,
        mergeWriteEnabled: config.mergeWriteEnabled,
      },
      repositoriesAllowed: config.reposAllowed,
      viewerLogin,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load pull requests'
    return jsonResponse({ ok: false, error: message }, 500)
  } finally {
    await store.close()
  }
}

export const getPullHandler = async (
  _request: Request,
  params: { owner: string; repo: string; number: string },
  createStore = createGithubReviewStore,
) => {
  const prNumber = parseNumberParam(params.number)
  if (!prNumber) {
    return jsonResponse({ ok: false, error: 'Invalid pull request number' }, 400)
  }

  const repository = `${params.owner}/${params.repo}`
  const config = loadGithubReviewConfig()
  if (!isGithubRepoAllowed(config, repository)) {
    return jsonResponse({ ok: false, error: 'Repository not allowed' }, 403)
  }

  const store = createStore()
  try {
    const result = await store.getPull({ repository, prNumber })
    if (!result.pull) {
      return jsonResponse({ ok: false, error: 'Pull request not found' }, 404)
    }

    return jsonResponse({
      ok: true,
      pull: result.pull,
      review: result.review,
      checks: result.checks,
      issueComments: result.issueComments,
      capabilities: {
        reviewsWriteEnabled: config.reviewsWriteEnabled,
        mergeWriteEnabled: config.mergeWriteEnabled,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load pull request'
    return jsonResponse({ ok: false, error: message }, 500)
  } finally {
    await store.close()
  }
}

export const getPullFilesHandler = async (
  _request: Request,
  params: { owner: string; repo: string; number: string },
  createStore = createGithubReviewStore,
) => {
  const prNumber = parseNumberParam(params.number)
  if (!prNumber) {
    return jsonResponse({ ok: false, error: 'Invalid pull request number' }, 400)
  }

  const repository = `${params.owner}/${params.repo}`
  const config = loadGithubReviewConfig()
  if (!isGithubRepoAllowed(config, repository)) {
    return jsonResponse({ ok: false, error: 'Repository not allowed' }, 403)
  }

  const store = createStore()
  try {
    const pull = await store.getPull({ repository, prNumber })
    if (!pull.pull) {
      return jsonResponse({ ok: false, error: 'Pull request not found' }, 404)
    }

    const worktree = await store.getPrWorktree({ repository, prNumber })
    const commitSha = worktree?.headSha ?? pull.pull.headSha
    let files = await store.listFiles({
      repository,
      prNumber,
      commitSha,
      source: 'worktree',
    })
    if (files.length === 0) {
      const refreshed = await maybeAutoRefreshFiles(store, {
        repository,
        prNumber,
        headRef: pull.pull.headRef ?? null,
        baseRef: pull.pull.baseRef ?? null,
        headSha: pull.pull.headSha ?? null,
      })
      if (refreshed) {
        const refreshedWorktree = await store.getPrWorktree({ repository, prNumber })
        const refreshedCommit = refreshedWorktree?.headSha ?? pull.pull.headSha
        files = await store.listFiles({
          repository,
          prNumber,
          commitSha: refreshedCommit,
          source: 'worktree',
        })
      }
    }
    return jsonResponse({ ok: true, files })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load pull request files'
    return jsonResponse({ ok: false, error: message }, 500)
  } finally {
    await store.close()
  }
}

export const refreshPullFilesHandler = async (
  _request: Request,
  params: { owner: string; repo: string; number: string },
  createStore = createGithubReviewStore,
) => {
  const prNumber = parseNumberParam(params.number)
  if (!prNumber) {
    return jsonResponse({ ok: false, error: 'Invalid pull request number' }, 400)
  }

  const repository = `${params.owner}/${params.repo}`
  const config = loadGithubReviewConfig()
  if (!isGithubRepoAllowed(config, repository)) {
    return jsonResponse({ ok: false, error: 'Repository not allowed' }, 403)
  }

  const store = createStore()
  try {
    const pull = await store.getPull({ repository, prNumber })
    if (!pull.pull) {
      return jsonResponse({ ok: false, error: 'Pull request not found' }, 404)
    }
    if (!pull.pull.headRef || !pull.pull.baseRef) {
      return jsonResponse({ ok: false, error: 'Missing base/head ref for pull request' }, 400)
    }

    const snapshot = await refreshWorktreeSnapshot({
      repository,
      prNumber,
      headRef: pull.pull.headRef,
      baseRef: pull.pull.baseRef,
    })

    return jsonResponse({
      ok: true,
      commitSha: snapshot.commitSha,
      baseSha: snapshot.baseSha,
      fileCount: snapshot.fileCount,
      worktreePath: snapshot.worktreePath,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to refresh pull request files'
    return jsonResponse({ ok: false, error: message }, 500)
  } finally {
    await store.close()
  }
}

export const getPullChecksHandler = async (
  _request: Request,
  params: { owner: string; repo: string; number: string },
  createStore = createGithubReviewStore,
) => {
  const prNumber = parseNumberParam(params.number)
  if (!prNumber) {
    return jsonResponse({ ok: false, error: 'Invalid pull request number' }, 400)
  }

  const repository = `${params.owner}/${params.repo}`
  const config = loadGithubReviewConfig()
  if (!isGithubRepoAllowed(config, repository)) {
    return jsonResponse({ ok: false, error: 'Repository not allowed' }, 403)
  }

  const store = createStore()
  try {
    const checks = await store.listCheckStates({ repository, prNumber })
    return jsonResponse({ ok: true, commits: checks })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load pull request checks'
    return jsonResponse({ ok: false, error: message }, 500)
  } finally {
    await store.close()
  }
}

export const getPullThreadsHandler = async (
  _request: Request,
  params: { owner: string; repo: string; number: string },
  createStore = createGithubReviewStore,
) => {
  const prNumber = parseNumberParam(params.number)
  if (!prNumber) {
    return jsonResponse({ ok: false, error: 'Invalid pull request number' }, 400)
  }

  const repository = `${params.owner}/${params.repo}`
  const config = loadGithubReviewConfig()
  if (!isGithubRepoAllowed(config, repository)) {
    return jsonResponse({ ok: false, error: 'Repository not allowed' }, 403)
  }

  const store = createStore()
  try {
    const threads = await store.listThreads({ repository, prNumber })
    return jsonResponse({ ok: true, threads })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load review threads'
    return jsonResponse({ ok: false, error: message }, 500)
  } finally {
    await store.close()
  }
}

type ReviewBody = {
  event?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body?: string
  comments?: Array<{ path?: string; line?: number; side?: 'LEFT' | 'RIGHT'; body?: string; startLine?: number }>
}

export const submitReviewHandler = async (
  request: Request,
  params: { owner: string; repo: string; number: string },
  actions: { submitPullRequestReview: typeof submitPullRequestReview } = { submitPullRequestReview },
) => {
  const prNumber = parseNumberParam(params.number)
  if (!prNumber) {
    return jsonResponse({ ok: false, error: 'Invalid pull request number' }, 400)
  }

  let body: ReviewBody = {}
  try {
    body = (await request.json()) as ReviewBody
  } catch {
    body = {}
  }

  const event = body.event ?? 'COMMENT'
  if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(event)) {
    return jsonResponse({ ok: false, error: 'Invalid review event' }, 400)
  }

  const comments = (body.comments ?? [])
    .map((comment) => ({
      path: comment.path?.trim() ?? '',
      line: comment.line ?? null,
      side: comment.side ?? 'RIGHT',
      body: comment.body?.trim() ?? '',
      startLine: comment.startLine,
    }))
    .filter((comment) => comment.path && comment.line && comment.body)
    .map((comment) => ({
      path: comment.path,
      line: comment.line as number,
      side: comment.side as 'LEFT' | 'RIGHT',
      body: comment.body,
      startLine: comment.startLine,
    }))

  try {
    const result = await actions.submitPullRequestReview(request, {
      owner: params.owner,
      repo: params.repo,
      number: prNumber,
      event,
      body: body.body?.trim() || null,
      comments,
    })

    return jsonResponse({ ok: true, review: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to submit review'
    return jsonResponse({ ok: false, error: message }, 500)
  }
}

type ResolveBody = {
  resolve?: boolean
}

export const resolveThreadHandler = async (
  request: Request,
  params: { owner: string; repo: string; number: string; threadId: string },
  actions: { resolvePullRequestThread: typeof resolvePullRequestThread } = { resolvePullRequestThread },
) => {
  const prNumber = parseNumberParam(params.number)
  if (!prNumber) {
    return jsonResponse({ ok: false, error: 'Invalid pull request number' }, 400)
  }

  let body: ResolveBody = {}
  try {
    body = (await request.json()) as ResolveBody
  } catch {
    body = {}
  }

  try {
    const result = await actions.resolvePullRequestThread(request, {
      owner: params.owner,
      repo: params.repo,
      number: prNumber,
      threadKey: params.threadId,
      resolve: body.resolve !== false,
    })

    return jsonResponse({ ok: true, thread: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to resolve thread'
    return jsonResponse({ ok: false, error: message }, 500)
  }
}

type MergeBody = {
  method?: 'merge' | 'squash' | 'rebase'
  commitTitle?: string
  commitMessage?: string
  deleteBranch?: boolean
  force?: boolean
}

export const mergePullHandler = async (
  request: Request,
  params: { owner: string; repo: string; number: string },
  actions: { mergePullRequest: typeof mergePullRequest } = { mergePullRequest },
) => {
  const prNumber = parseNumberParam(params.number)
  if (!prNumber) {
    return jsonResponse({ ok: false, error: 'Invalid pull request number' }, 400)
  }

  let body: MergeBody = {}
  try {
    body = (await request.json()) as MergeBody
  } catch {
    body = {}
  }

  const method = body.method ?? 'squash'
  if (!['merge', 'squash', 'rebase'].includes(method)) {
    return jsonResponse({ ok: false, error: 'Invalid merge method' }, 400)
  }

  const config = loadGithubReviewConfig()

  try {
    const result = await actions.mergePullRequest(request, {
      owner: params.owner,
      repo: params.repo,
      number: prNumber,
      method,
      commitTitle: body.commitTitle?.trim() || null,
      commitMessage: body.commitMessage?.trim() || null,
      deleteBranch: Boolean(body.deleteBranch),
      force: Boolean(body.force && config.mergeForceEnabled),
    })

    return jsonResponse({ ok: true, ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to merge pull request'
    return jsonResponse({ ok: false, error: message }, 500)
  }
}
