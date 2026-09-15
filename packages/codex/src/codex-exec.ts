import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

import type { ApprovalMode, SandboxMode } from './options'

export interface CodexExecArgs {
  input: string
  systemPrompt?: string
  threadId?: string | null
  images?: string[]
  model?: string
  jsonMode?: 'json' | 'experimental-json'
  dangerouslyBypassApprovalsAndSandbox?: boolean
  outputSchemaPath?: string
  lastMessagePath?: string
  resumeLast?: boolean
  sandboxMode?: SandboxMode
  workingDirectory?: string
  skipGitRepoCheck?: boolean
  modelReasoningEffort?: string
  signal?: AbortSignal
  networkAccessEnabled?: boolean
  webSearchEnabled?: boolean
  approvalPolicy?: ApprovalMode
  additionalDirectories?: string[]
  baseUrl?: string
  apiKey?: string
  env?: Record<string, string>
}

const INTERNAL_ORIGINATOR_ENV = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'
const ORIGINATOR_VALUE = 'lab_codex_sdk'

const toTomlString = (value: string): string => JSON.stringify(value)

export class CodexExec {
  private executablePath: string

  constructor(executablePath?: string) {
    this.executablePath = executablePath ?? process.env.CODEX_BINARY ?? 'codex'
  }

  async *run(args: CodexExecArgs): AsyncGenerator<string> {
    const jsonFlag = args.jsonMode === 'experimental-json' ? '--experimental-json' : '--json'
    const commandArgs = ['exec']

    if (args.dangerouslyBypassApprovalsAndSandbox) {
      commandArgs.push('--dangerously-bypass-approvals-and-sandbox')
    }

    commandArgs.push(jsonFlag)

    if (args.model) {
      commandArgs.push('--model', args.model)
    }

    if (args.outputSchemaPath) {
      commandArgs.push('--output-schema', args.outputSchemaPath)
    }

    if (args.sandboxMode) {
      commandArgs.push('--sandbox', args.sandboxMode)
    }

    if (args.workingDirectory) {
      commandArgs.push('--cd', args.workingDirectory)
    }

    if (args.additionalDirectories?.length) {
      for (const dir of args.additionalDirectories) {
        commandArgs.push('--add-dir', dir)
      }
    }

    if (args.skipGitRepoCheck) {
      commandArgs.push('--skip-git-repo-check')
    }

    if (args.modelReasoningEffort) {
      commandArgs.push('--config', `model_reasoning_effort="${args.modelReasoningEffort}"`)
    }

    if (args.networkAccessEnabled !== undefined) {
      commandArgs.push('--config', `sandbox_workspace_write.network_access=${args.networkAccessEnabled}`)
    }

    if (args.webSearchEnabled !== undefined) {
      // `features.web_search_request` is deprecated; `web_search` controls mode.
      commandArgs.push('--config', `web_search="${args.webSearchEnabled ? 'live' : 'disabled'}"`)
    }

    if (args.approvalPolicy) {
      commandArgs.push('--config', `approval_policy="${args.approvalPolicy}"`)
    }

    if (typeof args.systemPrompt === 'string' && args.systemPrompt.trim().length > 0) {
      commandArgs.push('--config', `developer_instructions=${toTomlString(args.systemPrompt)}`)
    }

    if (args.images?.length) {
      for (const image of args.images) {
        commandArgs.push('--image', image)
      }
    }

    if (args.lastMessagePath) {
      commandArgs.push('--output-last-message', args.lastMessagePath)
    }

    if (args.resumeLast) {
      commandArgs.push('resume', '--last')
    } else if (args.threadId) {
      commandArgs.push('resume', args.threadId)
    }

    const env = { ...process.env, ...args.env }
    if (!env[INTERNAL_ORIGINATOR_ENV]) {
      env[INTERNAL_ORIGINATOR_ENV] = ORIGINATOR_VALUE
    }
    if (args.baseUrl) {
      env.OPENAI_BASE_URL = args.baseUrl
    }
    if (args.apiKey) {
      env.CODEX_API_KEY = args.apiKey
    }

    const child = spawn(this.executablePath, commandArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: args.signal,
    })

    let spawnError: Error | null = null
    child.once('error', (error) => {
      spawnError = error instanceof Error ? error : new Error('failed to spawn codex process')
    })

    if (!child.stdin) {
      child.kill()
      throw new Error('codex subprocess missing stdin handle')
    }
    child.stdin.write(args.input)
    child.stdin.end()

    if (!child.stdout) {
      child.kill()
      throw new Error('codex subprocess missing stdout handle')
    }

    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })

    try {
      for await (const line of reader) {
        if (line.length === 0) {
          continue
        }
        yield line
      }

      await new Promise<void>((resolve, reject) => {
        child.once('exit', (code) => {
          if (spawnError) {
            reject(spawnError)
            return
          }
          if (code === 0) {
            resolve()
            return
          }
          const stderr = Buffer.concat(stderrChunks).toString('utf8')
          reject(new Error(`codex exited with status ${code ?? 'unknown'}: ${stderr}`))
        })
      })
    } finally {
      reader.close()
      child.removeAllListeners()
      if (!child.killed) {
        child.kill()
      }
    }
  }
}
