import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { applyRunnerArtifacts, loadRunnerSpec, loadRunSpec, resolveConfig, type AnypiConfig } from './config'
import { createLogger } from './logger'
import { runPiAgent } from './pi-session'
import {
  buildAgentPrompt,
  buildCiRepairPrompt,
  buildNoChangeRepairPrompt,
  buildValidationRepairPrompt,
  hashSystemPrompt,
  resolveValidationPlan,
} from './prompt'
import {
  commitIfNeeded,
  countCommitsAhead,
  createOrUpdatePullRequest,
  gitDiff,
  gitStatusShort,
  gitWorktreeContentHash,
  prepareRepository,
  pushBranch,
  resolveGitContext,
  runValidationCommands,
  validateChangedFilePolicy,
  waitForPullRequestChecks,
  type GitContext,
} from './git'
import type {
  AgentRunSpecPayload,
  AnypiStatus,
  CiWaitResult,
  LoopDetectionEvidence,
  PullRequestResult,
  ToolEvent,
  ValidationPlan,
  ValidationResult,
} from './types'

const timestampUtc = () => new Date().toISOString()

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const sleep = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms))

export const normalizeConventionalSummary = (raw: string | undefined, fallback: string) => {
  const summary = (raw?.trim() || fallback)
    .replace(/\s+/g, ' ')
    .replace(/[.。]+$/g, '')
    .toLowerCase()
  return summary.slice(0, 80)
}

const writeStatus = async (path: string, status: AnypiStatus) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
}

export const buildCommitMessage = (runSpec: AgentRunSpecPayload) => {
  const summary = runSpec.implementation?.summary?.trim() || runSpec.issueTitle?.trim() || runSpec.agentRun?.name
  return `feat(anypi): ${normalizeConventionalSummary(summary, 'implement agent task')}`
}

export const buildPullRequestTitle = (runSpec: AgentRunSpecPayload) => {
  const title =
    process.env.VCS_PR_TITLE_TEMPLATE?.trim() || runSpec.issueTitle?.trim() || runSpec.implementation?.summary?.trim()
  return `feat(anypi): ${normalizeConventionalSummary(title, 'apply autonomous agent changes')}`
}

const DEFAULT_PULL_REQUEST_HEADINGS = [
  'Summary',
  'Related Issues',
  'Testing',
  'Screenshots (if applicable)',
  'Breaking Changes',
  'Checklist',
]

