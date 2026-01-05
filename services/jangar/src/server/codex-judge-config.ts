export type CodexJudgeConfig = {
  githubToken: string | null
  githubApiBaseUrl: string
  codexReviewers: string[]
  judgeMode: 'argo' | 'local'
  ciEventStreamEnabled: boolean
  ciMaxWaitMs: number
  reviewMaxWaitMs: number
  maxAttempts: number
  backoffScheduleMs: number[]
  facteurBaseUrl: string
  argoServerUrl: string | null
  discordBotToken: string | null
  discordChannelId: string | null
  discordApiBaseUrl: string
  judgeModel: string
  promptTuningEnabled: boolean
  promptTuningRepo: string | null
  promptTuningFailureThreshold: number
  promptTuningWindowHours: number
  promptTuningCooldownHours: number
  rerunWorkflowTemplate: string | null
  rerunWorkflowNamespace: string
  systemImprovementWorkflowTemplate: string | null
  systemImprovementWorkflowNamespace: string
  systemImprovementJudgePrompt: string
  defaultJudgePrompt: string
}

const DEFAULT_GITHUB_API_BASE = 'https://api.github.com'
const DEFAULT_DISCORD_API_BASE = 'https://discord.com/api/v10'
const DEFAULT_JUDGE_PROMPT = [
  'You are the Codex judge.',
  'Evaluate whether the PR satisfies the issue requirements with no gaps.',
  'Return a single JSON object with decision, confidence, reasons, missing_items, suggested_fixes, next_prompt, and system_suggestions.',
].join('\n')
const DEFAULT_SYSTEM_IMPROVEMENT_JUDGE_PROMPT = [
  'You are the Codex judge for system-improvement PRs.',
  'Review the implementation changes and verify they address the system-improvement prompt.',
  'Return a single JSON object with decision, confidence, reasons, missing_items, suggested_fixes, next_prompt, and system_suggestions.',
].join('\n')

const parseList = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

const parseNumber = (raw: string | undefined, fallback: number) => {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return parsed
}

const parseJudgeMode = (raw: string | undefined) => {
  const normalized = (raw ?? 'argo').trim().toLowerCase()
  return normalized === 'local' ? 'local' : 'argo'
}

export const loadCodexJudgeConfig = (): CodexJudgeConfig => {
  const githubToken = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim() || null
  const githubApiBaseUrl = (process.env.GITHUB_API_BASE_URL ?? DEFAULT_GITHUB_API_BASE).trim()
  const codexReviewers = parseList(process.env.JANGAR_CODEX_REVIEWERS ?? process.env.CODEX_REVIEWERS)
  const judgeMode = parseJudgeMode(process.env.JANGAR_CODEX_JUDGE_MODE)
  const ciEventStreamEnabled =
    (process.env.JANGAR_CI_EVENT_STREAM_ENABLED ?? process.env.JANGAR_GITHUB_EVENT_STREAM_ENABLED ?? 'false')
      .trim()
      .toLowerCase() === 'true'
  const ciMaxWaitMs = parseNumber(process.env.JANGAR_CI_MAX_WAIT_MS, 60 * 60_000)
  const reviewMaxWaitMs = parseNumber(process.env.JANGAR_REVIEW_MAX_WAIT_MS, 60 * 60_000)
  const maxAttempts = parseNumber(process.env.JANGAR_CODEX_MAX_ATTEMPTS, 3)
  const backoffScheduleMs = parseList(process.env.JANGAR_CODEX_BACKOFF_SCHEDULE_MS).map((value) =>
    parseNumber(value, 0),
  )
  const resolvedBackoff = backoffScheduleMs.length > 0 ? backoffScheduleMs : [5 * 60_000, 15 * 60_000, 45 * 60_000]
  const facteurBaseUrl = (
    process.env.FACTEUR_INTERNAL_URL ?? 'http://facteur-internal.facteur.svc.cluster.local'
  ).trim()
  const argoServerUrl = (process.env.ARGO_SERVER_URL ?? '').trim() || null
  const discordBotToken = (process.env.DISCORD_BOT_TOKEN ?? '').trim() || null
  const discordChannelId = (process.env.DISCORD_SUCCESS_CHANNEL_ID ?? '').trim() || null
  const discordApiBaseUrl = (process.env.DISCORD_API_BASE_URL ?? DEFAULT_DISCORD_API_BASE).trim()
  const judgeModel = (process.env.JANGAR_CODEX_JUDGE_MODEL ?? 'gpt-5.2-codex').trim()
  const promptTuningEnabled = (process.env.JANGAR_PROMPT_TUNING_ENABLED ?? 'true').trim().toLowerCase() === 'true'
  const promptTuningRepo = (process.env.JANGAR_PROMPT_TUNING_REPO ?? '').trim() || null
  const promptTuningFailureThreshold = parseNumber(process.env.JANGAR_PROMPT_TUNING_FAILURE_THRESHOLD, 3)
  const promptTuningWindowHours = parseNumber(process.env.JANGAR_PROMPT_TUNING_WINDOW_HOURS, 24)
  const promptTuningCooldownHours = parseNumber(process.env.JANGAR_PROMPT_TUNING_COOLDOWN_HOURS, 6)
  const rerunWorkflowTemplate = (process.env.JANGAR_CODEX_RERUN_TEMPLATE ?? 'codex-autonomous').trim() || null
  const rerunWorkflowNamespace = (process.env.JANGAR_CODEX_RERUN_NAMESPACE ?? 'argo-workflows').trim()
  const systemImprovementWorkflowTemplate =
    (process.env.JANGAR_SYSTEM_IMPROVEMENT_TEMPLATE ?? 'codex-autonomous').trim() || null
  const systemImprovementWorkflowNamespace = (
    process.env.JANGAR_SYSTEM_IMPROVEMENT_NAMESPACE ?? 'argo-workflows'
  ).trim()
  const systemImprovementJudgePrompt = (
    process.env.JANGAR_SYSTEM_IMPROVEMENT_JUDGE_PROMPT ?? DEFAULT_SYSTEM_IMPROVEMENT_JUDGE_PROMPT
  ).trim()
  const defaultJudgePrompt = (process.env.JANGAR_CODEX_JUDGE_PROMPT ?? DEFAULT_JUDGE_PROMPT).trim()

  return {
    githubToken,
    githubApiBaseUrl,
    codexReviewers,
    judgeMode,
    ciEventStreamEnabled,
    ciMaxWaitMs,
    reviewMaxWaitMs,
    maxAttempts,
    backoffScheduleMs: resolvedBackoff,
    facteurBaseUrl,
    argoServerUrl,
    discordBotToken,
    discordChannelId,
    discordApiBaseUrl,
    judgeModel,
    promptTuningEnabled,
    promptTuningRepo,
    promptTuningFailureThreshold,
    promptTuningWindowHours,
    promptTuningCooldownHours,
    rerunWorkflowTemplate,
    rerunWorkflowNamespace,
    systemImprovementWorkflowTemplate,
    systemImprovementWorkflowNamespace,
    systemImprovementJudgePrompt,
    defaultJudgePrompt,
  }
}
