#!/usr/bin/env bun

import { ensureCli, fatal, run } from '../shared/cli'

const reviewThreadsQuery = `query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isResolved
          path
          comments(last: 1) {
            nodes {
              bodyText
              url
              author {
                login
              }
            }
          }
        }
      }
    }
  }
}`

interface GraphqlReviewCommentNode {
  bodyText?: string | null
  url?: string | null
  author?: { login?: string | null } | null
}

interface GraphqlReviewThreadNode {
  isResolved?: boolean | null
  path?: string | null
  comments?: { nodes?: GraphqlReviewCommentNode[] | null } | null
}

interface GraphqlReviewThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: GraphqlReviewThreadNode[] | null
          pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null
        } | null
      } | null
    } | null
  }
  errors?: { message?: string }[]
}

interface CheckRunPayload {
  name?: string
  conclusion?: string | null
  status?: string | null
  html_url?: string | null
  details_url?: string | null
}

interface PullRequestPayload {
  number: number
  title?: string | null
  body?: string | null
  url?: string | null
  headRefName: string
  headRefOid: string
  baseRefName: string
  isDraft?: boolean
  mergeStateStatus?: string | null
}

export interface ReviewThreadSummary {
  summary: string
  url?: string
  author?: string
}

export interface ReviewCheckSummary {
  name: string
  conclusion?: string
  url?: string
  details?: string
}

export interface ReviewContextSummary {
  summary?: string
  reviewThreads: ReviewThreadSummary[]
  failingChecks: ReviewCheckSummary[]
  additionalNotes: string[]
}

const textDecoder = new TextDecoder()

const execJson = (command: string, args: string[]) => {
  const result = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    const stderr = textDecoder.decode(result.stderr)
    fatal(`Command failed: ${command} ${args.join(' ')}\n${stderr.trim()}`)
  }
  const stdout = textDecoder.decode(result.stdout)
  try {
    return JSON.parse(stdout)
  } catch (error) {
    fatal(`Failed to parse JSON output from ${command}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const summarizeText = (value: string | null | undefined, maxLength = 200) => {
  if (!value) return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

export const buildReviewContext = (
  threads: GraphqlReviewThreadNode[],
  checks: CheckRunPayload[],
  mergeStateStatus?: string | null,
): ReviewContextSummary => {
  const unresolvedThreads: ReviewThreadSummary[] = []
  const additionalNotes: string[] = []

  for (const thread of threads ?? []) {
    if (thread?.isResolved) {
      continue
    }

    const comments = thread?.comments?.nodes ?? []
    const latest = comments.length > 0 ? comments[comments.length - 1] : undefined
    let summary = summarizeText(latest?.bodyText)
    if (!summary) {
      summary = summarizeText(thread?.path, 160) ?? 'Review thread requires attention.'
    }
    const author = latest?.author?.login?.trim()
    const url = latest?.url ?? undefined

    unresolvedThreads.push({
      summary,
      author: author && author.length > 0 ? author : undefined,
      url: url && url.length > 0 ? url : undefined,
    })
  }

  const failureConclusions = new Set(['failure', 'timed_out', 'action_required', 'cancelled', 'stale'])
  const failureStates = new Set(['failure', 'error'])

  const failingChecks: ReviewCheckSummary[] = []
  for (const check of checks ?? []) {
    const conclusion = check.conclusion?.toLowerCase() ?? ''
    const status = check.status?.toLowerCase() ?? ''
    if (!failureConclusions.has(conclusion) && !failureStates.has(status)) {
      continue
    }
    const name = summarizeText(check.name) ?? 'GitHub check run'
    failingChecks.push({
      name,
      conclusion: conclusion || undefined,
      url: check.html_url ?? check.details_url ?? undefined,
      details: undefined,
    })
  }

  const summaryParts: string[] = []
  if (unresolvedThreads.length > 0) {
    summaryParts.push(
      `${unresolvedThreads.length} unresolved review thread${unresolvedThreads.length === 1 ? '' : 's'}`,
    )
  }
  if (failingChecks.length > 0) {
    summaryParts.push(`${failingChecks.length} failing check${failingChecks.length === 1 ? '' : 's'}`)
  }

  const normalizedMergeState = mergeStateStatus ? mergeStateStatus.trim().toUpperCase() : undefined
  if (normalizedMergeState && !['CLEAN', 'UNSTABLE', 'UNKNOWN'].includes(normalizedMergeState)) {
    additionalNotes.push(`GitHub reports mergeStateStatus=${normalizedMergeState}.`)
    if (normalizedMergeState === 'DIRTY') {
      summaryParts.push('merge conflicts detected')
      additionalNotes.push('Resolve merge conflicts with the base branch before retrying.')
    }
  }

  return {
    summary: summaryParts.length > 0 ? `Outstanding items: ${summaryParts.join(', ')}.` : undefined,
    reviewThreads: unresolvedThreads,
    failingChecks,
    additionalNotes,
  }
}

const fetchPullRequest = (repository: string, prNumber: number): PullRequestPayload => {
  const payload = execJson('gh', [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repository,
    '--json',
    'number,title,body,url,headRefName,headRefOid,baseRefName,isDraft,mergeStateStatus',
  ]) as PullRequestPayload

  if (!payload?.headRefName || !payload?.headRefOid || !payload?.baseRefName) {
    fatal('Failed to load pull request metadata from GitHub')
  }

  return payload
}

const fetchReviewThreads = (owner: string, repo: string, prNumber: number): GraphqlReviewThreadNode[] => {
  const threads: GraphqlReviewThreadNode[] = []
  let cursor: string | undefined

  while (true) {
    const args = [
      'api',
      'graphql',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${repo}`,
      '-F',
      `number=${prNumber}`,
      '-f',
      `query=${reviewThreadsQuery}`,
    ]
    if (cursor) {
      args.push('-f', `cursor=${cursor}`)
    }

    const response = execJson('gh', args) as GraphqlReviewThreadsResponse
    if (response.errors?.length) {
      const [firstError] = response.errors
      fatal(`GitHub GraphQL error: ${firstError?.message ?? 'unknown error'}`)
    }

    const nodes =
      response.data?.repository?.pullRequest?.reviewThreads?.nodes?.filter(Boolean) ?? ([] as GraphqlReviewThreadNode[])
    threads.push(...nodes)

    const pageInfo = response.data?.repository?.pullRequest?.reviewThreads?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor || pageInfo.endCursor === cursor) {
      break
    }
    cursor = pageInfo.endCursor
  }

  return threads
}

