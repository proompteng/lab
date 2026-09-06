import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { Effect } from 'effect'

import { writeAuditLog } from './audit'
import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'
import { ShellJobStore, appendTail, tail, type CommandInput, type ShellJob } from './jobs'
import { asPositiveInteger } from './limits'
import { formatCommand, toProcessResult, type ProcessResult } from './process-runner'
import { createRepoSessionIdentity, RepoSessionStore } from './repo-sessions'
import { isInsidePath, resolveExistingDirectory } from './workspace-policy'

export class AgentsShellRunner {
  readonly config: AgentsShellConfig
  readonly jobs = new ShellJobStore()
  readonly repoSessions: RepoSessionStore

  constructor(config: AgentsShellConfig) {
    this.config = config
    mkdirSync(resolve(config.workspaceRoot), { recursive: true })
    this.repoSessions = new RepoSessionStore(config.workspaceRoot)
  }

  parseCommandInput(
    args: {
      command: string
      cwd?: string
      sessionId?: string
      timeoutSeconds?: number
      maxOutputBytes?: number
    },
    auth: AuthContext,
  ): CommandInput {
    return {
      command: args.command,
      cwd: this.resolveCwd(args.cwd, args.sessionId, auth),
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

  private repoSeedPath() {
    return resolveExistingDirectory(this.config.workspaceRoot, 'lab')
  }

  resolveRoot(sessionId: string | undefined, auth: AuthContext) {
    return sessionId ? this.repoSessions.require(sessionId, auth).worktree : resolve(this.config.workspaceRoot)
  }

  resolveCwd(cwd: string | undefined, sessionId: string | undefined, auth: AuthContext) {
    const resolved = resolveExistingDirectory(this.resolveRoot(sessionId, auth), cwd)
    if (!sessionId) this.repoSessions.requireForPath(resolved, auth)
    return resolved
  }

  async openRepoSession(args: { name?: string; baseBranch?: string }, auth: AuthContext) {
    const seed = this.repoSeedPath()
    const baseBranch = args.baseBranch ?? this.config.agentBaseBranch
    if (baseBranch.startsWith('-')) throw new Error(`invalid base branch: ${baseBranch}`)
    const identity = createRepoSessionIdentity(this.config.workspaceRoot, args.name)
    mkdirSync(resolve(this.config.workspaceRoot, 'worktrees', 'lab'), { recursive: true })

    const checkBranch = await this.runProcess({
      command: 'git',
      args: ['check-ref-format', '--branch', baseBranch],
      cwd: seed,
      auth,
      auditEvent: 'repo_session_check_base',
    })
    if (!checkBranch.ok) throw new Error(`invalid base branch: ${baseBranch}`)

    const baseRef = `refs/agents-shell/repo-sessions/${identity.id}/base`
    let baseSha = ''
    try {
      const fetch = await this.runProcess({
        command: 'git',
        args: ['fetch', '--no-write-fetch-head', 'origin', `+refs/heads/${baseBranch}:${baseRef}`],
        cwd: seed,
        auth,
        auditEvent: 'repo_session_fetch',
      })
      if (!fetch.ok) throw new Error(`failed to fetch origin/${baseBranch}: ${fetch.stderr || fetch.stdout}`)

      const base = await this.runProcess({
        command: 'git',
        args: ['rev-parse', '--verify', baseRef],
        cwd: seed,
        auth,
        auditEvent: 'repo_session_base',
      })
      if (!base.ok) throw new Error(`failed to resolve fetched base: ${base.stderr || base.stdout}`)
      baseSha = base.stdout.trim()

      const add = await this.runProcess({
        command: 'git',
        args: ['worktree', 'add', '-b', identity.branch, identity.worktree, baseSha],
        cwd: seed,
        auth,
        auditEvent: 'repo_session_worktree_add',
      })
      if (!add.ok) throw new Error(`failed to create repo session worktree: ${add.stderr || add.stdout}`)
    } finally {
      await this.runProcess({
        command: 'git',
        args: ['update-ref', '-d', baseRef],
        cwd: seed,
        auth,
        auditEvent: 'repo_session_base_ref_cleanup',
      })
    }

    let session
    try {
      session = this.repoSessions.set({
        ...identity,
        ownerSubject: auth.subject,
        baseBranch,
        baseSha,
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      await this.runProcess({
        command: 'git',
        args: ['worktree', 'remove', '--force', identity.worktree],
        cwd: seed,
        auth,
        auditEvent: 'repo_session_persist_rollback',
      })
      throw error
    }
    this.audit('repo_session_opened', auth, {
      sessionId: session.id,
      branch: session.branch,
      baseBranch,
      baseSha,
      worktree: session.worktree,
    })
    return this.repoSessionStatus(session.id, auth)
  }

  async repoSessionStatus(sessionId: string, auth: AuthContext, options: { allowClosing?: boolean } = {}) {
    const session = this.repoSessions.require(sessionId, auth, options)
    const [head, status, divergence] = await Promise.all([
      this.runProcess({
        command: 'git',
        args: ['rev-parse', 'HEAD'],
        sessionId,
        allowClosingSession: options.allowClosing,
        auth,
        auditEvent: 'repo_session_status_head',
      }),
      this.runProcess({
        command: 'git',
        args: ['status', '--porcelain=v1', '--untracked-files=normal', '--ignored=matching'],
        sessionId,
        allowClosingSession: options.allowClosing,
        auth,
        auditEvent: 'repo_session_status_dirty',
      }),
      this.runProcess({
        command: 'git',
        args: ['rev-list', '--left-right', '--count', `${session.baseSha}...HEAD`],
        sessionId,
        allowClosingSession: options.allowClosing,
        auth,
        auditEvent: 'repo_session_status_divergence',
      }),
    ])
    if (!head.ok || !status.ok || !divergence.ok) throw new Error('failed to inspect repo session state')
    const [behindRaw = '0', aheadRaw = '0'] = divergence.stdout.trim().split(/\s+/)
    return {
      sessionId: session.id,
      branch: session.branch,
      baseBranch: session.baseBranch,
      baseSha: session.baseSha,
      headSha: head.stdout.trim(),
      worktree: session.worktree,
      createdAt: session.createdAt,
      dirty: status.stdout.trim().length > 0,
      ahead: Number(aheadRaw),
      behind: Number(behindRaw),
    }
  }

  async closeRepoSession(args: { sessionId: string; force?: boolean }, auth: AuthContext) {
    const session = this.repoSessions.beginClose(args.sessionId, auth)
    let removed = false
    try {
      await this.repoSessions.waitForIdle(args.sessionId, auth)
      const status = await this.repoSessionStatus(args.sessionId, auth, { allowClosing: true })
      if (status.dirty && !args.force) {
        throw new Error(`repo session has uncommitted changes; clean it or close with force: ${args.sessionId}`)
      }
      const activeJobs = this.runningJobs().filter((job) => isInsidePath(session.worktree, job.cwd))
      if (activeJobs.length > 0 && !args.force) {
        throw new Error(`repo session has running shell jobs; stop them or close with force: ${args.sessionId}`)
      }
      if (args.force) {
        await Promise.all(activeJobs.map((job) => this.terminateJob(job, auth)))
      }
      const remove = await this.runProcess({
        command: 'git',
        args: ['worktree', 'remove', ...(args.force ? ['--force'] : []), session.worktree],
        cwd: this.repoSeedPath(),
        auth,
        auditEvent: 'repo_session_worktree_remove',
      })
      if (!remove.ok) throw new Error(`failed to remove repo session worktree: ${remove.stderr || remove.stdout}`)
      removed = true
      this.repoSessions.delete(args.sessionId)
      const closedAt = new Date().toISOString()
      this.audit('repo_session_closed', auth, { sessionId: args.sessionId, branch: session.branch, closedAt })
      return { ...status, closedAt }
    } finally {
      if (!removed) this.repoSessions.cancelClose(args.sessionId)
    }
  }

  audit(event: string, auth: AuthContext | null, payload: Record<string, unknown>) {
    writeAuditLog(this.config, event, auth, payload)
  }

  runningJobs() {
    return Array.from(this.jobs.values()).filter((job) => job.finishedAt === null)
  }

  start(input: CommandInput, auth: AuthContext): ShellJob {
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
    if (job.finishedAt !== null) return job
    const killed = this.killProcessGroup(job, signal)
    if (killed) {
      job.status = 'killed'
      job.signal = signal
      this.audit('shell_job_killed', auth, { jobId: job.id, signal })
    }
    return job
  }

  private waitForJobClose(job: ShellJob, timeoutMs: number) {
    if (job.finishedAt !== null) return Promise.resolve(true)
    return new Promise<boolean>((resolvePromise) => {
      let settled = false
      const finish = (closed: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        job.process.off('close', onClose)
        resolvePromise(closed)
      }
      const onClose = () => finish(true)
      const timeout = setTimeout(() => finish(false), timeoutMs)
      job.process.once('close', onClose)
    })
  }

  private async terminateJob(job: ShellJob, auth: AuthContext) {
    if (job.finishedAt !== null) return
    this.kill(job.id, auth, 'SIGTERM')
    if (await this.waitForJobClose(job, 1_000)) return

    this.audit('shell_job_kill_escalated', auth, { jobId: job.id, signal: 'SIGKILL' })
    this.killProcessGroup(job, 'SIGKILL')
    if (!(await this.waitForJobClose(job, 1_000))) {
      throw new Error(`shell job did not terminate after SIGKILL: ${job.id}`)
    }
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
    sessionId?: string
    allowClosingSession?: boolean
    stdin?: string
    timeoutSeconds?: number
    maxOutputBytes?: number
    okExitCodes?: number[]
    auth: AuthContext
    auditEvent: string
  }): Effect.Effect<ProcessResult, unknown> {
    return Effect.tryPromise({
      try: async () => {
        let session = options.sessionId
          ? this.repoSessions.acquire(options.sessionId, options.auth, { allowClosing: options.allowClosingSession })
          : null
        try {
          const cwd = resolveExistingDirectory(session?.worktree ?? resolve(this.config.workspaceRoot), options.cwd)
          if (!session) {
            session = this.repoSessions.acquireForPath(cwd, options.auth, {
              allowClosing: options.allowClosingSession,
            })
          }
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
        } finally {
          if (session) this.repoSessions.release(session.id)
        }
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
