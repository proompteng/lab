import { createHash } from 'node:crypto'

import type { AgentRunSpecPayload, PromptVariant, ValidationPlan, ValidationPolicy, ValidationResult } from './types'

export const PROMPT_VARIANTS = ['minimal', 'finish-gated', 'repair-loop', 'strict-repo'] as const

export const DEFAULT_PROMPT_VARIANT: PromptVariant = 'minimal'

export const resolvePromptVariant = (raw: string | undefined): PromptVariant => {
  const normalized = raw?.trim().toLowerCase()
  if (PROMPT_VARIANTS.some((variant) => variant === normalized)) return normalized as PromptVariant
  return DEFAULT_PROMPT_VARIANT
}

const dedupeCommands = (commands: string[]) => [...new Set(commands.map((command) => command.trim()).filter(Boolean))]

export const resolveTaskPrompt = (runSpec: AgentRunSpecPayload) => {
  const candidates = [runSpec.prompt, runSpec.implementation?.text, runSpec.implementation?.summary]
  for (const candidate of candidates) {
    const text = candidate?.trim()
    if (text) return text
  }
  return JSON.stringify(runSpec, null, 2)
}

export const parseRunValidationCommands = (runSpec: AgentRunSpecPayload) => {
  const raw = runSpec.parameters?.validationCommands
  if (!raw?.trim()) return []
  if (raw.trim().startsWith('[')) {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) throw new Error('parameters.validationCommands must be a JSON array or newline list')
    return parsed.map((entry) => String(entry).trim()).filter(Boolean)
  }
  return raw
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const taskFingerprint = (runSpec: AgentRunSpecPayload) =>
  [
    runSpec.prompt,
    runSpec.implementation?.summary,
    runSpec.implementation?.text,
    runSpec.goal?.objective,
    runSpec.issueTitle,
    runSpec.issueBody,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()

export const inferValidationCommands = (runSpec: AgentRunSpecPayload) => {
  const task = taskFingerprint(runSpec)
  const commands = ['git diff --check']
  if (task.includes('services/torghut') || task.includes('torghut')) {
    commands.push(
      'cd services/torghut && uv sync --frozen --extra dev',
      'cd services/torghut && uv run --frozen ruff format --check app tests scripts migrations',
      'cd services/torghut && uv run --frozen pyright --project pyrightconfig.json',
      'cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json',
      'cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json',
    )
  }
  if (task.includes('services/anypi') || task.includes('anypi')) {
    commands.push(
      'bun run --filter @proompteng/anypi tsc',
      'bun run --filter @proompteng/anypi test',
      'bun run --filter @proompteng/anypi lint',
    )
  }
  if (task.includes('argocd/applications/agents') || task.includes('agentprovider') || task.includes('agentrun')) {
    commands.push('kustomize build --enable-helm argocd/applications/agents >/tmp/anypi-agents.yaml')
  }
  return dedupeCommands(commands)
}

export const resolveValidationPolicy = (raw: string | undefined): ValidationPolicy =>
  raw?.trim().toLowerCase() === 'override' ? 'override' : 'append'

export const resolveValidationPlan = (
  runSpec: AgentRunSpecPayload,
  configuredCommands: string[],
  policy: ValidationPolicy,
): ValidationPlan => {
  const inferredCommands = inferValidationCommands(runSpec)
  const runCommands = parseRunValidationCommands(runSpec)
  const sources: string[] = []
  let commands: string[]

  if (policy === 'override') {
    if (configuredCommands.length > 0) {
      commands = configuredCommands
      sources.push('env')
    } else if (runCommands.length > 0) {
      commands = runCommands
      sources.push('run-spec')
    } else {
      commands = inferredCommands
      sources.push('inferred')
    }
  } else {
    commands = dedupeCommands([...inferredCommands, ...runCommands, ...configuredCommands])
    if (inferredCommands.length > 0) sources.push('inferred')
    if (runCommands.length > 0) sources.push('run-spec')
    if (configuredCommands.length > 0) sources.push('env')
  }

  if (commands.length <= 1 && commands[0] === 'git diff --check') {
    throw new Error('Anypi requires service-aware validation commands; refusing to run only git diff --check')
  }

  return {
    policy,
    sources,
    commands,
  }
}

export const resolveValidationCommands = (runSpec: AgentRunSpecPayload, configuredCommands: string[]) =>
  resolveValidationPlan(runSpec, configuredCommands, 'override').commands

export const buildAgentPrompt = (runSpec: AgentRunSpecPayload, worktree: string) => {
  const task = resolveTaskPrompt(runSpec)
  const parameters = runSpec.parameters ?? {}
  const goal = runSpec.goal?.objective?.trim()
  return `Worktree: ${worktree}
Repository: ${runSpec.vcs?.repository ?? runSpec.repository ?? parameters.repository ?? 'unknown'}
Base branch: ${runSpec.vcs?.baseBranch ?? runSpec.base ?? parameters.base ?? 'main'}
Head branch: ${runSpec.vcs?.headBranch ?? runSpec.head ?? parameters.head ?? 'codex/anypi'}
${goal ? `Goal: ${goal}\n` : ''}
Task rules:
- Use repository instructions and existing patterns.
- Implement the requested change directly.
- Add or update tests when behavior changes.
- Run the checks required for the files you touched.
- Fix validation failures before stopping.
- Do not edit generated files or lockfiles unless the task explicitly requires it.
- Do not commit, push, merge, delete branches, or fake results.
- Leave the final changes in the worktree.

Task:
${task}`
}

const trimOutput = (value: string, maxLength = 6000) => {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed || 'N/A'
  return `${trimmed.slice(0, maxLength)}\n...[truncated]`
}

const formatValidationResult = (result: ValidationResult) => `Command: \`${[result.command, ...result.args].join(' ')}\`
Exit: ${result.exitCode}
stdout:
\`\`\`
${trimOutput(result.stdout)}
\`\`\`
stderr:
\`\`\`
${trimOutput(result.stderr)}
\`\`\``

export const buildValidationRepairPrompt = (input: {
  attempt: number
  maxAttempts: number
  worktree: string
  results: ValidationResult[]
}) => {
  const failures = input.results.filter((result) => !result.ok)
  return `Validation failed after the previous changes.

Worktree: ${input.worktree}
Repair attempt: ${input.attempt} of ${input.maxAttempts}

Fix the repository so every validation command passes. Preserve the requested feature work, do not remove or weaken
tests to make the suite pass, and run the failing command(s) again before stopping. Leave the final code changes in the
worktree.

Failures:
${failures.map(formatValidationResult).join('\n\n')}`
}

export const buildNoChangeRepairPrompt = (input: { attempt: number; maxAttempts: number; worktree: string }) =>
  `The previous attempt completed without leaving any code changes in the git worktree.

Worktree: ${input.worktree}
Repair attempt: ${input.attempt} of ${input.maxAttempts}

The task requires a real implementation. Continue from the repository state now: inspect the requested files, edit
source and tests, run relevant validation, and leave the final changes in the worktree. Do not stop with only analysis
or a summary.`

export const buildCiRepairPrompt = (input: {
  attempt: number
  maxAttempts: number
  worktree: string
  summary: string
}) =>
  `Pull request checks failed after the previous changes.

Worktree: ${input.worktree}
Repair attempt: ${input.attempt} of ${input.maxAttempts}

Inspect the failing CI signal, reproduce the likely failure locally when possible, repair the root cause, run the
relevant validation commands, and leave the final code changes in the worktree. Do not remove or weaken tests, fake
results, or make unrelated refactors.

CI summary:
${input.summary}`

const SYSTEM_PROMPTS: Record<PromptVariant, string> = {
  minimal: `Act as a coding agent inside an existing repository.

Rules:
- Inspect repository instructions and relevant files before editing.
- Keep the solution focused, production-quality, and no broader than the task.
- Add or update tests for changed behavior.
- Run the checks required for touched files; fix failures and rerun them.
- Do not edit generated files or lockfiles unless the task explicitly requires it.
- Do not hard-code for tests, remove tests to pass, fake results, or claim success with failing checks.
- Do not commit, push, merge, or change branches.
- Keep the final response concise: changed files and validation only.`,
  'finish-gated': `Act as a coding agent inside an existing repository.

Rules:
- Inspect repository instructions and relevant files before editing.
- Keep the solution focused, production-quality, and no broader than the task.
- Add or update tests for changed behavior.
- Run the checks required for touched files; fix failures and rerun them.
- Continue until the implementation, tests, and validation are complete.
- Do not edit generated files or lockfiles unless the task explicitly requires it.
- Do not hard-code for tests, remove tests to pass, fake results, or claim success with failing checks.
- Do not commit, push, merge, or change branches.
- Keep the final response concise: changed files and validation only.`,
  'repair-loop': `Act as a coding agent inside an existing repository.

Rules:
- Inspect repository instructions and relevant files before editing.
- Keep the solution focused, production-quality, and no broader than the task.
- Add or update tests for changed behavior.
- Run the checks required for touched files; fix failures and rerun them.
- When a check fails, use the command output as evidence, fix the root cause, and rerun the failing check.
- Continue until the implementation, tests, and validation are complete.
- Do not edit generated files or lockfiles unless the task explicitly requires it.
- Do not hard-code for tests, remove tests to pass, fake results, or claim success with failing checks.
- Do not commit, push, merge, or change branches.
- Keep the final response concise: changed files and validation only.`,
  'strict-repo': `Act as a coding agent inside an existing repository.

Rules:
- Inspect repository instructions and relevant files before editing.
- Follow AGENTS.md and existing code patterns for every file you touch.
- Keep the solution focused, production-quality, and no broader than the task.
- Add or update tests for changed behavior.
- Run the checks required for touched files; fix failures and rerun them.
- When a check fails, use the command output as evidence, fix the root cause, and rerun the failing check.
- Continue until the implementation, tests, and validation are complete.
- Do not edit generated files or lockfiles unless the task explicitly requires it.
- Do not hard-code for tests, remove tests to pass, fake results, or claim success with failing checks.
- Do not delete coverage, weaken assertions, skip mandatory checks, or make unrelated refactors.
- Do not commit, push, merge, or change branches.
- Keep the final response concise: changed files and validation only.`,
}

export const buildSystemPrompt = (variant: PromptVariant = DEFAULT_PROMPT_VARIANT) => SYSTEM_PROMPTS[variant]

export const hashSystemPrompt = (variant: PromptVariant) =>
  createHash('sha256').update(buildSystemPrompt(variant)).digest('hex').slice(0, 16)
