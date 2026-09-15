export const normalizeValue = (value: string | undefined) => {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : undefined
}

const parseInteger = (value: string) => {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined
  }
  return parsed
}

const hasFlag = (args: string[], flag: string) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))

const prependIfMissing = (args: string[], flag: string, value?: string) => {
  if (hasFlag(args, flag)) {
    return args
  }
  if (!value) {
    return args
  }
  return [...args, flag, value]
}

export const resolveTemporalAddress = () => {
  const explicitAddress = normalizeValue(process.env.TEMPORAL_ADDRESS)
  if (explicitAddress) {
    return explicitAddress
  }

  const host = normalizeValue(process.env.TEMPORAL_HOST)
  if (!host) {
    return undefined
  }

  const portRaw = normalizeValue(process.env.TEMPORAL_GRPC_PORT)
  const port = portRaw ? parseInteger(portRaw) : undefined
  return `${host}:${port ?? 7233}`
}

export const temporalDefaultsFromEnv = () => ({
  address: resolveTemporalAddress(),
  namespace: normalizeValue(process.env.TEMPORAL_NAMESPACE),
  taskQueue: normalizeValue(process.env.TEMPORAL_TASK_QUEUE),
})

export const withTemporalDefaults = (args: string[], includeTaskQueue = false) => {
  const defaults = temporalDefaultsFromEnv()
  const withAddress = prependIfMissing(args, '--address', defaults.address)
  const withNamespace = prependIfMissing(withAddress, '--namespace', defaults.namespace)
  return includeTaskQueue ? prependIfMissing(withNamespace, '--task-queue', defaults.taskQueue) : withNamespace
}
