import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'

import type { CandidateDevelopmentCommandFailure } from './contracts'
import type { CandidateDevelopmentGitObjectReader, CandidateDevelopmentSourceGit } from './git-contracts'

export class CandidateDevelopmentSourceVerificationError extends Error {
  readonly operation: Extract<
    CandidateDevelopmentCommandFailure,
    { readonly _tag: 'CandidateDevelopmentCommandSourceVerificationFailed' }
  >['operation']
  readonly sourceCause: unknown

  constructor(operation: CandidateDevelopmentSourceVerificationError['operation'], sourceCause: unknown) {
    super(`candidate development source verification failed during ${operation}`)
    this.operation = operation
    this.sourceCause = sourceCause
  }
}

export const sourceStep = async <A>(
  operation: CandidateDevelopmentSourceVerificationError['operation'],
  step: () => Promise<A>,
): Promise<A> => {
  try {
    return await step()
  } catch (cause) {
    throw new CandidateDevelopmentSourceVerificationError(operation, cause)
  }
}

const candidateDevelopmentGitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))

const gitText = (repositoryRoot: string, args: readonly string[], signal?: AbortSignal): Promise<string> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryRoot, ...args],
      {
        encoding: 'utf8',
        env: candidateDevelopmentGitEnvironment(),
        maxBuffer: 16 * 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        if (error === null) resolveGit(stdout.trim())
        else rejectGit(error)
      },
    )
  })

const gitBytes = (repositoryRoot: string, args: readonly string[], signal?: AbortSignal): Promise<Buffer> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryRoot, ...args],
      {
        encoding: 'buffer',
        env: candidateDevelopmentGitEnvironment(),
        maxBuffer: 64 * 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        if (error === null) resolveGit(stdout)
        else rejectGit(error)
      },
    )
  })

const candidateDevelopmentMaximumGitObjectBytes = 64 * 1024 * 1024
const candidateDevelopmentMaximumGitBatchHeaderBytes = 512
const candidateDevelopmentMaximumGitStderrBytes = 1024 * 1024

class CandidateDevelopmentGitBatchOutput {
  private readonly chunks: Buffer<ArrayBufferLike>[] = []
  private bufferedBytes = 0
  private ended = false
  private failure: unknown
  private waiter: (() => void) | undefined

  constructor(private readonly stream: Readable) {
    stream.pause()
    stream.on('readable', () => this.wake())
    stream.on('end', () => {
      this.ended = true
      this.wake()
    })
    stream.on('error', (cause) => {
      this.failure = cause
      this.wake()
    })
  }

  private wake(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  fail(cause: unknown): void {
    if (this.failure === undefined) this.failure = cause
    this.wake()
  }

  private async waitForData(): Promise<void> {
    if (this.failure !== undefined) throw this.failure
    if (this.ended) throw new Error('candidate Git batch output ended unexpectedly')
    await new Promise<void>((resolveWait) => {
      this.waiter = resolveWait
    })
    if (this.failure !== undefined) throw this.failure
  }

  private pullAvailable(): void {
    const chunk = this.stream.read() as Buffer | string | null
    if (chunk === null) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.chunks.push(bytes)
    this.bufferedBytes += bytes.length
  }

  private indexOf(value: number): number {
    let offset = 0
    for (const chunk of this.chunks) {
      const index = chunk.indexOf(value)
      if (index >= 0) return offset + index
      offset += chunk.length
    }
    return -1
  }

  private consume(size: number): Buffer {
    if (size === 0) return Buffer.alloc(0)
    const value = Buffer.allocUnsafe(size)
    let written = 0
    while (written < size) {
      const chunk = this.chunks[0]
      if (chunk === undefined) throw new Error('candidate Git batch output is incomplete')
      const remaining = size - written
      const consumed = Math.min(remaining, chunk.length)
      chunk.copy(value, written, 0, consumed)
      written += consumed
      this.bufferedBytes -= consumed
      if (consumed === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(consumed)
    }
    return value
  }

  async readLine(): Promise<string> {
    while (true) {
      this.pullAvailable()
      const newline = this.indexOf(0x0a)
      if (newline >= 0) {
        const line = this.consume(newline).toString('utf8')
        this.consume(1)
        return line
      }
      if (this.bufferedBytes > candidateDevelopmentMaximumGitBatchHeaderBytes) {
        throw new Error('candidate Git batch header exceeds the configured bound')
      }
      await this.waitForData()
    }
  }

  async readBytes(size: number): Promise<Buffer> {
    while (this.bufferedBytes < size) {
      this.pullAvailable()
      if (this.bufferedBytes >= size) break
      await this.waitForData()
    }
    return this.consume(size)
  }
}

const terminateCandidateDevelopmentGitBatch = async (
  child: ChildProcessWithoutNullStreams,
  exit: Promise<void>,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exit.catch(() => undefined)
    return
  }
  child.stdin.end()
  const completed = await Promise.race([
    exit.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 1_000)),
  ])
  if (!completed && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exit.catch(() => undefined)
  }
}

