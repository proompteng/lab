import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { Effect } from 'effect'

import { writeAuditLog } from './audit'
import type { AuthContext } from './auth'
import { requireAllowedShellCommand } from './cli-policy'
import type { AgentsShellConfig } from './config'
import { ShellJobStore, appendTail, tail, type CommandInput, type ShellJob } from './jobs'
import { asPositiveInteger } from './limits'
import { formatCommand, toProcessResult, type ProcessResult } from './process-runner'
import { resolveExistingDirectory } from './workspace-policy'

export class AgentsShellRunner {
  readonly config: AgentsShellConfig
  readonly jobs = new ShellJobStore()

  constructor(config: AgentsShellConfig) {
    this.config = config
    mkdirSync(resolve(config.workspaceRoot), { recursive: true })
  }

  parseCommandInput(args: {
    command: string
    cwd?: string
    timeoutSeconds?: number
    maxOutputBytes?: number
  }): CommandInput {
    return {
      command: args.command,
      cwd: resolveExistingDirectory(this.config.workspaceRoot, args.cwd),
      timeoutSeconds: asPositiveInteger(
        args.timeoutSeconds,
        'timeoutSeconds',
        this.config.defaultTimeoutSeconds,
        this.config.maxTimeoutSeconds,
      ),
      maxOutputBytes: asPositiveInteger(
        args.maxOutputBytes,
        'maxOutputBytes',
        this.config.defaultOutputBytes,
        this.config.maxOutputBytes,
        1024,
      ),
    }
  }

  audit(event: string, auth: AuthContext | null, payload: Record<string, unknown>) {
    writeAuditLog(this.config, event, auth, payload)
  }

  runningJobs() {
    return Array.from(this.jobs.values()).filter((job) => job.status === 'running')
  }

