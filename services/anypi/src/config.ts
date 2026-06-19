import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

import { resolvePromptVariant, resolveValidationPolicy } from './prompt'
import type { AgentRunnerSpecPayload, AgentRunSpecPayload, PromptVariant, ValidationPolicy } from './types'

export const ALL_PI_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const

export const BOUNDED_TEXT_DEFAULT_LIMIT = 4 * 1024 * 1024 // 4 MiB
export const BOUNDED_TEXT_HARD_LIMIT = 16 * 1024 * 1024 // 16 MiB

export type AnypiConfig = {
  workspace: string
  worktree: string
  agentDir: string
  sessionDir: string
  authPath: string
  modelsPath: string
  runSpecPath: string
  runnerSpecPath: string
  statusPath: string
  logPath: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  modelReadyTimeoutSeconds: number
  piPromptTimeoutSeconds: number
  promptVariant: PromptVariant
  allowSystemPromptOverride: boolean
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  contextWindow: number
  maxTokens: number
  tools: string[]
  allowNoVcs: boolean
  validationCommands: string[]
  validationPolicy: ValidationPolicy
  noChangeRepairAttempts: number
  validationRepairAttempts: number
  ciCheckTimeoutSeconds: number
  ciCheckIntervalSeconds: number
  ciRepairAttempts: number
  ciRequiredOnly: boolean
  boundedTextLimit: number
}

const readEnv = (env: NodeJS.ProcessEnv, name: string, fallback: string) => {
  const value = env[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

const readBoolean = (env: NodeJS.ProcessEnv, name: string, fallback: boolean) => {
  const value = env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'y', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(value)) return false
  return fallback
}

const readNumber = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const parseTools = (raw: string | undefined): string[] => {
  if (!raw || raw.trim().toLowerCase() === 'all') return [...ALL_PI_TOOL_NAMES]
  const tools = raw
    .split(/[\s,]+/)
    .map((tool) => tool.trim())
    .filter(Boolean)
  return tools.length > 0 ? [...new Set(tools)] : [...ALL_PI_TOOL_NAMES]
}

export const parseCommandList = (raw: string | undefined): string[] => {
  if (!raw?.trim()) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) throw new Error('validation command JSON must be an array')
    return parsed.map((entry) => String(entry).trim()).filter(Boolean)
  }
  return trimmed
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const normalizeThinkingLevel = (raw: string): AnypiConfig['thinkingLevel'] => {
  if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(raw)) {
    return raw as AnypiConfig['thinkingLevel']
  }
  return 'off'
}

