import { Buffer } from 'node:buffer'

import * as S from '@effect/schema/Schema'
import { Effect } from 'effect'
import * as Either from 'effect/Either'

import { getCodexClient } from '~/server/codex-client'
import { loadCodexJudgeConfig } from '~/server/codex-judge-config'
import { createCodexJudgeStore, type CodexEvaluationRecord, type CodexRunRecord } from '~/server/codex-judge-store'
import { createGitHubClient, type ReviewSummary } from '~/server/github-client'
import { createPostgresMemoriesStore } from '~/server/memories-store'

const store = createCodexJudgeStore()
const config = loadCodexJudgeConfig()
const github = createGitHubClient({ token: config.githubToken, apiBaseUrl: config.githubApiBaseUrl })

const scheduledRuns = new Map<string, NodeJS.Timeout>()

const safeParseJson = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const decodeBase64Json = (value: string) => {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    return safeParseJson(decoded)
  } catch {
    return {}
  }
}

const getParamValue = (params: Array<{ name?: string; value?: string }>, name: string) => {
  const match = params.find((param) => param.name === name)
  return match?.value ?? ''
}

const ParameterSchema = S.Struct({
  name: S.optional(S.String),
  value: S.optional(S.String),
})

const ParametersSchema = S.Array(ParameterSchema)

const ArtifactSchema = S.Struct({
  name: S.optional(S.String),
  key: S.optional(S.String),
  bucket: S.optional(S.String),
  url: S.optional(S.String),
})

const EventBodySchema = S.Struct({
  repository: S.optional(S.String),
  repo: S.optional(S.String),
  issueNumber: S.optional(S.Union(S.String, S.Number)),
  issue_number: S.optional(S.Union(S.String, S.Number)),
  head: S.optional(S.String),
  base: S.optional(S.String),
  prompt: S.optional(S.String),
  issueTitle: S.optional(S.String),
  issueBody: S.optional(S.String),
  issueUrl: S.optional(S.String),
})

const RunCompletePayloadSchema = S.Struct({
  metadata: S.optional(
    S.Struct({
      name: S.optional(S.String),
      uid: S.optional(S.String),
      namespace: S.optional(S.String),
    }),
  ),
  status: S.optional(
    S.Struct({
      phase: S.optional(S.String),
      startedAt: S.optional(S.String),
      finishedAt: S.optional(S.String),
    }),
  ),
  arguments: S.optional(
    S.Struct({
      parameters: S.optional(ParametersSchema),
    }),
  ),
  artifacts: S.optional(S.Array(S.Unknown)),
  stage: S.optional(S.String),
})

const decodeSchema = <A>(schema: unknown, input: unknown, fallback: A): A => {
  const decoded = S.decodeUnknownEither(schema as Parameters<typeof S.decodeUnknownEither>[0])(input) as Either.Either<
    unknown,
    A
  >
  return Either.isLeft(decoded) ? fallback : decoded.right
}

const normalizeRepo = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const normalizeNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 0
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