  start(input: CommandInput, auth: AuthContext): ShellJob {
    try {
      requireAllowedShellCommand(input.command)
    } catch (error) {
      this.audit('shell_command_rejected', auth, {
        command: input.command,
        cwd: input.cwd,
        reason: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    if (this.runningJobs().length >= this.config.maxConcurrentJobs) {
      throw new Error(`max concurrent jobs reached: ${this.config.maxConcurrentJobs}`)
    }

    const child = spawn('/bin/bash', ['-lc', input.command], {
      cwd: input.cwd,
      env: { ...process.env, TERM: process.env.TERM ?? 'dumb' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const job: ShellJob = {
      id: randomUUID(),
      command: input.command,
      cwd: input.cwd,
      process: child,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      signal: null,
      timedOut: false,
      timeout: null,
      stdout: tail(),
      stderr: tail(),
    }

    child.stdout.on('data', (chunk: Buffer) => appendTail(job.stdout, Buffer.from(chunk), input.maxOutputBytes))
    child.stderr.on('data', (chunk: Buffer) => appendTail(job.stderr, Buffer.from(chunk), input.maxOutputBytes))
    child.on('close', (code, signal) => {
      if (job.timeout) {
        clearTimeout(job.timeout)
        job.timeout = null
      }
      if (job.status === 'running') job.status = 'exited'
      job.exitCode = code
      job.signal = signal
      job.finishedAt = new Date().toISOString()
      this.audit('shell_job_finished', auth, {
        jobId: job.id,
        status: job.status,
        exitCode: code,
        signal,
        timedOut: job.timedOut,
      })
    })
    child.on('error', (error) => appendTail(job.stderr, Buffer.from(String(error)), input.maxOutputBytes))
    job.timeout = setTimeout(() => {
      if (job.status !== 'running') return
      job.timedOut = true
      job.status = 'timed_out'
      this.killProcessGroup(job, 'SIGTERM')
    }, input.timeoutSeconds * 1000)

    this.jobs.set(job.id, job)
    this.audit('shell_job_started', auth, {
      jobId: job.id,
      command: input.command,
      cwd: input.cwd,
      timeoutSeconds: input.timeoutSeconds,
    })
    return job
  }

  async run(input: CommandInput, auth: AuthContext) {
    const job = this.start(input, auth)
    await new Promise<void>((resolvePromise) => job.process.once('close', () => resolvePromise()))
    return job
  }

  killProcessGroup(job: ShellJob, signal = 'SIGTERM') {
    const pid = job.process.pid
    if (!pid) return false
    try {
      process.kill(-pid, signal as NodeJS.Signals)
      return true
    } catch {
      return job.process.kill(signal as NodeJS.Signals)
    }
  }

  kill(jobId: string, auth: AuthContext, signal = 'SIGTERM') {
    const job = this.requireJob(jobId)
    if (job.status !== 'running') return job
    const killed = this.killProcessGroup(job, signal)
    if (killed) {
      job.status = 'killed'
      job.signal = signal
      this.audit('shell_job_killed', auth, { jobId: job.id, signal })
    }
    return job
  }

  requireJob(jobId: string) {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`unknown jobId: ${jobId}`)
    return job
  }

  runProcessEffect(options: {
    command: string
    args: string[]
    cwd?: string
    stdin?: string
    timeoutSeconds?: number
    maxOutputBytes?: number
    okExitCodes?: number[]
    auth: AuthContext
    auditEvent: string
  }): Effect.Effect<ProcessResult, unknown> {
    return Effect.tryPromise({
      try: async () => {
        const cwd = resolveExistingDirectory(this.config.workspaceRoot, options.cwd)
        const timeoutSeconds = asPositiveInteger(
          options.timeoutSeconds,
          'timeoutSeconds',
          this.config.defaultTimeoutSeconds,
          this.config.maxTimeoutSeconds,
        )
        const maxOutputBytes = asPositiveInteger(
          options.maxOutputBytes,
          'maxOutputBytes',
          this.config.defaultOutputBytes,
          this.config.maxOutputBytes,
          1024,
        )
        const commandLine = formatCommand(options.command, options.args)
        const stdout = tail()
        const stderr = tail()
        let timedOut = false

        this.audit(options.auditEvent, options.auth, { command: commandLine, cwd, timeoutSeconds })

        const child = spawn(options.command, options.args, {
          cwd,
          env: { ...process.env, TERM: process.env.TERM ?? 'dumb' },
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        child.stdout.on('data', (chunk: Buffer) => appendTail(stdout, Buffer.from(chunk), maxOutputBytes))
        child.stderr.on('data', (chunk: Buffer) => appendTail(stderr, Buffer.from(chunk), maxOutputBytes))

        if (options.stdin != null) {
          child.stdin.write(options.stdin)
        }
        child.stdin.end()

        const timeout = setTimeout(() => {
          timedOut = true
          child.kill('SIGTERM')
        }, timeoutSeconds * 1000)

        const result = await new Promise<{ exitCode: number | null; signal: string | null }>(
          (resolvePromise, reject) => {
            let settled = false
            const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
              if (settled) return
              settled = true
              child.stdout.destroy()
              child.stderr.destroy()
              resolvePromise({ exitCode, signal })
            }

            child.once('error', reject)
            child.once('exit', (exitCode, signal) => setImmediate(() => finish(exitCode, signal)))
            child.once('close', (exitCode, signal) => finish(exitCode, signal))
          },
        ).finally(() => clearTimeout(timeout))

        const processResult = toProcessResult(
          commandLine,
          cwd,
          result.exitCode,
          result.signal,
          timedOut,
          stdout,
          stderr,
          maxOutputBytes,
          new Set(options.okExitCodes ?? [0]),
        )
        this.audit(`${options.auditEvent}_finished`, options.auth, {
          command: commandLine,
          cwd,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut,
        })
        return processResult
      },
      catch: (error) => error,
    })
  }

  async runProcess(options: Parameters<AgentsShellRunner['runProcessEffect']>[0]): Promise<ProcessResult> {
    return Effect.runPromise(this.runProcessEffect(options))
  }

  shutdown() {
    for (const job of this.runningJobs()) {
      job.status = 'killed'
      this.killProcessGroup(job, 'SIGTERM')
    }
  }
}
