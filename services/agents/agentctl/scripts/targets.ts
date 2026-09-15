export type TargetInfo = {
  arch: 'amd64' | 'arm64'
  bunTarget: string
  label: string
  platform: 'darwin' | 'linux'
}

export const TARGETS: TargetInfo[] = [
  {
    arch: 'amd64',
    bunTarget: 'bun-darwin-x64',
    label: 'darwin-amd64',
    platform: 'darwin',
  },
  {
    arch: 'arm64',
    bunTarget: 'bun-darwin-arm64',
    label: 'darwin-arm64',
    platform: 'darwin',
  },
  {
    arch: 'amd64',
    bunTarget: 'bun-linux-x64',
    label: 'linux-amd64',
    platform: 'linux',
  },
  {
    arch: 'arm64',
    bunTarget: 'bun-linux-arm64',
    label: 'linux-arm64',
    platform: 'linux',
  },
]

const aliasToLabel = new Map<string, string>([
  ['darwin-x64', 'darwin-amd64'],
  ['linux-x64', 'linux-amd64'],
  ['macos-x64', 'darwin-amd64'],
  ['macos-arm64', 'darwin-arm64'],
])

const targetByBun = new Map(TARGETS.map((target) => [target.bunTarget, target]))
const targetByLabel = new Map(TARGETS.map((target) => [target.label, target]))

const mustGetTarget = (key: string): TargetInfo => {
  const target = targetByBun.get(key)
  if (!target) {
    throw new Error(`Unknown target mapping for ${key}`)
  }
  return target
}

export const parseTargetsArgs = (argv: string[]) => {
  let all = false
  const targets: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) {
      continue
    }

    if (arg === '--all') {
      all = true
      continue
    }

    if (arg === '--targets' || arg === '--target') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error(`${arg} requires a value`)
      }
      targets.push(
        ...value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      )
      i += 1
      continue
    }

    if (arg.startsWith('--targets=')) {
      targets.push(
        ...arg
          .replace('--targets=', '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      )
      continue
    }

    if (arg.startsWith('--target=')) {
      targets.push(
        ...arg
          .replace('--target=', '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      )
    }
  }

  return { all, targets }
}

export const resolveTarget = (value: string): TargetInfo | undefined => {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  const direct = targetByBun.get(trimmed) ?? targetByLabel.get(trimmed)
  if (direct) {
    return direct
  }

  const alias = aliasToLabel.get(trimmed)
  if (alias) {
    return targetByLabel.get(alias)
  }

  return undefined
}

export const resolveHostTarget = (): TargetInfo => {
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      return mustGetTarget('bun-darwin-arm64')
    }
    return mustGetTarget('bun-darwin-x64')
  }

  if (process.platform === 'linux') {
    if (process.arch === 'arm64') {
      return mustGetTarget('bun-linux-arm64')
    }
    return mustGetTarget('bun-linux-x64')
  }

  throw new Error(`Unsupported host platform: ${process.platform} ${process.arch}`)
}

export const resolveTargets = (argv: string[], envTargets?: string): TargetInfo[] => {
  const { all, targets } = parseTargetsArgs(argv)

  if (all) {
    return [...TARGETS]
  }

  const requested =
    targets.length > 0
      ? targets
      : envTargets
        ? envTargets
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : []

  if (requested.length === 0) {
    return [resolveHostTarget()]
  }

  const resolved: TargetInfo[] = []
  const seen = new Set<string>()

  for (const entry of requested) {
    const target = resolveTarget(entry)
    if (!target) {
      throw new Error(`Unknown target: ${entry}`)
    }
    if (seen.has(target.bunTarget)) {
      continue
    }
    seen.add(target.bunTarget)
    resolved.push(target)
  }

  return resolved
}
