import { createHash } from 'node:crypto'

import type { PullRequestCheckFailure, PullRequestReviewThread } from '@/services/github/types'

interface BuildReviewFingerprintOptions {
  headSha: string
  outstandingWork: boolean
  forceReview: boolean
  mergeStateRequiresAttention: boolean
  mergeState?: string | null
  hasMergeConflicts: boolean
  reviewThreads: PullRequestReviewThread[]
  failingChecks: PullRequestCheckFailure[]
}

const MAX_CACHE_SIZE = 500
const fingerprintCache = new Map<string, string>()

const sanitizeValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : value === undefined || value === null ? '' : String(value)

const sortThreads = (threads: PullRequestReviewThread[]) =>
  [...threads]
    .map((thread) => ({
      summary: sanitizeValue(thread.summary),
      url: sanitizeValue(thread.url),
      author: sanitizeValue(thread.author),
    }))
    .filter((thread) => thread.summary.length > 0)
    .sort((a, b) => {
      const summaryDiff = a.summary.localeCompare(b.summary)
      if (summaryDiff !== 0) {
        return summaryDiff
      }
      const urlDiff = a.url.localeCompare(b.url)
      if (urlDiff !== 0) {
        return urlDiff
      }
      return a.author.localeCompare(b.author)
    })

const sortChecks = (checks: PullRequestCheckFailure[]) =>
  [...checks]
    .map((check) => ({
      name: sanitizeValue(check.name),
      conclusion: sanitizeValue(check.conclusion),
      url: sanitizeValue(check.url),
      details: sanitizeValue(check.details),
    }))
    .filter((check) => check.name.length > 0)
    .sort((a, b) => {
      const nameDiff = a.name.localeCompare(b.name)
      if (nameDiff !== 0) {
        return nameDiff
      }
      const conclusionDiff = a.conclusion.localeCompare(b.conclusion)
      if (conclusionDiff !== 0) {
        return conclusionDiff
      }
      const urlDiff = a.url.localeCompare(b.url)
      if (urlDiff !== 0) {
        return urlDiff
      }
      return a.details.localeCompare(b.details)
    })

export const buildReviewFingerprint = (options: BuildReviewFingerprintOptions): string => {
  const payload = {
    headSha: sanitizeValue(options.headSha),
    outstandingWork: options.outstandingWork,
    forceReview: options.forceReview,
    mergeStateRequiresAttention: options.mergeStateRequiresAttention,
    mergeState: sanitizeValue(options.mergeState),
    hasMergeConflicts: options.hasMergeConflicts,
    threads: sortThreads(options.reviewThreads),
    checks: sortChecks(options.failingChecks),
  }

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)
}

const trimCache = () => {
  if (fingerprintCache.size <= MAX_CACHE_SIZE) {
    return
  }
  const iterator = fingerprintCache.keys()
  const first = iterator.next()
  if (!first.done) {
    fingerprintCache.delete(first.value)
  }
}

export const rememberReviewFingerprint = (key: string, fingerprint: string): boolean => {
  const cached = fingerprintCache.get(key)
  if (cached === fingerprint) {
    return false
  }
  fingerprintCache.set(key, fingerprint)
  trimCache()
  return true
}

export const forgetReviewFingerprint = (key: string, fingerprint: string) => {
  const cached = fingerprintCache.get(key)
  if (cached === fingerprint) {
    fingerprintCache.delete(key)
  }
}

export const clearReviewFingerprintCacheForTest = () => {
  fingerprintCache.clear()
}
