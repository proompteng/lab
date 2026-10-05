import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { Effect } from 'effect'

import { flushAuditLog, toolAuditContext, writeAuditLog } from './audit'
import type { AuthContext } from './auth'
import type { AgentsShellConfig } from './config'
import { OUTPUT_RETENTION_BYTES } from './constants'
import { OutputAudit } from './output-audit'
import {
  ShellJobStore,
  appendTail,
  tail,
  previewCommand,
  readJobOutput,
  listJobMetadata,
  outputFromOffset,
  type CommandInput,
  type RunningShellJob,
  type OutputCursor,
} from './jobs'
import { AgentsShellRuntimeError } from './errors'
import type { ExecInput } from './schemas'
import { asPositiveInteger } from './limits'
import { formatCommand, toProcessResult, type ProcessResult } from './process-runner'
import { createRepoSessionIdentity, RepoSessionStore } from './repo-sessions'
import { isInsidePath, resolveExistingDirectory } from './workspace-policy'

export class AgentsShellRunner {
  readonly config: AgentsShellConfig
  readonly jobs = new ShellJobStore()
  readonly repoSessions: RepoSessionStore
  private readonly changes = new EventEmitter().setMaxListeners(0)
  private pendingSubmissions = 0
  private readonly submissions = new Map<
    string,
    | { kind: 'pending'; fingerprint: string; launch: Promise<RunningShellJob> }
    | { kind: 'started'; fingerprint: string; jobId: string }
  >()

  constructor(config: AgentsShellConfig) {
    this.config = config
    mkdirSync(resolve(config.workspaceRoot), { recursive: true })
    this.repoSessions = new RepoSessionStore(config.workspaceRoot)
  }

  parseCommandInput(
    args: {
      command: string
      cwd?: string
      sessionId: string
      agentId?: string
      timeoutSeconds?: number
      maxBytes?: number
      waitMs?: number
      requestKey: string
    },
    auth: AuthContext,
  ): CommandInput {
    if (!args.sessionId) throw new Error('execution requires repo_session_open and its sessionId')
    return {
      command: args.command,
      sessionId: args.sessionId,
      agentId: args.agentId,
      cwd: this.resolveCwd(args.cwd, args.sessionId, auth),
      timeoutSeconds: asPositiveInteger(
        args.timeoutSeconds,
        'timeoutSeconds',
        this.config.defaultTimeoutSeconds,
        this.config.maxTimeoutSeconds,
      ),
      requestKey: args.requestKey,
      waitMs: args.waitMs ?? 1000,
      maxBytes: asPositiveInteger(
        args.maxBytes,
        'maxBytes',
        this.config.defaultOutputBytes,
        this.config.maxOutputBytes,
        4096,
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
      taskId: session.id,
      branch: session.branch,
      baseBranch,
      baseSha,
      worktree: session.worktree,
    })
    return this.repoSessionStatus(session.id, auth)
  }

