import type { Schema } from 'effect'

export const canonicalOrderIssues = (path: string, values: readonly string[]): readonly Schema.FilterIssue[] => {
  const canonical = [...new Set(values)].sort()
  if (canonical.length !== values.length) return [{ path: [path], issue: 'must not contain duplicates' }]
  if (canonical.some((value, index) => value !== values.at(index))) {
    return [{ path: [path], issue: 'must be strictly increasing' }]
  }
  return []
}

export const isCanonicalOrder = (values: readonly string[]): boolean =>
  canonicalOrderIssues('values', values).length === 0