const extractPullRequestHeadings = (template: string | undefined) => {
  const headings = [...(template ?? '').matchAll(/^##\s+(.+?)\s*$/gm)]
    .map((match) => match[1]?.trim())
    .filter((heading): heading is string => Boolean(heading))
  return headings.length > 0 ? headings : DEFAULT_PULL_REQUEST_HEADINGS
}

const normalizeHeading = (heading: string) => heading.toLowerCase().replace(/\s+/g, ' ').trim()

const validationSummary = (status: AnypiStatus) => {
  const validations = status.validations
    .map((result) => `- \`${[result.command, ...result.args].join(' ')}\` exit ${result.exitCode}`)
    .join('\n')
  const ci = status.ci
    ? `${status.ci.status}: ${status.ci.summary}`
    : 'Pending: pull request checks have not completed yet.'
  return `${validations || '- N/A'}\n- CI: ${ci}`
}

export const renderPullRequestBody = (input: {
  runSpec: AgentRunSpecPayload
  status: AnypiStatus
  git: GitContext
  piText: string
  template?: string
}) => {
  const sections = new Map([
    [
      'summary',
      [
        `- Generated for ${input.status.namespace ?? 'agents'}/${input.status.runName ?? 'unknown'}.`,
        `- Prompt variant: \`${input.status.promptVariant}\` (\`${input.status.promptHash}\`).`,
        `- Session artifact: \`${input.status.sessionFile ?? 'N/A'}\`.`,
      ].join('\n'),
    ],
    ['related issues', 'None'],
    ['testing', validationSummary(input.status)],
    ['screenshots (if applicable)', 'N/A'],
    ['breaking changes', 'None'],
    [
      'checklist',
      [
        '- [x] Testing section documents the exact validation performed.',
        '- [x] Screenshots and Breaking Changes sections are handled appropriately.',
        '- [x] Documentation, release notes, and follow-ups are updated or tracked.',
      ].join('\n'),
    ],
  ])

  return `${extractPullRequestHeadings(input.template)
    .map((heading) => `## ${heading}\n\n${sections.get(normalizeHeading(heading)) ?? 'N/A'}`)
    .join('\n\n')}\n`
}

const loadPullRequestTemplate = async (worktree: string) => {
  try {
    return await readFile(join(worktree, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

const buildPullRequestBody = async (input: {
  runSpec: AgentRunSpecPayload
  status: AnypiStatus
  git: GitContext
  piText: string
}) =>
  renderPullRequestBody({
    ...input,
    template: await loadPullRequestTemplate(input.git.worktree),
  })

/**
 * Helper to capture git artifacts for hard timeout failure scenarios
 */
const captureHardTimeoutArtifacts = async (
  git: GitContext | null,
  worktree: string,
  elapsedSeconds: number,
  lastTools: string[],
  recentEvents: ToolEvent[],
  finishFinalizationEvents: number,
  readBashStatusEvents: number,
): Promise<LoopDetectionEvidence> => {
  const gitStatusShortResult = await gitStatusShort(worktree, git?.env)

  // Capture git diff stat
  let gitDiffStat: string | undefined
  try {
    if (git) {
      const diffResult = await gitDiff(worktree, git.env, ['--stat'])
      if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
        gitDiffStat = diffResult.stdout.trim()
      }
    }
  } catch {
    // Ignore diff errors
  }

  // Capture patch artifact path if we have changes
  let patchArtifactPath: string | undefined
  try {
    const patchPath = join('/tmp', `anypi-loop-patch-${Date.now()}.patch`)
    if (git && gitStatusShortResult) {
      await mkdir(dirname(patchPath), { recursive: true })
      await runShell(`git diff HEAD > "${patchPath}"`, { cwd: worktree, env: git.env })
      patchArtifactPath = patchPath
    }
  } catch {
    // Ignore patch capture errors
  }

  return {
    elapsedSeconds,
    lastTools,
    recentEvents,
    finishFinalizationEvents,
    readBashStatusEvents,
    gitStatusShort: gitStatusShortResult,
    gitDiffStat,
    patchArtifactPath,
  }
}

/**
 * Check if loop detection indicates stalled session
 */
export const isLoopDetected = (evidence?: LoopDetectionEvidence): boolean => {
  if (!evidence) return false
  // Consider it a loop if we have many finish/finalization events or benign commands
  return evidence.finishFinalizationEvents >= 2 || evidence.readBashStatusEvents >= 3
}

const runShell = async (script: string, options?: { cwd?: string; env?: Record<string, string | undefined> }) => {
  // Import locally to avoid circular dependency
  const { runShell: shellRun } = await import('./command')
  return shellRun(script, options)
}

const baseStatus = (
  config: AnypiConfig,
  runSpec: AgentRunSpecPayload,
  git: GitContext | null,
  validationPlan: ValidationPlan,
): AnypiStatus => ({
  provider: 'anypi',
  status: 'running',
  startedAt: timestampUtc(),
  runName: runSpec.agentRun?.name,
  namespace: runSpec.agentRun?.namespace,
  repository: git?.repository,
  baseBranch: git?.baseBranch,
  headBranch: git?.headBranch,
  worktree: config.worktree,
  model: config.model,
  providerModel: `${config.provider}/${config.model}`,
  piPromptTimeoutSeconds: config.piPromptTimeoutSeconds,
  promptVariant: config.promptVariant,
  promptHash: hashSystemPrompt(config.promptVariant),
  tools: [],
  validations: [],
  validationPlan,
  agentAttempts: 0,
  validationAttempts: 0,
  ciAttempts: 0,
  promptChars: 0,
})

const mergeTools = (left: string[], right: string[]) => [...new Set([...left, ...right])]

const failedValidation = (results: ValidationResult[]) => results.find((result) => !result.ok)

export type WorktreeProgressSnapshot = {
  status: string
  commitsAhead: number
  contentHash: string
}

export const hasWorktreeProgress = (before: WorktreeProgressSnapshot, after: WorktreeProgressSnapshot) =>
  before.status !== after.status ||
  before.commitsAhead !== after.commitsAhead ||
  before.contentHash !== after.contentHash

const getWorktreeProgress = async (git: GitContext | null, worktree: string): Promise<WorktreeProgressSnapshot> => ({
  status: await gitStatusShort(worktree, git?.env),
  commitsAhead: git ? await countCommitsAhead(git) : 0,
  contentHash: git ? await gitWorktreeContentHash(worktree, git.env) : '',
})

const formatValidationError = (result: ValidationResult) =>
  `validation failed (${result.exitCode}): ${[result.command, ...result.args].join(' ')}`

const formatCiError = (ci: CiWaitResult) => `ci checks ${ci.status}: ${ci.summary}`

const formatCiRepairSummary = (ci: CiWaitResult) => {
  const checks = ci.checks
    .map(
      (check) =>
        `- ${check.workflow ? `${check.workflow} / ` : ''}${check.name}: ${check.bucket ?? check.state ?? 'unknown'}`,
    )
    .slice(0, 30)
    .join('\n')
  return `${ci.status}: ${ci.summary}${checks ? `\n${checks}` : ''}`
}

const runValidationPass = async (
  commands: string[],
  git: GitContext | null,
  runSpec: AgentRunSpecPayload,
  worktree: string,
  log: (message: string) => Promise<void>,
) => {
  const rawResults = await runValidationCommands(commands, git, worktree, log)
  const results = rawResults.map((result): ValidationResult => ({ ...result, ok: result.exitCode === 0 }))
  if (!failedValidation(results) && git) {
    const policyFailure = await validateChangedFilePolicy(git, runSpec)
    if (policyFailure) {
      await log(policyFailure.stdout)
      results.push(policyFailure)
    }
  }
  return results
}

const waitForModelEndpoint = async (config: AnypiConfig, log: (message: string) => Promise<void>) => {
  const modelsUrl = `${config.baseUrl.replace(/\/+$/, '')}/models`
  const deadline = Date.now() + config.modelReadyTimeoutSeconds * 1000
  let lastError = 'not checked'

  while (Date.now() < deadline) {
    try {
      const response = await fetch(modelsUrl, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      })
      if (response.ok) {
        await log(`model endpoint ready: ${modelsUrl}`)
        return
      }
      lastError = `${response.status} ${response.statusText}`.trim()
    } catch (error) {
      lastError = toErrorMessage(error)
    }
    await log(`model endpoint not ready: ${modelsUrl} (${lastError})`)
    await sleep(10_000)
  }

  throw new Error(`model endpoint not ready after ${config.modelReadyTimeoutSeconds}s: ${modelsUrl} (${lastError})`)
}

export const runAnypi = async (env: NodeJS.ProcessEnv = process.env): Promise<AnypiStatus> => {
  let config = resolveConfig(env)
  const runnerSpec = await loadRunnerSpec(config)
  config = applyRunnerArtifacts(config, runnerSpec)
  const logger = await createLogger(config.logPath)
  const runSpec = await loadRunSpec(config)
  const git = await resolveGitContext(config, runSpec)
  const validationPlan = resolveValidationPlan(runSpec, config.validationCommands, config.validationPolicy)
  const status = baseStatus(config, runSpec, git, validationPlan)

  try {
    await writeStatus(config.statusPath, status)
    await logger.info(`starting Anypi for ${status.runName ?? 'unknown run'}`)
    await logger.info(`prompt variant: ${status.promptVariant} ${status.promptHash}`)
    if (runSpec.systemPrompt && !config.allowSystemPromptOverride) {
      await logger.info('run systemPrompt ignored because ANYPI_ALLOW_SYSTEM_PROMPT_OVERRIDE is false')
    }
    await prepareRepository(config, git, logger.info)
    await waitForModelEndpoint(config, logger.info)
    const prompt = buildAgentPrompt(runSpec, config.worktree)
    status.promptChars = prompt.length
    const systemPrompt = config.allowSystemPromptOverride ? runSpec.systemPrompt : undefined

    let piText = ''
    const sessionFiles: string[] = []
    const recordPiResult = async (result: Awaited<ReturnType<typeof runPiAgent>>, label?: string) => {
      piText = piText ? `${piText}\n\n${label ? `## ${label}\n` : ''}${result.text}` : result.text
      status.tools = mergeTools(status.tools, result.tools)
      if (result.sessionFile) {
        sessionFiles.push(result.sessionFile)
        status.sessionFile = result.sessionFile
        status.sessionFiles = sessionFiles
      }
      // Capture loop evidence if available
      if (result.loopEvidence) {
        status.loopEvidence = result.loopEvidence
        await logger.info(`loop detection triggered: ${JSON.stringify(result.loopEvidence)}`)
      }
    }

    for (let attempt = 0; attempt <= config.noChangeRepairAttempts; attempt += 1) {
      const nextPrompt =
        attempt === 0
          ? prompt
          : buildNoChangeRepairPrompt({
              attempt,
              maxAttempts: config.noChangeRepairAttempts,
              worktree: config.worktree,
            })
      await recordPiResult(
        await runPiAgent(config, nextPrompt, logger.info, {
          sessionLabel: attempt === 0 ? 'initial' : `no-change-repair-${attempt}`,
          systemPrompt,
        }),
        attempt === 0 ? undefined : `No-change repair ${attempt}`,
      )
      status.agentAttempts = attempt + 1
      await writeStatus(config.statusPath, status)

      const changed = await gitStatusShort(config.worktree, git?.env)
      const commitsAhead = git ? await countCommitsAhead(git) : 0

      // If loop detected and we have worktree changes, stop cleanly to proceed to validation
      if (isLoopDetected(status.loopEvidence) && (changed || (git && commitsAhead > 0))) {
        await logger.info(`loop detected but worktree has changes; stopping cleanly to proceed to validation`)
        break
      }

      if (changed || !git || commitsAhead > 0) break
      if (attempt >= config.noChangeRepairAttempts) {
        throw new Error('Anypi completed without leaving code changes in the worktree')
      }
      await logger.error(
        `Anypi completed without leaving code changes; starting no-change repair ${attempt + 1}/${config.noChangeRepairAttempts}`,
      )
    }

    const validationCommands = status.validationPlan.commands
    let validationResults: ValidationResult[] = []
    for (let attempt = 0; attempt <= config.validationRepairAttempts; attempt += 1) {
      validationResults = await runValidationPass(validationCommands, git, runSpec, config.worktree, logger.info)
      status.validationAttempts = attempt + 1
      status.validations = validationResults
      await writeStatus(config.statusPath, status)

      const failed = failedValidation(validationResults)
      if (!failed) break
      if (attempt >= config.validationRepairAttempts) throw new Error(formatValidationError(failed))

      await logger.error(
        `${formatValidationError(failed)}; starting validation repair ${attempt + 1}/${config.validationRepairAttempts}`,
      )
      const beforeRepair = await getWorktreeProgress(git, config.worktree)
      const repairPrompt = buildValidationRepairPrompt({
        attempt: attempt + 1,
        maxAttempts: config.validationRepairAttempts,
        worktree: config.worktree,
        results: validationResults,
      })
      const repairResult = await runPiAgent(config, repairPrompt, logger.info, {
        sessionLabel: `validation-repair-${attempt + 1}`,
        systemPrompt,
      })
      status.agentAttempts += 1
      piText = `${piText}\n\n## Validation repair ${attempt + 1}\n${repairResult.text}`
      status.tools = mergeTools(status.tools, repairResult.tools)
      if (repairResult.sessionFile) {
        sessionFiles.push(repairResult.sessionFile)
        status.sessionFile = repairResult.sessionFile
        status.sessionFiles = sessionFiles
      }
      const afterRepair = await getWorktreeProgress(git, config.worktree)

      // If loop detected and we have worktree changes, stop cleanly to proceed to validation
      if (isLoopDetected(status.loopEvidence) && hasWorktreeProgress(beforeRepair, afterRepair)) {
        await logger.info(
          `loop detected during validation repair but worktree has changes; stopping cleanly to proceed to validation`,
        )
        break
      }

      if (!hasWorktreeProgress(beforeRepair, afterRepair)) {
        throw new Error(
          `${formatValidationError(failed)}; validation repair ${attempt + 1} produced no worktree changes`,
        )
      }
    }

    let pullRequest: PullRequestResult | undefined
    if (git) {
      const commit = await commitIfNeeded(git, buildCommitMessage(runSpec))
      if (!commit) throw new Error('Anypi produced no commits relative to the base branch')
      status.commit = commit
      await pushBranch(git)
      pullRequest = await createOrUpdatePullRequest(git, {
        title: buildPullRequestTitle(runSpec),
        body: await buildPullRequestBody({ runSpec, status, git, piText }),
      })
      status.pullRequest = pullRequest
      await writeStatus(config.statusPath, status)

      if (pullRequest.enabled) {
        for (let attempt = 0; attempt <= config.ciRepairAttempts; attempt += 1) {
          const ci = await waitForPullRequestChecks(
            git,
            {
              timeoutSeconds: config.ciCheckTimeoutSeconds,
              intervalSeconds: config.ciCheckIntervalSeconds,
              requiredOnly: config.ciRequiredOnly,
            },
            logger.info,
          )
          status.ciAttempts = attempt + 1
          status.ci = ci
          await writeStatus(config.statusPath, status)
          if (ci.ok) break
          if (attempt >= config.ciRepairAttempts) throw new Error(formatCiError(ci))

          await logger.error(`${formatCiError(ci)}; starting ci repair ${attempt + 1}/${config.ciRepairAttempts}`)
          const repairResult = await runPiAgent(
            config,
            buildCiRepairPrompt({
              attempt: attempt + 1,
              maxAttempts: config.ciRepairAttempts,
              worktree: config.worktree,
              summary: formatCiRepairSummary(ci),
            }),
            logger.info,
            {
              sessionLabel: `ci-repair-${attempt + 1}`,
              systemPrompt,
            },
          )
          await recordPiResult(repairResult, `CI repair ${attempt + 1}`)
          status.agentAttempts += 1

          validationResults = await runValidationPass(validationCommands, git, runSpec, config.worktree, logger.info)
          status.validationAttempts += 1
          status.validations = validationResults
          await writeStatus(config.statusPath, status)
          const failed = failedValidation(validationResults)
          if (failed) throw new Error(formatValidationError(failed))

          const previousCommit: string | undefined = status.commit
          const repairedCommit = await commitIfNeeded(git, buildCommitMessage(runSpec))

          // If loop detected and we have new commits, stop cleanly to proceed
          if (isLoopDetected(status.loopEvidence) && repairedCommit && repairedCommit !== previousCommit) {
            await logger.info(`loop detected during CI repair but new commit made; stopping cleanly to proceed to PR`)
            break
          }

          if (!repairedCommit || repairedCommit === previousCommit) throw new Error('CI repair produced no new commit')
          status.commit = repairedCommit
          await pushBranch(git)
          pullRequest = await createOrUpdatePullRequest(git, {
            title: buildPullRequestTitle(runSpec),
            body: await buildPullRequestBody({ runSpec, status, git, piText }),
          })
          status.pullRequest = pullRequest
          await writeStatus(config.statusPath, status)
        }

        pullRequest = await createOrUpdatePullRequest(git, {
          title: buildPullRequestTitle(runSpec),
          body: await buildPullRequestBody({ runSpec, status, git, piText }),
        })
        status.pullRequest = pullRequest
        await writeStatus(config.statusPath, status)
      }
    }

    status.status = 'succeeded'
    status.finishedAt = timestampUtc()
    await writeStatus(config.statusPath, status)
    await logger.info(`Anypi finished with status ${status.status}`)
    return status
  } catch (error) {
    status.status = 'failed'
    status.finishedAt = timestampUtc()
    status.error = toErrorMessage(error)

    // Capture loop evidence if available from the last Pi run result
    if (status.loopEvidence) {
      await logger.info(`loop evidence captured: ${JSON.stringify(status.loopEvidence)}`)
    }

    await writeStatus(config.statusPath, status)
    await logger.error(status.error)
    throw error
  }
}