const parseRunCompletePayload = (payload: Record<string, unknown>) => {
  const rawData = (payload.data as Record<string, unknown> | string | undefined) ?? payload
  const data = typeof rawData === 'string' ? safeParseJson(rawData) : isRecord(rawData) ? rawData : {}
  const decodedPayload = decodeSchema(RunCompletePayloadSchema, data, {})
  const rawMetadata = isRecord(data.metadata) ? data.metadata : (decodedPayload.metadata ?? {})
  const rawStatus = isRecord(data.status) ? data.status : (decodedPayload.status ?? {})
  const rawArguments = (() => {
    if (isRecord(data.arguments)) return data.arguments
    if (typeof data.arguments === 'string') return safeParseJson(data.arguments)
    return decodedPayload.arguments ?? {}
  })()
  const argumentsRecord = isRecord(rawArguments) ? rawArguments : {}
  const params = decodeSchema(
    ParametersSchema,
    argumentsRecord.parameters ?? decodedPayload.arguments?.parameters ?? [],
    [],
  )

  const eventBodyRaw = getParamValue(params, 'eventBody')
  const eventBody = decodeSchema(EventBodySchema, eventBodyRaw ? decodeBase64Json(eventBodyRaw) : {}, {})
  const repository = normalizeRepo(eventBody.repository ?? eventBody.repo)
  const issueNumber = normalizeNumber(eventBody.issueNumber ?? eventBody.issue_number ?? 0)
  const head = normalizeRepo(eventBody.head) || normalizeRepo(getParamValue(params, 'head'))
  const base = normalizeRepo(eventBody.base) || normalizeRepo(getParamValue(params, 'base'))
  const prompt = typeof eventBody.prompt === 'string' ? eventBody.prompt.trim() : null
  const issueTitle = typeof eventBody.issueTitle === 'string' ? eventBody.issueTitle : null
  const issueBody = typeof eventBody.issueBody === 'string' ? eventBody.issueBody : null
  const issueUrl = typeof eventBody.issueUrl === 'string' ? eventBody.issueUrl : null
  const artifacts = (Array.isArray(data.artifacts) ? data.artifacts : (decodedPayload.artifacts ?? []))
    .map((artifact) => {
      const decoded = decodeSchema(ArtifactSchema, artifact, {})
      const name = decoded.name ?? ''
      const key = decoded.key ?? ''
      if (!name || !key) return null
      return {
        name,
        key,
        bucket: decoded.bucket ?? null,
        url: decoded.url ?? null,
        metadata: isRecord(artifact) ? artifact : {},
      }
    })
    .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))

  return {
    repository,
    issueNumber,
    head,
    base,
    prompt,
    issueTitle,
    issueBody,
    issueUrl,
    workflowName: String(rawMetadata.name ?? ''),
    workflowUid: typeof rawMetadata.uid === 'string' ? rawMetadata.uid : null,
    workflowNamespace: typeof rawMetadata.namespace === 'string' ? rawMetadata.namespace : null,
    stage: typeof decodedPayload.stage === 'string' ? decodedPayload.stage : null,
    phase: typeof rawStatus.phase === 'string' ? rawStatus.phase : null,
    startedAt: typeof rawStatus.startedAt === 'string' ? rawStatus.startedAt : null,
    finishedAt: typeof rawStatus.finishedAt === 'string' ? rawStatus.finishedAt : null,
    artifacts,
    runCompletePayload: data,
  }
}

const parseNotifyPayload = (payload: Record<string, unknown>) => {
  const rawData = (payload.data as Record<string, unknown> | string | undefined) ?? payload
  const data = typeof rawData === 'string' ? safeParseJson(rawData) : rawData
  const workflowName = typeof data.workflow_name === 'string' ? data.workflow_name : ''
  const workflowNamespace = typeof data.workflow_namespace === 'string' ? data.workflow_namespace : null
  const repository = normalizeRepo(data.repository)
  const issueNumber = Number(data.issue_number ?? 0)
  const branch = typeof data.head_branch === 'string' ? data.head_branch.trim() : ''
  const prompt = typeof data.prompt === 'string' ? data.prompt : null
  return { workflowName, workflowNamespace, repository, issueNumber, branch, prompt, notifyPayload: data }
}

const parseRepositoryParts = (repository: string) => {
  const [owner, repo] = repository.split('/')
  if (!owner || !repo) {
    throw new Error(`invalid repository value: ${repository}`)
  }
  return { owner, repo }
}

const scheduleEvaluation = (runId: string, delayMs: number) => {
  const existing = scheduledRuns.get(runId)
  if (existing) {
    clearTimeout(existing)
  }
  const timeout = setTimeout(() => {
    scheduledRuns.delete(runId)
    void evaluateRun(runId)
  }, delayMs)
  scheduledRuns.set(runId, timeout)
}