const fetchCheckRuns = (repository: string, headSha: string): CheckRunPayload[] => {
  const payload = execJson('gh', ['api', `repos/${repository}/commits/${headSha}/check-runs`, '--paginate']) as {
    check_runs?: CheckRunPayload[]
  }

  return payload.check_runs ?? []
}

const buildEventBody = (repository: string, pr: PullRequestPayload, context: ReviewContextSummary) => ({
  stage: 'review',
  repository,
  issueNumber: pr.number,
  issueTitle: pr.title ?? '',
  issueBody: pr.body ?? '',
  issueUrl: pr.url ?? '',
  base: pr.baseRefName,
  head: pr.headRefName,
  reviewContext: {
    summary: context.summary,
    reviewThreads: context.reviewThreads,
    failingChecks: context.failingChecks,
    additionalNotes: context.additionalNotes,
  },
})

const extractPrIdentifier = (value: string) => {
  if (/^https?:\/\//i.test(value)) {
    const match = value.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i)
    if (!match) {
      throw new Error(`Unable to parse pull request URL: ${value}`)
    }
    return {
      prNumber: Number.parseInt(match[3], 10),
      repo: `${match[1]}/${match[2]}`,
    }
  }

  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid PR number: ${value}`)
  }
  return { prNumber: parsed }
}

const parseArgs = (argv: string[]) => {
  const options: { repo: string; namespace: string; dryRun: boolean } = {
    repo: 'proompteng/lab',
    namespace: 'argo-workflows',
    dryRun: false,
  }
  let prNumber: number | undefined
  let repoFromPr: string | undefined
  let repoExplicit = false

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg.startsWith('--repo=')) {
      options.repo = arg.slice('--repo='.length)
      repoExplicit = true
      continue
    }
    if (arg.startsWith('--namespace=')) {
      options.namespace = arg.slice('--namespace='.length)
      continue
    }
    if (arg.startsWith('--pr=')) {
      const result = extractPrIdentifier(arg.slice('--pr='.length))
      prNumber = result.prNumber
      if (result.repo) {
        repoFromPr = result.repo
      }
    }
  }

  if (!prNumber) {
    throw new Error(
      'Usage: bun run packages/scripts/src/codex/trigger-review-workflow.ts --pr=<number> [--repo=owner/name]',
    )
  }

  if (!options.repo.includes('/')) {
    throw new Error(`Repository must be in the form owner/name (received '${options.repo}')`)
  }

  if (repoFromPr) {
    if (repoExplicit && options.repo !== repoFromPr) {
      throw new Error(`Repository mismatch between --repo (${options.repo}) and PR URL (${repoFromPr})`)
    }
    if (!repoExplicit) {
      options.repo = repoFromPr
    }
  }

  return { ...options, pr: prNumber }
}

const main = async () => {
  ensureCli('gh')
  ensureCli('argo')

  let options: ReturnType<typeof parseArgs>
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fatal(message)
  }

  const [owner, repo] = options.repo.split('/')
  const prNumber = options.pr

  const pr = fetchPullRequest(options.repo, prNumber)
  const reviewThreads = fetchReviewThreads(owner, repo, prNumber)
  const checkRuns = fetchCheckRuns(options.repo, pr.headRefOid)

  const context = buildReviewContext(reviewThreads, checkRuns, pr.mergeStateStatus)

  if (
    context.reviewThreads.length === 0 &&
    context.failingChecks.length === 0 &&
    context.additionalNotes.length === 0
  ) {
    console.log('No unresolved review threads or failing checks detected. Skipping Argo submission.')
    return
  }

  const eventBody = buildEventBody(options.repo, pr, context)
  const eventBodyJson = JSON.stringify(eventBody)

  console.log(`Submitting review workflow for ${options.repo}#${prNumber}`)
  if (options.dryRun) {
    console.log(JSON.stringify(eventBody, null, 2))
    return
  }

  await run('argo', [
    'submit',
    '--from',
    'workflowtemplate/github-codex-review',
    '-n',
    options.namespace,
    '-p',
    'rawEvent={}',
    '-p',
    `eventBody=${eventBodyJson}`,
  ])
}

if (import.meta.main) {
  main().catch((error) => fatal('Failed to trigger review workflow', error))
}

export { buildEventBody, fetchCheckRuns, fetchPullRequest, fetchReviewThreads, parseArgs, summarizeText }
