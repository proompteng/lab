import { resolve } from 'node:path'

export interface CodexEnvOptions {
  baseEnv?: Record<string, string>
  workdir?: string
  depth?: number
  toolbeltBinDir?: string
}

export const buildCodexEnv = ({
  baseEnv = {},
  workdir,
  depth,
  toolbeltBinDir,
}: CodexEnvOptions): Record<string, string> => {
  const env: Record<string, string> = { ...process.env, ...baseEnv }

  if (toolbeltBinDir) {
    env.PATH = `${toolbeltBinDir}:${env.PATH ?? ''}`
  }

  if (depth !== undefined) {
    env.CX_DEPTH = String(depth)
  }

  if (workdir) {
    env.CODEX_HOME = resolve(workdir, '.codex')
  }

  // TODO(jng-001): add CODEX_PATH/CODEX_API_KEY wiring once secrets are finalized.
  return env
}