const updateArtifactsFromWorkflow = async (
  run: CodexRunRecord,
  artifactsOverride?: Array<{
    name: string
    key: string
    bucket?: string | null
    url?: string | null
    metadata?: Record<string, unknown>
  }>,
) => {
  const workflowName = run.workflowName
  if (!workflowName) return []

  const artifacts =
    artifactsOverride && artifactsOverride.length > 0
      ? artifactsOverride
      : [
          { name: 'implementation-changes', suffix: 'implementation-changes.tgz' },
          { name: 'implementation-patch', suffix: 'implementation-patch.tgz' },
          { name: 'implementation-status', suffix: 'implementation-status.tgz' },
          { name: 'implementation-log', suffix: 'implementation-log.tgz' },
          { name: 'implementation-events', suffix: 'implementation-events.tgz' },
          { name: 'implementation-agent-log', suffix: 'implementation-agent-log.tgz' },
          { name: 'implementation-runtime-log', suffix: 'implementation-runtime-log.tgz' },
          { name: 'implementation-resume', suffix: 'implementation-resume.tgz' },
          { name: 'implementation-notify', suffix: 'implementation-notify.tgz' },
        ]

  const bucket = 'argo-workflows'
  const baseKey = `${workflowName}/${workflowName}`

  return store.upsertArtifacts({
    runId: run.id,
    artifacts: artifacts.map((artifact) =>
      'suffix' in artifact
        ? {
            name: artifact.name,
            key: `${baseKey}/${artifact.suffix}`,
            bucket,
            url: null,
            metadata: {},
          }
        : {
            name: artifact.name,
            key: artifact.key,
            bucket: artifact.bucket ?? bucket,
            url: artifact.url ?? null,
            metadata: artifact.metadata ?? {},
          },
    ),
  })
}

const fetchPullRequest = async (run: CodexRunRecord) => {
  const { owner, repo } = parseRepositoryParts(run.repository)
  const head = `${owner}:${run.branch}`
  const pr = await github.getPullRequestByHead(owner, repo, head)
  if (!pr) return null
  const full = await github.getPullRequest(owner, repo, pr.number)
  return {
    ...pr,
    mergeableState: full.mergeableState ?? pr.mergeableState ?? null,
  }
}

const fetchCiStatus = async (run: CodexRunRecord, prSha?: string | null) => {
  const { owner, repo } = parseRepositoryParts(run.repository)
  const sha = prSha ?? run.commitSha
  if (!sha) return { status: 'pending' as const, url: undefined }
  return github.getCheckRuns(owner, repo, sha)
}

const fetchReviewStatus = async (run: CodexRunRecord, prNumber: number) => {
  const { owner, repo } = parseRepositoryParts(run.repository)
  const reviewers = config.codexReviewers.map((value) => value.toLowerCase())
  return github.getReviewSummary(owner, repo, prNumber, reviewers)
}

const extractLogExcerpt = (payload?: Record<string, unknown> | null) => {
  if (!payload) {
    return {
      output: null,
      events: null,
      agent: null,
      runtime: null,
      status: null,
    }
  }
  const raw = payload['log_excerpt']
  if (!raw || typeof raw !== 'object') {
    return {
      output: null,
      events: null,
      agent: null,
      runtime: null,
      status: null,
    }
  }
  const logExcerpt = raw as Record<string, unknown>
  return {
    output: typeof logExcerpt.output === 'string' ? logExcerpt.output : null,
    events: typeof logExcerpt.events === 'string' ? logExcerpt.events : null,
    agent: typeof logExcerpt.agent === 'string' ? logExcerpt.agent : null,
    runtime: typeof logExcerpt.runtime === 'string' ? logExcerpt.runtime : null,
    status: typeof logExcerpt.status === 'string' ? logExcerpt.status : null,
  }
}

const normalizeReviewBody = (value: string) => value.replace(/\s+/g, ' ').trim()

const formatReviewThreads = (threads: ReviewSummary['unresolvedThreads']) => {
  if (threads.length === 0) return 'None.'

  return threads
    .map((thread, index) => {
      const author = thread.author ?? 'unknown'
      const comments =
        thread.comments.length > 0
          ? thread.comments
              .map((comment) => {
                const location = comment.path
                  ? `${comment.path}${comment.line ? `:${comment.line}` : ''}`
                  : 'location not provided'
                const body = comment.body ? normalizeReviewBody(comment.body) : 'no comment body provided'
                const truncated = body.length > 240 ? `${body.slice(0, 237)}...` : body
                return `- ${location}: ${truncated}`
              })
              .join('\n')
          : '- no comment text captured'
      return `Thread ${index + 1} (author: ${author})\n${comments}`
    })
    .join('\n\n')
}

const buildReviewNextPrompt = (threads: ReviewSummary['unresolvedThreads']) => {
  const threadSummary = formatReviewThreads(threads)
  return [
    'Address all Codex review comments and resolve every open review thread.',
    'Make the requested code changes, update the PR description if needed, and reply on each thread with what changed.',
    '',
    'Open Codex review threads:',
    threadSummary,
  ].join('\n')
}

