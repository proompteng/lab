import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'

import { isRecord } from './spec'

export const readRunnerInputFile = async (path: string, signal?: AbortSignal): Promise<string> => {
  signal?.throwIfAborted()
  if (!(await stat(path)).isFile()) throw new Error(`${path} is not a regular file`)
  return readFile(path, { encoding: 'utf8', signal })
}

export const checkWorkspaceDirectory = async (cwd: string): Promise<void> => {
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Codex workspace ${cwd} is not a directory`)
  await access(cwd, constants.W_OK | constants.X_OK).catch(() => {
    throw new Error(`Codex workspace ${cwd} must be writable and searchable by the runner`)
  })
}

export const checkCodexExecutable = async (binary: string, cwd = process.cwd()): Promise<void> => {
  const candidates = binary.includes('/')
    ? [resolve(cwd, binary)]
    : (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).map((directory) => resolve(cwd, directory, binary))
  for (const path of candidates) {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) continue
    if (
      await access(path, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return
  }
  throw new Error(
    `Codex app-server binary ${binary} is not executable; check adapter.codex.binaryPath or AGENTS_CODEX_BINARY`,
  )
}

export const checkCodexAuth = async (binary: string, signal?: AbortSignal): Promise<void> => {
  const mountedAuth = process.env.CODEX_AUTH?.trim()
  // A custom app-server (including the image smoke fixture) can have its own auth contract.
  if (!mountedAuth && basename(binary) !== 'codex') return
  if (!mountedAuth && (process.env.CODEX_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim())) return

  const path = mountedAuth || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
  const authError = `Codex auth preflight: mount a readable Codex auth.json at ${path} (CODEX_AUTH/CODEX_HOME) or configure a Codex API key`
  try {
    const auth: unknown = JSON.parse(await readRunnerInputFile(path, signal))
    if (
      isRecord(auth) &&
      ((typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) ||
        (isRecord(auth.tokens) && typeof auth.tokens.access_token === 'string' && auth.tokens.access_token.trim()))
    )
      return
  } catch {
    signal?.throwIfAborted()
    // JSON parse errors can echo the secret file contents.
  }
  throw new Error(authError)
}
