import { createHash } from 'node:crypto'

const KUBERNETES_LABEL_VALUE_MAX_LENGTH = 63
const KUBERNETES_LABEL_VALUE_RE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/

const trimInvalidLabelEdges = (value: string) => value.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '')

export const normalizeKubernetesLabelValue = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.length <= KUBERNETES_LABEL_VALUE_MAX_LENGTH && KUBERNETES_LABEL_VALUE_RE.test(trimmed)) {
    return trimmed
  }

  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12)
  const sanitized = trimInvalidLabelEdges(trimmed.replace(/[^A-Za-z0-9_.-]+/g, '-'))
  const stemMaxLength = KUBERNETES_LABEL_VALUE_MAX_LENGTH - hash.length - 1
  const stem = trimInvalidLabelEdges(sanitized.slice(0, stemMaxLength)) || 'delivery'
  return `${stem}-${hash}`
}