const buildJudgePrompt = (input: {
  issueTitle: string
  issueBody: string
  prTitle: string
  prBody: string | null
  diff: string
  summary: string | null
  ciStatus: string
  reviewStatus: string
  logExcerpt: ReturnType<typeof extractLogExcerpt>
}) => {
  const logs = [
    `Status log:\n${input.logExcerpt.status ?? 'n/a'}`,
    `Output log:\n${input.logExcerpt.output ?? 'n/a'}`,
    `Agent log:\n${input.logExcerpt.agent ?? 'n/a'}`,
    `Runtime log:\n${input.logExcerpt.runtime ?? 'n/a'}`,
    `Event log:\n${input.logExcerpt.events ?? 'n/a'}`,
  ].join('\n\n')

  return [
    'You are the Codex judge. Evaluate whether the implementation satisfies the issue requirements.',
    'Return JSON only with fields: decision, confidence, requirements_coverage, missing_items, suggested_fixes, next_prompt, prompt_tuning_suggestions, system_improvement_suggestions.',
    "Use decision = 'pass' when requirements are satisfied, otherwise 'fail'.",
    '',
    `CI status: ${input.ciStatus}`,
    `Codex review status: ${input.reviewStatus}`,
    '',
    `Issue: ${input.issueTitle}`,
    input.issueBody,
    '',
    `PR: ${input.prTitle}`,
    input.prBody ?? 'No PR description provided.',
    '',
    'Codex summary (last assistant message):',
    input.summary ?? 'No summary available.',
    '',
    'Log excerpts:',
    logs,
    '',
    'Diff:',
    input.diff || 'No diff available.',
  ].join('\n')
}

const parseJudgeOutput = (raw: string) => {
  const trimmed = raw.trim()
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error('judge output missing JSON object')
  }
  return JSON.parse(match[0]) as Record<string, unknown>
}

const normalizeJudgeDecision = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (['pass', 'approve', 'approved', 'success', 'complete', 'completed'].includes(normalized)) {
    return 'pass'
  }
  if (['fail', 'failed', 'reject', 'rejected'].includes(normalized)) {
    return 'fail'
  }
  return normalized
}