export const resolveConfig = (env: NodeJS.ProcessEnv = process.env): AnypiConfig => {
  const workspace = readEnv(env, 'ANYPI_WORKSPACE', '/workspace')
  const worktree = readEnv(env, 'ANYPI_WORKTREE', resolve(workspace, 'lab'))
  const agentDir = readEnv(env, 'ANYPI_AGENT_DIR', resolve(workspace, '.anypi'))
  const runSpecPath = readEnv(env, 'AGENT_RUN_SPEC', resolve(workspace, 'run.json'))
  const runnerSpecPath = readEnv(env, 'AGENT_RUNNER_SPEC_PATH', resolve(workspace, 'agent-runner.json'))
  return {
    workspace,
    worktree,
    agentDir,
    sessionDir: readEnv(env, 'ANYPI_SESSION_DIR', resolve(agentDir, 'sessions')),
    authPath: readEnv(env, 'ANYPI_AUTH_PATH', resolve(agentDir, 'auth.json')),
    modelsPath: readEnv(env, 'ANYPI_MODELS_PATH', resolve(agentDir, 'models.json')),
    runSpecPath,
    runnerSpecPath,
    statusPath: readEnv(env, 'ANYPI_STATUS_PATH', resolve(workspace, '.agent/status.json')),
    logPath: readEnv(env, 'ANYPI_LOG_PATH', resolve(workspace, '.agent/runner.log')),
    provider: readEnv(env, 'ANYPI_PROVIDER', 'flamingo'),
    model: readEnv(env, 'ANYPI_MODEL', 'qwen3-coder-flamingo'),
    baseUrl: readEnv(env, 'ANYPI_BASE_URL', 'http://flamingo.flamingo.svc.cluster.local/v1'),
    apiKey: readEnv(env, 'ANYPI_API_KEY', 'flamingo-local'),
    modelReadyTimeoutSeconds: readNumber(env, 'ANYPI_MODEL_READY_TIMEOUT_SECONDS', 1800),
    piPromptTimeoutSeconds: readNumber(env, 'ANYPI_PI_PROMPT_TIMEOUT_SECONDS', 1800),
    promptVariant: resolvePromptVariant(env.ANYPI_PROMPT_VARIANT),
    allowSystemPromptOverride: readBoolean(env, 'ANYPI_ALLOW_SYSTEM_PROMPT_OVERRIDE', false),
    thinkingLevel: normalizeThinkingLevel(readEnv(env, 'ANYPI_THINKING_LEVEL', 'off')),
    contextWindow: readNumber(env, 'ANYPI_CONTEXT_WINDOW', 32768),
    maxTokens: readNumber(env, 'ANYPI_MAX_TOKENS', 4096),
    tools: parseTools(env.ANYPI_TOOLS),
    allowNoVcs: readBoolean(env, 'ANYPI_ALLOW_NO_VCS', false),
    validationCommands: parseCommandList(env.ANYPI_VALIDATION_COMMANDS),
    validationPolicy: resolveValidationPolicy(env.ANYPI_VALIDATION_POLICY),
    noChangeRepairAttempts: readNumber(env, 'ANYPI_NO_CHANGE_REPAIR_ATTEMPTS', 2),
    validationRepairAttempts: readNumber(env, 'ANYPI_VALIDATION_REPAIR_ATTEMPTS', 2),
    ciCheckTimeoutSeconds: readNumber(env, 'ANYPI_CI_CHECK_TIMEOUT_SECONDS', 3600),
    ciCheckIntervalSeconds: readNumber(env, 'ANYPI_CI_CHECK_INTERVAL_SECONDS', 30),
    ciRepairAttempts: readNumber(env, 'ANYPI_CI_REPAIR_ATTEMPTS', 1),
    ciRequiredOnly: readBoolean(env, 'ANYPI_CI_REQUIRED_ONLY', true),
    boundedTextLimit: Math.min(
      readNumber(env, 'ANYPI_BOUNDED_TEXT_LIMIT', BOUNDED_TEXT_DEFAULT_LIMIT),
      BOUNDED_TEXT_HARD_LIMIT,
    ),
  }
}

export const readJsonFile = async <T>(path: string): Promise<T> => {
  const raw = await readFile(path, 'utf8')
  return JSON.parse(raw) as T
}

export const loadRunSpec = async (config: AnypiConfig): Promise<AgentRunSpecPayload> =>
  await readJsonFile<AgentRunSpecPayload>(config.runSpecPath)

export const loadRunnerSpec = async (config: AnypiConfig): Promise<AgentRunnerSpecPayload | null> => {
  try {
    return await readJsonFile<AgentRunnerSpecPayload>(config.runnerSpecPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

export const applyRunnerArtifacts = (config: AnypiConfig, runnerSpec: AgentRunnerSpecPayload | null): AnypiConfig => ({
  ...config,
  statusPath: runnerSpec?.artifacts?.statusPath ?? config.statusPath,
  logPath: runnerSpec?.artifacts?.logPath ?? config.logPath,
})

export const buildModelsJson = (config: AnypiConfig) => ({
  providers: {
    [config.provider]: {
      baseUrl: config.baseUrl,
      api: 'openai-completions',
      apiKey: config.apiKey,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      models: [
        {
          id: config.model,
          name: config.model,
          reasoning: false,
          input: ['text'],
          contextWindow: config.contextWindow,
          maxTokens: config.maxTokens,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      ],
    },
  },
})

export const writeModelsFile = async (config: AnypiConfig) => {
  await mkdir(dirname(config.modelsPath), { recursive: true })
  await writeFile(config.modelsPath, `${JSON.stringify(buildModelsJson(config), null, 2)}\n`, 'utf8')
}
