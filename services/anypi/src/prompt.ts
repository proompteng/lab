import type { AgentRunSpecPayload } from './types'

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

export const buildSystemPrompt = () =>
  `You are Anypi, an autonomous production coding runner.
Be direct, use the repository instructions, inspect before editing, make coherent production changes, and verify with commands.
You are running in yolo mode with write/edit/shell tools enabled. Do not wait for approval inside the run.`