const evaluateRun = async (runId: string) => {
  const run = await store.getRunById(runId)
  if (!run) return

  if (run.status === 'completed' || run.status === 'needs_human') return

  await store.updateRunStatus(run.id, 'judging')

  const pr = await fetchPullRequest(run)
  if (!pr) {
    const evaluation = await store.updateDecision({
      runId: run.id,
      decision: 'needs_iteration',
      reasons: { error: 'missing_pull_request' },
      suggestedFixes: { fix: 'Ensure PR exists for branch before completion.' },
      nextPrompt: 'Open a PR for the current branch and ensure all required checks run.',
      promptTuning: {},
      systemSuggestions: {},
    })
    const refreshedRun = (await store.getRunById(run.id)) ?? run
    await writeMemories(refreshedRun, evaluation)
    await triggerRerun(run, 'missing_pull_request', evaluation)
    return
  }

  await store.updateRunPrInfo(run.id, pr.number, pr.htmlUrl, pr.headSha)

  await store.updateRunPrompt(run.id, run.prompt, run.nextPrompt)

  if (pr.mergeableState === 'dirty') {
    const evaluation = await store.updateDecision({
      runId: run.id,
      decision: 'needs_human',
      reasons: { error: 'merge_conflict' },
      suggestedFixes: { fix: 'Resolve merge conflicts on the branch before resuming.' },
      nextPrompt: 'Resolve merge conflicts on the branch and update the PR.',
      promptTuning: {},
      systemSuggestions: {},
    })
    const refreshedRun = (await store.getRunById(run.id)) ?? run
    await writeMemories(refreshedRun, evaluation)
    if (config.promptTuningEnabled && config.promptTuningRepo) {
      const suggestions = buildSuggestionsFromEvaluation(evaluation)
      await createPromptTuningPr(run, evaluation.nextPrompt ?? '', suggestions)
    }
    await sendDiscordEscalation(run, 'merge_conflict')
    return
  }

  const ci = await fetchCiStatus(run, pr.headSha)
  await store.updateCiStatus({ runId: run.id, status: ci.status, url: ci.url, commitSha: pr.headSha })

  if (ci.status === 'pending') {
    scheduleEvaluation(run.id, config.ciPollIntervalMs)
    return
  }

  if (ci.status === 'failure') {
    const evaluation = await store.updateDecision({
      runId: run.id,
      decision: 'needs_iteration',
      reasons: { error: 'ci_failed', url: ci.url },
      suggestedFixes: { fix: 'Fix CI failures and re-run tests.' },
      nextPrompt: 'Fix CI failures for this PR and ensure all checks are green.',
      promptTuning: {},
      systemSuggestions: {},
    })
    const refreshedRun = (await store.getRunById(run.id)) ?? run
    await writeMemories(refreshedRun, evaluation)
    await triggerRerun(run, 'ci_failed', evaluation)
    return
  }

  const review = await fetchReviewStatus(run, pr.number)
  await store.updateReviewStatus({
    runId: run.id,
    status: review.status,
    summary: {
      unresolvedThreads: review.unresolvedThreads,
      requestedChanges: review.requestedChanges,
      issueComments: review.issueComments,
    },
  })

  if (review.status === 'pending') {
    scheduleEvaluation(run.id, config.reviewPollIntervalMs)
    return
  }

  if (review.requestedChanges || review.unresolvedThreads.length > 0) {
    const evaluation = await store.updateDecision({
      runId: run.id,
      decision: 'needs_iteration',
      reasons: {
        error: review.requestedChanges ? 'codex_review_changes_requested' : 'codex_review_unresolved_threads',
        unresolved: review.unresolvedThreads,
      },
      suggestedFixes: { fix: 'Address Codex review comments and resolve all threads.' },
      nextPrompt: buildReviewNextPrompt(review.unresolvedThreads),
      promptTuning: {},
      systemSuggestions: {},
    })
    const refreshedRun = (await store.getRunById(run.id)) ?? run
    await writeMemories(refreshedRun, evaluation)
    await triggerRerun(run, 'codex_review_changes', evaluation)
    return
  }

  const { owner, repo } = parseRepositoryParts(run.repository)
  const diff = await github.getPullRequestDiff(owner, repo, pr.number)

  const issueTitle = (run.runCompletePayload?.['issueTitle'] as string | undefined) ?? pr.title
  const issueBody = (run.runCompletePayload?.['issueBody'] as string | undefined) ?? ''
  const logExcerpt = extractLogExcerpt(run.notifyPayload)

  const judgePrompt = buildJudgePrompt({
    issueTitle,
    issueBody,
    prTitle: pr.title,
    prBody: pr.body,
    diff,
    summary: (run.notifyPayload?.['last_assistant_message'] as string | null) ?? null,
    ciStatus: ci.status,
    reviewStatus: review.status,
    logExcerpt,
  })

  const client = await Effect.runPromise(getCodexClient({ defaultModel: config.judgeModel }))
  const { text } = await client.runTurn(judgePrompt)

  let judgeOutput: Record<string, unknown>
  try {
    judgeOutput = parseJudgeOutput(text)
  } catch (error) {
    const evaluation = await store.updateDecision({
      runId: run.id,
      decision: 'needs_iteration',
      reasons: { error: 'judge_invalid_json', detail: String(error) },
      suggestedFixes: { fix: 'Retry judge output formatting.' },
      nextPrompt: 'Re-run judge with valid JSON output.',
      promptTuning: {},
      systemSuggestions: {},
    })
    const refreshedRun = (await store.getRunById(run.id)) ?? run
    await writeMemories(refreshedRun, evaluation)
    await triggerRerun(run, 'judge_invalid_json', evaluation)
    return
  }

  const decisionRaw = typeof judgeOutput.decision === 'string' ? judgeOutput.decision : 'fail'
  const decision = normalizeJudgeDecision(decisionRaw)
  const nextPrompt = typeof judgeOutput.next_prompt === 'string' ? judgeOutput.next_prompt : null

  const evaluation = await store.updateDecision({
    runId: run.id,
    decision: decision === 'pass' ? 'pass' : 'needs_iteration',
    confidence: typeof judgeOutput.confidence === 'number' ? judgeOutput.confidence : null,
    reasons: { requirements_coverage: judgeOutput.requirements_coverage ?? [], decision },
    missingItems: { missing_items: judgeOutput.missing_items ?? [] },
    suggestedFixes: { suggested_fixes: judgeOutput.suggested_fixes ?? [] },
    nextPrompt,
    promptTuning: { suggestions: judgeOutput.prompt_tuning_suggestions ?? [] },
    systemSuggestions: { suggestions: judgeOutput.system_improvement_suggestions ?? [] },
  })

  if (decision === 'pass') {
    const updatedRun = (await store.updateRunStatus(run.id, 'completed')) ?? run
    await sendDiscordSuccess(run, pr.htmlUrl, ci.url)
    await writeMemories(updatedRun, evaluation)
    return
  }

  const refreshedRun = (await store.getRunById(run.id)) ?? run
  await writeMemories(refreshedRun, evaluation)
  await triggerRerun(run, 'judge_failed', evaluation)
}