  async repoSessionStatus(sessionId: string, auth: AuthContext, options: { allowClosing?: boolean } = {}) {
    const session = this.repoSessions.require(sessionId, auth, options)
    const [head, dirtyCheck, divergence] = await Promise.all([
      this.runProcess({
        command: 'git',
        args: ['rev-parse', 'HEAD'],
        sessionId,
        allowClosingSession: options.allowClosing,
        auth,
        auditEvent: 'repo_session_status_head',
      }),
      this.runProcess({
        command: '/bin/bash',
        args: ['-lc', 'test -z "$(git status --porcelain=v1 --untracked-files=normal --ignored=matching)"'],
        sessionId,
        allowClosingSession: options.allowClosing,
        okExitCodes: [0, 1],
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
    if (!head.ok || !dirtyCheck.ok || !divergence.ok) throw new Error('failed to inspect repo session state')
    const [behindRaw = '0', aheadRaw = '0'] = divergence.stdout.trim().split(/\s+/)
    return {
      sessionId: session.id,
      branch: session.branch,
      baseBranch: session.baseBranch,
      taskId: session.id,
      baseSha: session.baseSha,
      headSha: head.stdout.trim(),
      worktree: session.worktree,
      createdAt: session.createdAt,
      dirty: dirtyCheck.exitCode === 1,
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

  audit(
    event: string,
    auth: AuthContext | null,
    payload: Record<string, unknown>,
    context = toolAuditContext.getStore() ?? null,
  ) {
    return writeAuditLog(this.config, event, auth, payload, context)
  }

  flushAudit() {
    return flushAuditLog()
  }

  runningJobs() {
    return Array.from(this.jobs.running())
  }

  private start(input: CommandInput, auth: AuthContext): RunningShellJob {
    this.jobs.ensureCapacity()
    if (this.runningJobs().length >= this.config.maxConcurrentJobs) {
      throw new AgentsShellRuntimeError({
        message: `execution capacity busy: ${this.config.maxConcurrentJobs} running jobs`,
        code: 'CAPACITY_BUSY',
        retryAfterMs: 250,
      })
    }

    this.resolveCwd(input.cwd, input.sessionId, auth)
    const session = this.repoSessions.require(input.sessionId, auth)
    const id = randomUUID()
    const auditContext = toolAuditContext.getStore() ?? null
    const startedAt = performance.now()
    const identity = {
      id,
      ownerSubject: auth.subject,
      sessionId: session.id,
      taskId: session.id,
      requestKey: input.requestKey,
      agentId: input.agentId ?? null,
      requestId: auditContext?.requestId ?? null,
      toolCallId: auditContext?.toolCallId ?? null,
      commandPreview: previewCommand(input.command),
      commandHash: createHash('sha256').update(input.command).digest('hex'),
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
      stdout: tail(),
      stderr: tail(),
      outputCaptureError: null,
      auditErrors: 0,
    }

    const receipt = {
      ...identity,
      kind: 'completed' as const,
      status: 'cancelled' as const,
      finishedAt: identity.startedAt,
      exitCode: -1,
      signal: 'SIGKILL',
    }
    readJobOutput(receipt, { jobId: id, stdoutOffset: 0, stderrOffset: 0, outputEncoding: 'utf8' }, input.maxBytes)
    listJobMetadata([receipt], undefined, 1)
    const child = spawn('/bin/bash', ['-lc', input.command], {
      cwd: input.cwd,
      env: { ...process.env, TERM: process.env.TERM ?? 'dumb' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const job: RunningShellJob = {
      ...identity,
      kind: 'running',
      process: child,
      finishedAt: null,
      termination: null,
      timeout: null,
    }

    const outputAudit = (stream: 'stdout' | 'stderr') =>
      new OutputAudit(stream, (event, payload) =>
        this.audit(
          event,
          auth,
          {
            jobId: job.id,
            sessionId: job.sessionId,
            agentId: job.agentId,
            taskId: job.taskId,
            ...payload,
          },
          auditContext,
        ),
      )
    let lastOutputAt = performance.now()
    const stdoutAudit = outputAudit('stdout')
    const stderrAudit = outputAudit('stderr')
    const onAuditFailure = () => {
      job.outputCaptureError =
        stdoutAudit.captureError ?? stderrAudit.captureError ?? 'audit output capture failed; command stopped'
      this.killProcessGroup(job.process, 'SIGKILL')
    }
    child.stdout.on('data', (chunk: Buffer) => {
      lastOutputAt = performance.now()
      appendTail(job.stdout, Buffer.from(chunk), OUTPUT_RETENTION_BYTES)
      this.jobs.prune()
      stdoutAudit.write(Buffer.from(chunk), child.stdout, onAuditFailure)
      this.changes.emit(job.id)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      lastOutputAt = performance.now()
      appendTail(job.stderr, Buffer.from(chunk), OUTPUT_RETENTION_BYTES)
      this.jobs.prune()
      stderrAudit.write(Buffer.from(chunk), child.stderr, onAuditFailure)
      this.changes.emit(job.id)
    })
    let drainTimeout: ReturnType<typeof setTimeout> | undefined
    let killTimeout: ReturnType<typeof setTimeout> | undefined
    child.once('exit', () => {
      const exitAt = performance.now()
      if (job.timeout) {
        clearTimeout(job.timeout)
        job.timeout = null
      }
      const finishDrain = () => {
        if (
          performance.now() - exitAt < 10_000 &&
          (child.stdout.isPaused() || child.stderr.isPaused() || performance.now() - lastOutputAt < 250)
        ) {
          drainTimeout = setTimeout(finishDrain, 250)
          return
        }
        job.outputCaptureError = 'descendant pipes remained open 250ms after parent exit; capture closed'
        this.killProcessGroup(job.process, 'SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
      }
      drainTimeout = setTimeout(finishDrain, 250)
    })
    child.on('close', (code, signal) => {
      clearTimeout(drainTimeout)
      clearTimeout(killTimeout)
      stdoutAudit.finish(job.outputCaptureError)
      stderrAudit.finish(job.outputCaptureError)
      job.outputCaptureError ??= stdoutAudit.captureError ?? stderrAudit.captureError
      job.auditErrors = stdoutAudit.sinkErrors + stderrAudit.sinkErrors
      if (job.timeout) {
        clearTimeout(job.timeout)
        job.timeout = null
      }
      const { process: _process, timeout: _timeout, termination, ...identity } = job
      const completed = {
        ...identity,
        kind: 'completed' as const,
        status: termination ?? ('exited' as const),
        finishedAt: new Date().toISOString(),
        exitCode: code,
        signal,
      }
      this.jobs.set(job.id, completed)
      this.changes.emit(job.id)
      this.changes.emit('capacity')
      this.audit(
        'shell_job_finished',
        auth,
        {
          jobId: job.id,
          sessionId: job.sessionId,
          agentId: job.agentId,
          taskId: job.taskId,
          requestKey: job.requestKey,
          outputCaptureError: job.outputCaptureError,
          auditErrors: job.auditErrors,
          command: input.command,
          status: completed.status,
          exitCode: code,
          signal,
          timedOut: completed.status === 'timed_out',
          durationMs: performance.now() - startedAt,
          stdoutBytes: job.stdout.totalBytes,
          stderrBytes: job.stderr.totalBytes,
          stdoutTruncated: job.stdout.truncated,
          stderrTruncated: job.stderr.truncated,
        },
        auditContext,
      )
    })
    child.on('error', (error) => appendTail(job.stderr, Buffer.from(String(error)), OUTPUT_RETENTION_BYTES))
    job.timeout = setTimeout(() => {
      if (this.jobs.get(job.id)?.kind !== 'running') return
      job.termination ??= 'timed_out'
      this.killProcessGroup(job.process, 'SIGTERM')
      killTimeout = setTimeout(() => this.killProcessGroup(job.process, 'SIGKILL'), 1_000)
    }, input.timeoutSeconds * 1000)

    this.jobs.set(job.id, job)
    this.audit('shell_job_started', auth, {
      jobId: job.id,
      sessionId: job.sessionId,
      agentId: job.agentId,
      taskId: job.taskId,
      requestKey: job.requestKey,
      command: input.command,
      cwd: input.cwd,
      timeoutSeconds: input.timeoutSeconds,
    })
    return job
  }

  async execute(args: ExecInput, auth: AuthContext) {
    const deadline = performance.now() + (args.waitMs ?? 1000)
    this.jobs.prune()
    for (const [key, submission] of this.submissions) {
      if (submission.kind === 'started' && !this.jobs.has(submission.jobId)) this.submissions.delete(key)
    }
    const key = JSON.stringify([auth.subject, args.sessionId, args.requestKey])
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          args.command,
          args.cwd ?? null,
          asPositiveInteger(
            args.timeoutSeconds,
            'timeoutSeconds',
            this.config.defaultTimeoutSeconds,
            this.config.maxTimeoutSeconds,
          ),
          args.agentId ?? null,
        ]),
      )
      .digest('hex')
    let submission = this.submissions.get(key)
    if (submission && submission.fingerprint !== fingerprint)
      throw new AgentsShellRuntimeError({
        message: 'requestKey is already bound to a different execution',
        code: 'IDEMPOTENCY_CONFLICT',
      })
    if (!submission) {
      const input = this.parseCommandInput(args, auth)
      if (this.pendingSubmissions >= this.config.maxConcurrentJobs)
        throw new AgentsShellRuntimeError({
          message: 'execution admission capacity busy; retry the same requestKey',
          code: 'CAPACITY_BUSY',
          retryAfterMs: 250,
        })
      this.pendingSubmissions += 1
      const launch = Promise.resolve()
        .then(async () => {
          while (this.runningJobs().length >= this.config.maxConcurrentJobs) {
            const remaining = deadline - performance.now()
            if (remaining <= 0)
              throw new AgentsShellRuntimeError({
                message: 'execution capacity busy; retry the same requestKey',
                code: 'CAPACITY_BUSY',
                retryAfterMs: 250,
              })
            await this.waitForChange(
              'capacity',
              remaining,
              () => this.runningJobs().length < this.config.maxConcurrentJobs,
            )
          }
          const job = this.start(input, auth)
          this.submissions.set(key, { kind: 'started', fingerprint, jobId: job.id })
          return job
        })
        .catch((error: unknown) => {
          this.submissions.delete(key)
          throw error
        })
        .finally(() => {
          this.pendingSubmissions -= 1
        })
      submission = { kind: 'pending', fingerprint, launch }
      this.submissions.set(key, submission)
    }
    const job =
      submission.kind === 'pending'
        ? await this.waitForLaunch(submission.launch, Math.max(0, deadline - performance.now()))
        : this.requireJob(submission.jobId, auth)
    await this.waitForChange(
      job.id,
      Math.max(0, deadline - performance.now()),
      () => this.requireJob(job.id, auth).kind === 'completed',
    )
    return this.requireJob(job.id, auth)
  }

  private waitForLaunch(launch: Promise<RunningShellJob>, waitMs: number) {
    return new Promise<RunningShellJob>((resolvePromise, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new AgentsShellRuntimeError({
              message: 'execution admission pending; retry the same requestKey',
              code: 'CAPACITY_BUSY',
              retryAfterMs: 250,
            }),
          ),
        waitMs,
      )
      launch.then(
        (job) => {
          clearTimeout(timeout)
          resolvePromise(job)
        },
        (error: unknown) => {
          clearTimeout(timeout)
          reject(error)
        },
      )
    })
  }

  private waitForChange(event: string, waitMs: number, ready: () => boolean) {
    if (ready() || waitMs <= 0) return Promise.resolve()
    return new Promise<void>((resolvePromise) => {
      const finish = () => {
        clearTimeout(timeout)
        this.changes.off(event, onChange)
        resolvePromise()
      }
      const onChange = () => {
        if (ready()) finish()
      }
      const timeout = setTimeout(finish, waitMs)
      this.changes.on(event, onChange)
      onChange()
    })
  }

  async waitForOutput(jobId: string, auth: AuthContext, cursor: OutputCursor, waitMs: number) {
    await this.waitForChange(jobId, waitMs, () => {
      const job = this.requireJob(jobId, auth)
      if (cursor.stdoutOffset > job.stdout.totalBytes || cursor.stderrOffset > job.stderr.totalBytes)
        throw new Error('output cursor is beyond produced bytes')
      if (job.kind === 'completed') return true
      return (
        [
          ['stdout', cursor.stdoutOffset],
          ['stderr', cursor.stderrOffset],
        ] as const
      ).some(([stream, offset]) => {
        const page = outputFromOffset(job[stream], offset, 8, cursor.outputEncoding, false)
        return page.nextOffset > offset || page.truncatedBeforeOffset
      })
    })
    return this.requireJob(jobId, auth)
  }

  private killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
    const pid = child.pid
    if (!pid) return false
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      return child.kill(signal)
    }
  }

  async cancel(jobId: string, auth: AuthContext) {
    const job = this.requireJob(jobId, auth)
    if (job.kind === 'running') await this.terminateJob(job, auth)
    return this.requireJob(jobId, auth)
  }

  private waitForJobClose(job: RunningShellJob, timeoutMs: number) {
    if (this.jobs.get(job.id)?.kind === 'completed') return Promise.resolve(true)
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

  private async terminateJob(job: RunningShellJob, auth: AuthContext) {
    if (this.jobs.get(job.id)?.kind === 'completed') return
    job.termination ??= 'cancelled'
    this.killProcessGroup(job.process, 'SIGTERM')
    this.audit('shell_job_cancelled', auth, { jobId: job.id, taskId: job.taskId })
    if (await this.waitForJobClose(job, 1_000)) return

    this.audit('shell_job_kill_escalated', auth, { jobId: job.id, signal: 'SIGKILL' })
    this.killProcessGroup(job.process, 'SIGKILL')
    if (!(await this.waitForJobClose(job, 1_000))) {
      throw new Error(`shell job did not terminate after SIGKILL: ${job.id}`)
    }
  }

  requireJob(jobId: string, auth: AuthContext) {
    const job = this.jobs.get(jobId)
    if (!job || job.ownerSubject !== auth.subject) throw new Error(`unknown or expired jobId: ${jobId}`)
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
          const jobId = randomUUID()
          const auditContext = toolAuditContext.getStore() ?? null
          const outputAudit = (stream: 'stdout' | 'stderr') =>
            new OutputAudit(stream, (event, payload) =>
              auditContext?.tool.startsWith('agent_')
                ? 0
                : this.audit(
                    event,
                    options.auth,
                    { jobId, sessionId: session?.id ?? null, taskId: session?.id ?? jobId, ...payload },
                    auditContext,
                  ),
            )
          const stdoutAudit = outputAudit('stdout')
          const stderrAudit = outputAudit('stderr')
          let outputCaptureError: string | null = null
          let lastOutputAt = performance.now()
          let killTimeout: ReturnType<typeof setTimeout> | undefined
          const stdout = tail()
          const stderr = tail()
          let timedOut = false

          this.audit(options.auditEvent, options.auth, {
            jobId,
            command: commandLine,
            args: options.args,
            cwd,
            sessionId: session?.id ?? null,
            taskId: session?.id ?? jobId,
            timeoutSeconds,
          })

          const child = spawn(options.command, options.args, {
            cwd,
            env: { ...process.env, TERM: process.env.TERM ?? 'dumb' },
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          })

          const onAuditFailure = () => {
            outputCaptureError =
              stdoutAudit.captureError ?? stderrAudit.captureError ?? 'audit output capture failed; command stopped'
            this.killProcessGroup(child, 'SIGKILL')
          }
          child.stdout.on('data', (chunk: Buffer) => {
            lastOutputAt = performance.now()
            appendTail(stdout, Buffer.from(chunk), maxOutputBytes)
            stdoutAudit.write(Buffer.from(chunk), child.stdout, onAuditFailure)
          })
          child.stderr.on('data', (chunk: Buffer) => {
            lastOutputAt = performance.now()
            appendTail(stderr, Buffer.from(chunk), maxOutputBytes)
            stderrAudit.write(Buffer.from(chunk), child.stderr, onAuditFailure)
          })

          if (options.stdin != null) {
            child.stdin.write(options.stdin)
          }
          child.stdin.end()

          const timeout = setTimeout(() => {
            timedOut = true
            this.killProcessGroup(child, 'SIGTERM')
            killTimeout = setTimeout(() => this.killProcessGroup(child, 'SIGKILL'), 1_000)
          }, timeoutSeconds * 1000)

          const result = await new Promise<{ exitCode: number | null; signal: string | null }>(
            (resolvePromise, reject) => {
              let settled = false
              let drainTimeout: ReturnType<typeof setTimeout> | undefined
              const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
                if (settled) return
                settled = true
                clearTimeout(drainTimeout)
                clearTimeout(killTimeout)
                if (!child.stdout.readableEnded || !child.stderr.readableEnded) {
                  outputCaptureError ??= 'descendant pipes remained open 250ms after parent exit; capture closed'
                  this.killProcessGroup(child, 'SIGKILL')
                }
                child.stdout.destroy()
                child.stderr.destroy()
                stdoutAudit.finish(outputCaptureError)
                stderrAudit.finish(outputCaptureError)
                resolvePromise({ exitCode, signal })
              }

              child.once('error', reject)
              child.once('exit', (exitCode, signal) => {
                clearTimeout(timeout)
                const exitAt = performance.now()
                const finishDrain = () => {
                  if (
                    performance.now() - exitAt < 10_000 &&
                    (child.stdout.isPaused() || child.stderr.isPaused() || performance.now() - lastOutputAt < 250)
                  ) {
                    drainTimeout = setTimeout(finishDrain, 250)
                    return
                  }
                  finish(exitCode, signal)
                }
                drainTimeout = setTimeout(finishDrain, 250)
              })
              child.once('close', (exitCode, signal) => finish(exitCode, signal))
            },
          ).finally(() => {
            clearTimeout(timeout)
            clearTimeout(killTimeout)
            stdoutAudit.finish(outputCaptureError)
            stderrAudit.finish(outputCaptureError)
          })

          outputCaptureError ??= stdoutAudit.captureError ?? stderrAudit.captureError
          const processResult = toProcessResult(
            commandLine,
            cwd,
            result.exitCode,
            result.signal,
            timedOut,
            stdout,
            stderr,
            maxOutputBytes,
            {
              jobId,
              sessionId: session?.id ?? null,
              outputCaptureError,
              auditErrors: stdoutAudit.sinkErrors + stderrAudit.sinkErrors,
            },
            new Set(options.okExitCodes ?? [0]),
          )
          this.audit(`${options.auditEvent}_finished`, options.auth, {
            jobId,
            outputCaptureError,
            auditErrors: stdoutAudit.sinkErrors + stderrAudit.sinkErrors,
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
      job.termination ??= 'cancelled'
      this.killProcessGroup(job.process, 'SIGKILL')
    }
  }
}
