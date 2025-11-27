import { CodexAppServerClient } from '@proompteng/codex'

export type SandboxType = 'dangerFullAccess' | 'workspaceWrite' | 'readOnly'
export type ApprovalType = 'unlessTrusted' | 'onFailure' | 'onRequest' | 'never'

export interface AppServerHandle {
  ready: Promise<void>
  runTurn: (options: { prompt: string; model?: string; cwd?: string | null }) => Promise<{ text: string }>
  runTurnStream: (options: {
    prompt: string
    model?: string
    cwd?: string | null
  }) => Promise<{ stream: AsyncGenerator<string, unknown, void> }>
  stop: () => void
}

const DEFAULT_MODEL = 'gpt-5.1-codex-max'
const DEFAULT_SANDBOX: SandboxType = 'dangerFullAccess'
const DEFAULT_APPROVAL: ApprovalType = 'never'

const startAppServerInternal = (
  binaryPath = 'codex',
  workingDirectory?: string,
  {
    sandbox = DEFAULT_SANDBOX,
    approval = DEFAULT_APPROVAL,
    model = DEFAULT_MODEL,
  }: { sandbox?: SandboxType; approval?: ApprovalType; model?: string } = {},
): AppServerHandle => {
  const client = new CodexAppServerClient({
    binaryPath,
    ...(workingDirectory ? { cwd: workingDirectory } : {}),
    sandbox,
    approval,
    defaultModel: model,
    clientInfo: { name: 'jangar', title: 'Jangar UI', version: '0.0.0' },
    logger: (level, message, meta) => {
      const payload = meta ? `${message} ${JSON.stringify(meta)}` : message
      if (level === 'info') console.info('[jangar][codex]', payload)
      else if (level === 'warn') console.warn('[jangar][codex]', payload)
      else console.error('[jangar][codex]', payload)
    },
  })

  return {
    ready: client.ensureReady(),
    runTurn: async ({ prompt, model: modelOverride, cwd }) => {
      const runOptions: { model?: string; cwd?: string | null } = {}
      if (modelOverride !== undefined) runOptions.model = modelOverride
      if (cwd !== undefined) runOptions.cwd = cwd
      const { text } = await client.runTurn(prompt, runOptions)
      return { text }
    },
    runTurnStream: async ({ prompt, model: modelOverride, cwd }) => {
      const runOptions: { model?: string; cwd?: string | null } = {}
      if (modelOverride !== undefined) runOptions.model = modelOverride
      if (cwd !== undefined) runOptions.cwd = cwd
      const { stream } = await client.runTurnStream(prompt, runOptions)
      return { stream }
    },
    stop: () => client.stop(),
  }
}

export const stopAppServer = async (handle: AppServerHandle): Promise<void> => {
  handle.stop()
}

let cached: AppServerHandle | null = null
export const getAppServer = (
  binaryPath = 'codex',
  workingDirectory?: string,
  options?: { sandbox?: SandboxType; approval?: ApprovalType; model?: string },
): AppServerHandle => {
  if (!cached) {
    cached = startAppServerInternal(binaryPath, workingDirectory, options)
  }
  return cached
}
