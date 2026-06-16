import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { applyRunnerArtifacts, loadRunnerSpec, loadRunSpec, resolveConfig, type AnypiConfig } from './config'
import { createLogger } from './logger'
import { runPiAgent } from './pi-session'
import { buildAgentPrompt, buildValidationRepairPrompt, resolveValidationCommands } from './prompt'
import {
  commitIfNeeded,
  countCommitsAhead,
  createOrUpdatePullRequest,
  gitStatusShort,
  prepareRepository,
  pushBranch,
  resolveGitContext,
  runValidationCommands,
  type GitContext,
} from './git'
import type { AgentRunSpecPayload, AnypiStatus, PullRequestResult, ValidationResult } from './types'

const timestampUtc = () => new Date().toISOString()

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const writeStatus = async (path: string, status: AnypiStatus) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
}

const buildCommitMessage = (runSpec: AgentRunSpecPayload) => {
  const summary = runSpec.implementation?.summary?.trim() || runSpec.issueTitle?.trim() || runSpec.agentRun?.name
  return `feat(anypi): ${summary ? summary.slice(0, 80) : 'implement agent task'}`
}

const buildPullRequestTitle = (runSpec: AgentRunSpecPayload) => {
  const title =
    process.env.VCS_PR_TITLE_TEMPLATE?.trim() || runSpec.issueTitle?.trim() || runSpec.implementation?.summary?.trim()
  return title ? `feat(anypi): ${title.slice(0, 80)}` : 'feat(anypi): apply autonomous agent changes'
}

const buildPullRequestBody = (input: {
  runSpec: AgentRunSpecPayload
  status: AnypiStatus
  git: GitContext
  piText: string
}) => {
  const validations = input.status.validations
    .map((result) => `- \`${[result.command, ...result.args].join(' ')}\` exit ${result.exitCode}`)
    .join('\n')
  return `## Summary
Anypi generated this change using Pi SDK against Flamingo.

AgentRun: ${input.status.namespace ?? 'agents'}/${input.status.runName ?? 'unknown'}
Model: ${input.status.providerModel}
Session: ${input.status.sessionFile ?? 'N/A'}

## Validation
${validations || 'No validation commands were configured.'}

## Agent Output
${input.piText.trim().slice(0, 6000) || 'N/A'}
`
}

const baseStatus = (config: AnypiConfig, runSpec: AgentRunSpecPayload, git: GitContext | null): AnypiStatus => ({
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
  tools: [],
  validations: [],
  validationAttempts: 0,
  promptChars: 0,
})

const mergeTools = (left: string[], right: string[]) => [...new Set([...left, ...right])]

const failedValidation = (results: ValidationResult[]) => results.find((result) => !result.ok)

const formatValidationError = (result: ValidationResult) =>
  `validation failed (${result.exitCode}): ${[result.command, ...result.args].join(' ')}`

export const runAnypi = async (env: NodeJS.ProcessEnv = process.env): Promise<AnypiStatus> => {
  let config = resolveConfig(env)
  const runnerSpec = await loadRunnerSpec(config)
  config = applyRunnerArtifacts(config, runnerSpec)
  const logger = await createLogger(config.logPath)
  const runSpec = await loadRunSpec(config)
  const git = await resolveGitContext(config, runSpec)
  const status = baseStatus(config, runSpec, git)

  try {
    await writeStatus(config.statusPath, status)
    await logger.info(`starting Anypi for ${status.runName ?? 'unknown run'}`)
    await prepareRepository(config, git, logger.info)
    const prompt = buildAgentPrompt(runSpec, config.worktree)
    status.promptChars = prompt.length

    let piResult = await runPiAgent(config, prompt, logger.info)
    let piText = piResult.text
    const sessionFiles = piResult.sessionFile ? [piResult.sessionFile] : []
    status.tools = piResult.tools
    status.sessionFile = piResult.sessionFile
    status.sessionFiles = sessionFiles

    const changed = await gitStatusShort(config.worktree, git?.env)
    const commitsAhead = git ? await countCommitsAhead(git) : 0
    if (!changed && git && commitsAhead === 0) {
      throw new Error('Anypi completed without leaving code changes in the worktree')
    }

    const validationCommands = resolveValidationCommands(runSpec, config.validationCommands)
    let validationResults: ValidationResult[] = []
    for (let attempt = 0; attempt <= config.validationRepairAttempts; attempt += 1) {
      const rawResults = await runValidationCommands(validationCommands, git, config.worktree, logger.info)
      validationResults = rawResults.map((result): ValidationResult => ({ ...result, ok: result.exitCode === 0 }))
      status.validationAttempts = attempt + 1
      status.validations = validationResults
      await writeStatus(config.statusPath, status)

      const failed = failedValidation(validationResults)
      if (!failed) break
      if (attempt >= config.validationRepairAttempts) throw new Error(formatValidationError(failed))

      await logger.error(
        `${formatValidationError(failed)}; starting validation repair ${attempt + 1}/${config.validationRepairAttempts}`,
      )
      const repairPrompt = buildValidationRepairPrompt({
        attempt: attempt + 1,
        maxAttempts: config.validationRepairAttempts,
        worktree: config.worktree,
        results: validationResults,
      })
      const repairResult = await runPiAgent(config, repairPrompt, logger.info)
      piText = `${piText}\n\n## Validation repair ${attempt + 1}\n${repairResult.text}`
      status.tools = mergeTools(status.tools, repairResult.tools)
      if (repairResult.sessionFile) {
        sessionFiles.push(repairResult.sessionFile)
        status.sessionFile = repairResult.sessionFile
        status.sessionFiles = sessionFiles
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
        body: buildPullRequestBody({ runSpec, status, git, piText }),
      })
      status.pullRequest = pullRequest
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
    await writeStatus(config.statusPath, status)
    await logger.error(status.error)
    throw error
  }
}
