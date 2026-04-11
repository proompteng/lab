export const hashNameSuffix = (value: string) => {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash).toString(36).padStart(8, '0').slice(0, 8)
}

export const makeName = (base: string, suffix: string) => {
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
  const maxBaseLength = 45
  if (sanitized.length <= maxBaseLength) {
    return `${sanitized}-${suffix}`
  }
  const trimmed = sanitized.slice(0, maxBaseLength)
  return `${trimmed}-${suffix}`
}

export const makeHashedName = (base: string, suffix: string) => {
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
  const maxBaseLength = 63 - 1 - suffix.length
  if (sanitized.length <= maxBaseLength) {
    return `${sanitized}-${suffix}`
  }
  const hash = hashNameSuffix(base)
  const separator = '-'
  const hashBaseLength = Math.max(1, maxBaseLength - hash.length - separator.length)
  const hashBase = sanitized.slice(0, hashBaseLength)
  return `${hashBase}-${hash}-${suffix}`
}
