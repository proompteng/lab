import process from 'node:process'

export type SpawnStream = 'inherit' | 'pipe' | 'ignore'

export type SpawnOptions = {
  stdin?: SpawnStream
  stdout?: SpawnStream
  stderr?: SpawnStream
  env?: NodeJS.ProcessEnv
}

export const usage = (text: string) => {
  process.stdout.write(`${text}\n`)
}

export const hasOption = (args: string[], ...options: string[]) => {
  return options.some((option) => args.includes(option))
}

export const getOptionValue = (args: string[], ...options: string[]) => {
  for (const option of options) {
    const index = args.indexOf(option)
    if (index !== -1 && index + 1 < args.length) {
      const value = args[index + 1]
      if (value) {
        return value
      }
    }
  }
  return null
}

export const isMissingRequiredOption = (args: string[], ...options: string[]) => {
  return !hasOption(args, ...options)
}

export const requireOption = (args: string[], errorMessage: string, ...options: string[]) => {
  if (isMissingRequiredOption(args, ...options)) {
    throw new Error(errorMessage)
  }
}

export const resolveBinary = (name: string) => {
  const binary = Bun.which(name)
  if (!binary) {
    throw new Error(`Required binary not found in PATH: ${name}`)
  }
  return binary
}

export const runCommand = async (binary: string, args: string[], options: SpawnOptions = {}) => {
  const env = options.env ? { ...process.env, ...options.env } : process.env
  const proc = Bun.spawn([binary, ...args], {
    stdin: options.stdin ?? 'inherit',
    stdout: options.stdout ?? 'inherit',
    stderr: options.stderr ?? 'inherit',
    env,
  })

  const exitCode = await proc.exited
  return exitCode ?? 1
}

export const maybeAppendOption = (args: string[], option: string, value: string, aliases: string[] = []) => {
  if (hasOption(args, option, ...aliases)) {
    return args
  }
  return [...args, option, value]
}

export const exitWithError = (message: string, usageText?: string) => {
  process.stderr.write(`${message}\n`)
  if (usageText) {
    process.stderr.write(`\n${usageText}\n`)
  }
  return 1
}

export const applyTemporalDefaults = (args: string[]) => {
  let normalized = [...args]
  const namespace =
    getOptionValue(args, '--namespace', '-n') ?? process.env.TEMPORAL_NAMESPACE ?? process.env.TEMPORAL_NAMESPACE_ID
  const address = getOptionValue(args, '--address') ?? process.env.TEMPORAL_ADDRESS

  if (namespace) {
    normalized = maybeAppendOption(normalized, '--namespace', namespace)
  }

  if (address) {
    normalized = maybeAppendOption(normalized, '--address', address)
  }

  return normalized
}
