import { spawn } from 'node:child_process'

export const DEFAULT_ATLAS_REPOSITORY = 'proompteng/lab'
export const DEFAULT_ATLAS_REF = 'main'

export type GitCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export const normalizeSearchParam = (value: string | null) => value?.trim() ?? ''

export const resolveLimit = (raw: string, fallback: number, max: number) => {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  if (parsed > max) return max
  return parsed
}

const resolveRepoCwd = () => {
  const envCwd = process.env.CODEX_CWD?.trim()
  if (envCwd) return envCwd
  return process.cwd()
}

const readProcessText = async (stream: ReadableStream | null) => {
  if (!stream) return ''
  return new Response(stream).text()
}

const runNodeCommand = async (args: string[]): Promise<GitCommandResult> =>
  new Promise((resolve) => {
    const child = spawn('git', args, { cwd: resolveRepoCwd() })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      resolve({ exitCode: 1, stdout: '', stderr: error.message })
    })
    child.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr })
    })
  })

export const runGitCommand = async (args: string[]): Promise<GitCommandResult> => {
  const bunRuntime = (globalThis as { Bun?: typeof Bun }).Bun
  if (!bunRuntime) {
    return runNodeCommand(args)
  }

  const process = bunRuntime.spawn(['git', ...args], {
    cwd: resolveRepoCwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await process.exited
  const stdout = await readProcessText(process.stdout)
  const stderr = await readProcessText(process.stderr)
  return { exitCode, stdout, stderr }
}

type AtlasRepositoryResult = { ok: true; repository: string } | { ok: false; message: string }

type AtlasRefResult = { ok: true } | { ok: false; message: string }

export const resolveAtlasRepository = (rawRepository: string): AtlasRepositoryResult => {
  const repository = rawRepository.trim()
  if (repository && repository !== DEFAULT_ATLAS_REPOSITORY) {
    return { ok: false, message: 'Only proompteng/lab is available for Atlas right now.' }
  }
  return { ok: true, repository: repository || DEFAULT_ATLAS_REPOSITORY }
}

export const ensureGitRef = async (ref: string): Promise<AtlasRefResult> => {
  if (!ref) return { ok: false, message: 'Ref is required.' }
  if (ref.startsWith('-')) return { ok: false, message: 'Invalid ref.' }

  const result = await runGitCommand(['rev-parse', '--verify', ref])
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim()
    return { ok: false, message: detail || 'Ref not found.' }
  }

  return { ok: true }
}

export const ensureFileAtRef = async (ref: string, path: string): Promise<AtlasRefResult> => {
  if (!path) return { ok: false, message: 'File path is required.' }
  const result = await runGitCommand(['cat-file', '-e', `${ref}:${path}`])
  if (result.exitCode !== 0) return { ok: false, message: 'File not found at ref.' }
  return { ok: true }
}
