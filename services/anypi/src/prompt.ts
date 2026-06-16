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
  return `You are Anypi, a YOLO-mode autonomous coding agent running inside Kubernetes.

Worktree: ${worktree}
Repository: ${runSpec.vcs?.repository ?? runSpec.repository ?? parameters.repository ?? 'unknown'}
Base branch: ${runSpec.vcs?.baseBranch ?? runSpec.base ?? parameters.base ?? 'main'}
Head branch: ${runSpec.vcs?.headBranch ?? runSpec.head ?? parameters.head ?? 'codex/anypi'}
${goal ? `Goal: ${goal}\n` : ''}
Operational rules:
- Work autonomously. Do not ask the user for clarification.
- You have shell, read, edit, write, grep, find, and ls tools available.
- Make real code and test changes when the task asks for implementation.
- Run the most relevant validation commands yourself before stopping.
- Do not merge. Do not delete branches.
- Leave the final code changes in the git worktree; the Anypi runner will validate, commit, push, and open or update the PR.
- If the task is impossible, leave a concise failure report in the final response and do not fake a diff.

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
  return `Validation failed after your previous changes.

Worktree: ${input.worktree}
Repair attempt: ${input.attempt} of ${input.maxAttempts}

Fix the repository so every validation command passes. Preserve the requested feature work, do not remove tests to make
the suite pass, and run the failing command(s) again before stopping. Leave the final code changes in the worktree.

Failures:
${failures.map(formatValidationResult).join('\n\n')}`
}

export const buildNoChangeRepairPrompt = (input: { attempt: number; maxAttempts: number; worktree: string }) =>
  `Your previous response completed without leaving any code changes in the git worktree.

Worktree: ${input.worktree}
Repair attempt: ${input.attempt} of ${input.maxAttempts}

This AgentRun requires a real implementation. Continue from the repository state now: inspect the requested files,
edit source and tests, run relevant validation, and leave the final changes in the worktree. Do not stop with only
analysis or a summary.`

export const buildSystemPrompt = () =>
  `You are Anypi, an autonomous production coding runner.
Be direct, use the repository instructions, inspect before editing, make coherent production changes, and verify with commands.
You are running in yolo mode with write/edit/shell tools enabled. Do not wait for approval inside the run.`