export const openCandidateDevelopmentGitBatchObjectReader = async (
  repositoryRoot: string,
  signal: AbortSignal,
  maximumObjectBytes = candidateDevelopmentMaximumGitObjectBytes,
): Promise<CandidateDevelopmentGitObjectReader> => {
  const child = spawn('git', ['--no-replace-objects', '-C', repositoryRoot, 'cat-file', '--batch'], {
    env: candidateDevelopmentGitEnvironment(),
    signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output = new CandidateDevelopmentGitBatchOutput(child.stdout)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer | string) => {
    if (stderr.length >= candidateDevelopmentMaximumGitStderrBytes) return
    stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    if (stderr.length > candidateDevelopmentMaximumGitStderrBytes) {
      stderr = stderr.slice(0, candidateDevelopmentMaximumGitStderrBytes)
    }
  })
  const exit = new Promise<void>((resolveExit) => {
    child.once('error', (cause) => {
      output.fail(cause)
      resolveExit()
    })
    child.once('exit', (code, exitSignal) => {
      if (code !== 0 && !(signal.aborted && exitSignal !== null)) {
        output.fail(new Error(`candidate Git batch exited ${code ?? exitSignal}: ${stderr}`))
      }
      resolveExit()
    })
  })
  let closed = false
  const failAndTerminate = (cause: Error): never => {
    output.fail(cause)
    child.stdin.destroy()
    child.stdout.destroy()
    child.kill('SIGKILL')
    throw cause
  }
  return {
    read: async (oid, expectedType) => {
      if (closed) throw new Error('candidate Git batch reader is closed')
      if (!/^[0-9a-f]{40}$/.test(oid)) throw new TypeError(`candidate Git object OID is invalid: ${oid}`)
      await new Promise<void>((resolveWrite, rejectWrite) => {
        child.stdin.write(`${oid}\n`, (cause) => {
          if (cause === null || cause === undefined) resolveWrite()
          else rejectWrite(cause)
        })
      })
      const header = await output.readLine()
      if (header === `${oid} missing`) failAndTerminate(new Error(`candidate Git object is missing: ${oid}`))
      const parsed = /^([0-9a-f]{40}) (blob|commit|tag|tree) ([0-9]+)$/.exec(header)
      const match =
        parsed === null ? failAndTerminate(new Error(`candidate Git batch header is invalid: ${header}`)) : parsed
      const [, observedOid, observedType, encodedSize] = match
      const size = Number(encodedSize)
      if (
        observedOid !== oid ||
        observedType !== expectedType ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > maximumObjectBytes
      ) {
        failAndTerminate(
          new Error(
            `candidate Git batch object mismatch: ${JSON.stringify({ oid, expectedType, observedOid, observedType, size, maximumObjectBytes })}`,
          ),
        )
      }
      const content = await output.readBytes(size)
      const delimiter = await output.readBytes(1)
      if (delimiter[0] !== 0x0a) failAndTerminate(new Error('candidate Git batch object delimiter is invalid'))
      return content
    },
    close: async () => {
      if (closed) return
      closed = true
      await terminateCandidateDevelopmentGitBatch(child, exit)
    },
  }
}

export const candidateDevelopmentSourceGit: CandidateDevelopmentSourceGit = {
  text: gitText,
  bytes: gitBytes,
  openObjectReader: openCandidateDevelopmentGitBatchObjectReader,
}
