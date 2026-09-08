import { join } from 'node:path'

type EnvSource = Record<string, string | undefined>

const DEFAULT_WORKTREE = '/workspace/lab'

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

export type RuntimeAdmissionConfig = {
  worktree: string
  natsUrl: string
  runtimeImage: string
  pathEntries: string[]
}

export const resolveRuntimeAdmissionConfig = (env: EnvSource = process.env): RuntimeAdmissionConfig => ({
  worktree: normalizeNonEmpty(env.WORKTREE) ?? (process.cwd().trim() || DEFAULT_WORKTREE),
  natsUrl: normalizeNonEmpty(env.NATS_URL) ?? normalizeNonEmpty(env.natsUrl) ?? '',
  runtimeImage:
    normalizeNonEmpty(env.AGENTS_RUNTIME_IMAGE) ??
    normalizeNonEmpty(env.AGENTS_IMAGE) ??
    normalizeNonEmpty(env.IMAGE_REF) ??
    'runtime:local',
  pathEntries: (env.PATH ?? '').split(':').filter((entry) => entry.length > 0),
})

export const resolveCodexNatsHelperPathCandidatesFromConfig = (
  config: RuntimeAdmissionConfig,
  command: 'codex-nats-publish' | 'codex-nats-soak',
  cwd = process.cwd(),
) => [
  ...config.pathEntries.map((entry) => join(entry, command)),
  join(cwd, 'packages', 'cx-tools', 'dist', `${command}.js`),
  join(cwd, 'packages', 'cx-tools', 'src', 'cli', `${command}.ts`),
  join(cwd, 'scripts', `${command}.ts`),
  join(config.worktree, 'packages', 'cx-tools', 'dist', `${command}.js`),
  join(config.worktree, 'packages', 'cx-tools', 'src', 'cli', `${command}.ts`),
  join('/usr/local/bin', command),
]
