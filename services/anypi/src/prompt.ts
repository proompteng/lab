import type { AgentRunSpecPayload, ValidationResult } from './types'

export const resolveTaskPrompt = (runSpec: AgentRunSpecPayload) => {
  const candidates = [runSpec.prompt, runSpec.implementation?.text, runSpec.implementation?.summary]
  for (const candidate of candidates) {
    const text = candidate?.trim()
    if (text) return text
  }
  return JSON.stringify(runSpec, null, 2)
}

export const resolveValidationCommands = (runSpec: AgentRunSpecPayload, configuredCommands: string[]) => {
  if (configuredCommands.length > 0) return configuredCommands
  const raw = runSpec.parameters?.validationCommands
  if (!raw?.trim()) return ['git diff --check']
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

export const buildSystemPrompt = () =>
  `Act as a coding agent inside an existing repository.

Rules:
- Inspect repository instructions and relevant files before editing.
- Keep the solution focused, production-quality, and no broader than the task.
- Add or update tests for changed behavior.
- Run the checks required for touched files; fix failures and rerun them.
- Do not hard-code for tests, remove tests to pass, fake results, or claim success with failing checks.
- Do not commit, push, merge, or change branches.
- Keep the final response concise: changed files and validation only.`