const buildSuggestionsFromEvaluation = (evaluation?: CodexEvaluationRecord) => {
  const promptSuggestions = Array.isArray(
    (evaluation?.promptTuning as Record<string, unknown> | undefined)?.suggestions,
  )
    ? ((evaluation?.promptTuning as Record<string, unknown>).suggestions as string[])
    : []
  const systemSuggestions = Array.isArray(
    (evaluation?.systemSuggestions as Record<string, unknown> | undefined)?.suggestions,
  )
    ? ((evaluation?.systemSuggestions as Record<string, unknown>).suggestions as string[])
    : []

  return {
    promptSuggestions: promptSuggestions.length > 0 ? promptSuggestions : ['Tighten prompt to reduce iteration loops.'],
    systemSuggestions: systemSuggestions.length > 0 ? systemSuggestions : ['Clarify judge gating criteria.'],
  }
}

const triggerRerun = async (run: CodexRunRecord, reason: string, evaluation?: CodexEvaluationRecord) => {
  const attempts = (await store.listRunsByIssue(run.repository, run.issueNumber, run.branch)).length
  const suggestions = buildSuggestionsFromEvaluation(evaluation)

  if (attempts >= config.maxAttempts) {
    await store.updateRunStatus(run.id, 'needs_human')
    if (config.promptTuningEnabled && config.promptTuningRepo) {
      await createPromptTuningPr(run, evaluation?.nextPrompt ?? run.nextPrompt ?? '', suggestions)
    }
    await sendDiscordEscalation(run, reason)
    return
  }

  const nextPrompt = evaluation?.nextPrompt ?? run.nextPrompt
  if (!nextPrompt) {
    await store.updateRunStatus(run.id, 'needs_iteration')
    if (config.promptTuningEnabled && config.promptTuningRepo) {
      await createPromptTuningPr(run, '', suggestions)
    }
    return
  }

  await store.updateRunStatus(run.id, 'needs_iteration')
  const delayIndex = Math.min(Math.max(attempts - 1, 0), config.backoffScheduleMs.length - 1)
  const delayMs = config.backoffScheduleMs[delayIndex] ?? 0
  if (delayMs > 0) {
    setTimeout(() => {
      void submitRerun(run, nextPrompt, attempts + 1, suggestions)
    }, delayMs)
    return
  }
  await submitRerun(run, nextPrompt, attempts + 1, suggestions)
}

