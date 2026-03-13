import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { SymphonyError } from './errors'
import type { Logger } from './logger'
import type { SymphonyConfig, WorkspaceInfo } from './types'
import { ensurePathInsideRoot, sanitizeWorkspaceKey, toAbsolutePath } from './utils'

const PREP_GARBAGE = ['tmp', '.elixir_ls']
const MAX_HOOK_LOG_BYTES = 4_096

const truncateOutput = (value: string): string =>
  value.length > MAX_HOOK_LOG_BYTES ? `${value.slice(0, MAX_HOOK_LOG_BYTES)}…` : value

export class WorkspaceManager {
  private readonly configProvider: () => Promise<SymphonyConfig>
  private readonly logger: Logger

  constructor(configProvider: () => Promise<SymphonyConfig>, logger: Logger) {
    this.configProvider = configProvider
    this.logger = logger.child({ component: 'workspace-manager' })
  }

  async createForIssue(identifier: string): Promise<WorkspaceInfo> {
    const config = await this.configProvider()
    const workspaceKey = sanitizeWorkspaceKey(identifier)
    const root = toAbsolutePath(config.workspaceRoot)
    const workspacePath = toAbsolutePath(path.join(root, workspaceKey))

    if (!ensurePathInsideRoot(root, workspacePath)) {
      throw new SymphonyError('invalid_workspace_cwd', `workspace path ${workspacePath} escapes root ${root}`)
    }

    await mkdir(root, { recursive: true })

    let createdNow = false
    try {
      const metadata = await stat(workspacePath)
      if (!metadata.isDirectory()) {
        throw new SymphonyError('workspace_path_not_directory', `workspace path ${workspacePath} is not a directory`)
      }
    } catch (error) {
      if (error instanceof SymphonyError) throw error
      const nodeError = error as NodeJS.ErrnoException
      if (nodeError?.code && nodeError.code !== 'ENOENT') {
        throw new SymphonyError('workspace_create_failed', `failed to inspect workspace ${workspacePath}`, error)
      }
      await mkdir(workspacePath, { recursive: true })
      createdNow = true
    }

    await this.cleanupEphemeralArtifacts(workspacePath)

    if (createdNow && config.hooks.afterCreate) {
      await this.runHook('after_create', config.hooks.afterCreate, workspacePath, config.hooks.timeoutMs, true)
    }

    return {
      path: workspacePath,
      workspaceKey,
      createdNow,
    }
  }

  async runBeforeRun(workspacePath: string): Promise<void> {
    const config = await this.configProvider()
    if (!config.hooks.beforeRun) return
    await this.runHook('before_run', config.hooks.beforeRun, workspacePath, config.hooks.timeoutMs, true)
  }

  async runAfterRun(workspacePath: string): Promise<void> {
    const config = await this.configProvider()
    if (!config.hooks.afterRun) return
    await this.runHook('after_run', config.hooks.afterRun, workspacePath, config.hooks.timeoutMs, false)
  }

  async removeWorkspace(identifier: string): Promise<void> {
    const config = await this.configProvider()
    const workspaceKey = sanitizeWorkspaceKey(identifier)
    const root = toAbsolutePath(config.workspaceRoot)
    const workspacePath = toAbsolutePath(path.join(root, workspaceKey))
    if (!ensurePathInsideRoot(root, workspacePath)) {
      throw new SymphonyError('invalid_workspace_cwd', `workspace path ${workspacePath} escapes root ${root}`)
    }

    try {
      const metadata = await stat(workspacePath)
      if (!metadata.isDirectory()) {
        throw new SymphonyError('workspace_path_not_directory', `workspace path ${workspacePath} is not a directory`)
      }
    } catch {
      return
    }

    if (config.hooks.beforeRemove) {
      await this.runHook('before_remove', config.hooks.beforeRemove, workspacePath, config.hooks.timeoutMs, false)
    }
    await rm(workspacePath, { recursive: true, force: true })
    this.logger.log('info', 'workspace_removed', { workspace_path: workspacePath })
  }

  private async cleanupEphemeralArtifacts(workspacePath: string): Promise<void> {
    try {
      const entries = await readdir(workspacePath)
      await Promise.all(
        entries
          .filter((entry) => PREP_GARBAGE.includes(entry))
          .map((entry) => rm(path.join(workspacePath, entry), { recursive: true, force: true })),
      )
    } catch {
      return
    }
  }

  private async runHook(
    hookName: 'after_create' | 'before_run' | 'after_run' | 'before_remove',
    script: string,
    workspacePath: string,
    timeoutMs: number,
    failOnError: boolean,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('bash', ['-lc', script], {
        cwd: workspacePath,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        const error = new SymphonyError('workspace_hook_timeout', `hook ${hookName} timed out after ${timeoutMs}ms`)
        this.logger.log(failOnError ? 'error' : 'warn', 'workspace_hook_timeout', {
          hook: hookName,
          workspace_path: workspacePath,
          timeout_ms: timeoutMs,
        })
        if (failOnError) {
          reject(error)
        } else {
          resolve()
        }
      }, timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })

      child.on('error', (error) => {
        clearTimeout(timer)
        const wrapped = new SymphonyError('workspace_hook_error', `hook ${hookName} failed to start`, error)
        this.logger.log(failOnError ? 'error' : 'warn', 'workspace_hook_error', {
          hook: hookName,
          workspace_path: workspacePath,
          error: error.message,
        })
        if (failOnError) {
          reject(wrapped)
        } else {
          resolve()
        }
      })

      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        if (code === 0) {
          this.logger.log('info', 'workspace_hook_completed', {
            hook: hookName,
            workspace_path: workspacePath,
          })
          resolve()
          return
        }

        const message = `hook ${hookName} failed with code ${code ?? 'unknown'} signal ${signal ?? 'unknown'}`
        this.logger.log(failOnError ? 'error' : 'warn', 'workspace_hook_failed', {
          hook: hookName,
          workspace_path: workspacePath,
          exit_code: code,
          signal,
          stdout: truncateOutput(stdout),
          stderr: truncateOutput(stderr),
        })
        if (failOnError) {
          reject(new SymphonyError('workspace_hook_error', message))
        } else {
          resolve()
        }
      })
    })
  }
}