const submitRerun = async (
  run: CodexRunRecord,
  prompt: string,
  attempt: number,
  suggestions: { promptSuggestions: string[]; systemSuggestions: string[] },
) => {
  const deliveryId = `jangar-${run.issueNumber}-attempt-${attempt}`

  const { CodexTaskSchema, CodexTaskStage } = await import('./proto/codex_task_pb')
  const { create, toBinary, Timestamp } = await import('@bufbuild/protobuf')

  const message = create(CodexTaskSchema, {
    stage: CodexTaskStage.IMPLEMENTATION,
    prompt,
    repository: run.repository,
    base: typeof run.runCompletePayload?.['base'] === 'string' ? String(run.runCompletePayload['base']) : 'main',
    head: run.branch,
    issueNumber: BigInt(run.issueNumber),
    issueUrl:
      typeof run.runCompletePayload?.['issueUrl'] === 'string'
        ? String(run.runCompletePayload['issueUrl'])
        : `https://github.com/${run.repository}/issues/${run.issueNumber}`,
    issueTitle:
      typeof run.runCompletePayload?.['issueTitle'] === 'string'
        ? String(run.runCompletePayload['issueTitle'])
        : `Issue #${run.issueNumber}`,
    issueBody:
      typeof run.runCompletePayload?.['issueBody'] === 'string' ? String(run.runCompletePayload['issueBody']) : prompt,
    sender: 'jangar',
    issuedAt: Timestamp.fromDate(new Date()),
    deliveryId,
  })

  const payload = toBinary(CodexTaskSchema, message)

  await fetch(`${config.facteurBaseUrl}/codex/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body: payload,
  })

  if (config.promptTuningEnabled && config.promptTuningRepo) {
    await createPromptTuningPr(run, prompt, suggestions)
  }
}

const createPromptTuningPr = async (
  run: CodexRunRecord,
  nextPrompt: string,
  suggestions: { promptSuggestions: string[]; systemSuggestions: string[] },
) => {
  if (!config.promptTuningRepo) return
  const { owner, repo } = parseRepositoryParts(config.promptTuningRepo)
  const baseRef = 'main'
  const branch = `codex/prompt-tuning-${run.issueNumber}-${Date.now()}`
  const baseSha = await github.getRefSha(owner, repo, `heads/${baseRef}`)
  await github.createBranch({ owner, repo, branch, baseSha })

  const promptPath = 'apps/froussard/src/codex.ts'
  const promptFile = await github.getFile(owner, repo, promptPath, baseRef)
  const promptInsert = suggestions.promptSuggestions.map((entry) => `    '- ${entry}',`).join('\n')
  const marker = "    'Memory:',"
  const updatedPrompt = promptFile.content.replace(marker, `    '',\n    'Prompt tuning:',\n${promptInsert}\n${marker}`)

  await github.updateFile({
    owner,
    repo,
    path: promptPath,
    branch,
    message: `docs(prompt): tune codex prompt for issue ${run.issueNumber}`,
    content: updatedPrompt,
    sha: promptFile.sha,
  })

  const tuningDocPath = `docs/jangar/prompt-tuning/${run.issueNumber}-${Date.now()}.md`
  const tuningDocContent = [
    `# Prompt tuning for ${run.repository}#${run.issueNumber}`,
    '',
    '## Next prompt',
    nextPrompt,
    '',
    '## Suggestions',
    ...suggestions.promptSuggestions.map((entry) => `- ${entry}`),
    '',
    '## System improvements',
    ...suggestions.systemSuggestions.map((entry) => `- ${entry}`),
  ].join('\n')

  await github
    .updateFile({
      owner,
      repo,
      path: tuningDocPath,
      branch,
      message: `docs(prompt): add tuning context for issue ${run.issueNumber}`,
      content: tuningDocContent,
    })
    .catch(() => {
      // ignore if doc already exists
    })

  let prBody = `## Summary\n- Automated prompt tuning from Jangar\n\n## Related Issues\n- #${run.issueNumber}\n\n## Testing\n- N/A (prompt update)\n\n## Screenshots (if applicable)\n- N/A\n\n## Breaking Changes\n- None\n`
  try {
    const prTemplate = await github.getFile(owner, repo, '.github/PULL_REQUEST_TEMPLATE.md', baseRef)
    prBody = prTemplate.content
      .replace('## Summary', '## Summary\n- Automated prompt tuning from Jangar')
      .replace('## Related Issues', `## Related Issues\n- #${run.issueNumber}`)
      .replace('## Testing', '## Testing\n- N/A (prompt update)')
      .replace('## Screenshots (if applicable)', '## Screenshots (if applicable)\n- N/A')
      .replace('## Breaking Changes', '## Breaking Changes\n- None')
  } catch {
    // fallback to default body
  }

  const pr = (await github.createPullRequest({
    owner,
    repo,
    head: branch,
    base: baseRef,
    title: `docs(prompt): tune codex prompt for #${run.issueNumber}`,
    body: prBody,
  })) as Record<string, unknown>

  const prUrl = typeof pr.html_url === 'string' ? pr.html_url : ''
  if (prUrl) {
    await store.createPromptTuning(run.id, prUrl, 'open', {
      promptSuggestions: suggestions.promptSuggestions,
      systemSuggestions: suggestions.systemSuggestions,
    })
  }
}

const sendDiscordSuccess = async (run: CodexRunRecord, prUrl?: string, ciUrl?: string) => {
  if (!config.discordBotToken || !config.discordChannelId) return
  const content = [
    `✅ Codex completed ${run.repository}#${run.issueNumber}.`,
    prUrl ? `PR: ${prUrl}` : null,
    ciUrl ? `CI: ${ciUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  await fetch(`${config.discordApiBaseUrl}/channels/${config.discordChannelId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bot ${config.discordBotToken}`,
    },
    body: JSON.stringify({ content }),
  })
}

const sendDiscordEscalation = async (run: CodexRunRecord, reason: string) => {
  if (!config.discordBotToken || !config.discordChannelId) return
  const content = `⚠️ Codex needs human help for ${run.repository}#${run.issueNumber}. Reason: ${reason}`
  await fetch(`${config.discordApiBaseUrl}/channels/${config.discordChannelId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bot ${config.discordBotToken}`,
    },
    body: JSON.stringify({ content }),
  })
}

const writeMemories = async (run: CodexRunRecord, evaluation: CodexEvaluationRecord) => {
  let memoryStore: ReturnType<typeof createPostgresMemoriesStore> | null = null
  try {
    memoryStore = createPostgresMemoriesStore()
    const namespace = `codex:${run.repository}:${run.issueNumber}`
    const tags = ['codex', run.repository, `issue-${run.issueNumber}`, run.status]
    const logExcerpt = extractLogExcerpt(run.notifyPayload)

    const snapshots = [
      {
        summary: 'Run summary',
        content: `Status: ${run.status} CI: ${run.ciStatus}\nStatus log:\n${logExcerpt.status ?? 'n/a'}`,
      },
      { summary: 'Decision', content: JSON.stringify(evaluation, null, 2) },
      { summary: 'Prompt', content: run.prompt ?? '' },
      { summary: 'Next prompt', content: run.nextPrompt ?? '' },
      { summary: 'Output log excerpt', content: logExcerpt.output ?? 'n/a' },
      { summary: 'Agent log excerpt', content: logExcerpt.agent ?? 'n/a' },
      { summary: 'Runtime log excerpt', content: logExcerpt.runtime ?? 'n/a' },
      { summary: 'Event log excerpt', content: logExcerpt.events ?? 'n/a' },
      { summary: 'Review status', content: JSON.stringify(run.reviewSummary ?? {}, null, 2) },
      { summary: 'PR info', content: run.prUrl ?? 'no PR' },
    ]

    for (const snapshot of snapshots) {
      await memoryStore.persist({
        namespace,
        content: snapshot.content || 'n/a',
        summary: snapshot.summary,
        tags,
      })
    }
  } catch (error) {
    console.warn('Failed to persist Codex judge memories', error)
  } finally {
    if (memoryStore) {
      try {
        await memoryStore.close()
      } catch (error) {
        console.warn('Failed to close Codex judge memories store', error)
      }
    }
  }
}

export const handleRunComplete = async (payload: Record<string, unknown>) => {
  const parsed = parseRunCompletePayload(payload)
  if (!parsed.repository || !parsed.issueNumber || !parsed.head) {
    return null
  }

  const run = await store.upsertRunComplete({
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    branch: parsed.head,
    workflowName: parsed.workflowName,
    workflowUid: parsed.workflowUid,
    workflowNamespace: parsed.workflowNamespace,
    stage: parsed.stage,
    status: 'run_complete',
    phase: parsed.phase,
    prompt: parsed.prompt,
    runCompletePayload: {
      ...parsed.runCompletePayload,
      issueTitle: parsed.issueTitle,
      issueBody: parsed.issueBody,
      issueUrl: parsed.issueUrl,
      base: parsed.base,
      head: parsed.head,
    },
    startedAt: parsed.startedAt,
    finishedAt: parsed.finishedAt,
  })

  await updateArtifactsFromWorkflow(run, parsed.artifacts)
  scheduleEvaluation(run.id, 1000)

  return run
}

export const handleNotify = async (payload: Record<string, unknown>) => {
  const parsed = parseNotifyPayload(payload)
  if (!parsed.workflowName) {
    throw new Error('notify payload missing workflow name')
  }

  const run = await store.attachNotify({
    workflowName: parsed.workflowName,
    workflowNamespace: parsed.workflowNamespace,
    notifyPayload: parsed.notifyPayload,
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    branch: parsed.branch,
    prompt: parsed.prompt,
  })

  if (run && run.status === 'run_complete') {
    scheduleEvaluation(run.id, 1000)
  }

  return run
}
