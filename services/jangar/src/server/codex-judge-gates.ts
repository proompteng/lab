export type CodexLogExcerpt = {
  output?: string | null
  events?: string | null
  agent?: string | null
  runtime?: string | null
  status?: string | null
}

export type DeterministicGateFailure = {
  decision: 'needs_human' | 'needs_iteration'
  reason: string
  detail?: string
  suggestedFix: string
  nextPrompt: string | null
}

type NoopContext = {
  issueTitle?: string | null
  issueBody?: string | null
  prompt?: string | null
  runCompletePayload?: Record<string, unknown> | null
}

type GateContext = NoopContext & {
  diff: string
  logExcerpt?: CodexLogExcerpt | null
}

const NOOP_MARKERS = [
  'codex:allow-noop',
  'codex:allow-no-op',
  '#codex-allow-noop',
  '#codex-allow-no-op',
  '[codex:allow-noop]',
  '[codex:allow-no-op]',
]

const CONFLICT_MARKER_OVERRIDES = [
  'codex:allow-conflict-markers',
  '#codex-allow-conflict-markers',
  '[codex:allow-conflict-markers]',
]

const CONFLICT_STATUS_CODES = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']

const CONFLICT_MARKER_REGEX = /^[+\- ]?(<{7}|={7}|>{7})/

const LOG_CONFLICT_REGEX = /(merge conflict|unmerged paths|\bCONFLICT\b)/i
const PATCH_FAILURE_REGEX =
  /(patch failed|apply failed|failed to apply|could not apply|error:.*patch failed|3-way merge failed)/i

const normalizeText = (value?: string | null) => (typeof value === 'string' ? value.trim() : '')

const hasNoopMarker = (text: string) => {
  if (!text) return false
  const lowered = text.toLowerCase()
  return NOOP_MARKERS.some((marker) => lowered.includes(marker))
}

const hasConflictMarkerOverride = (text: string) => {
  if (!text) return false
  const lowered = text.toLowerCase()
  return CONFLICT_MARKER_OVERRIDES.some((marker) => lowered.includes(marker))
}

const readNoopFlag = (payload?: Record<string, unknown> | null) => {
  if (!payload) return false
  const candidates = [
    payload.allowNoop,
    payload.allow_noop,
    payload.allowNoOp,
    payload.noop,
    payload.noopAllowed,
    payload.no_op_allowed,
    payload.noOpAllowed,
  ]

  for (const candidate of candidates) {
    if (candidate === true) return true
    if (typeof candidate === 'string' && candidate.trim().toLowerCase() === 'true') return true
  }

  return false
}

const readConflictMarkerFlag = (payload?: Record<string, unknown> | null) => {
  if (!payload) return false
  const candidates = [
    payload.allowConflictMarkers,
    payload.allow_conflict_markers,
    payload.allowConflictMarker,
    payload.allow_conflict_marker,
    payload.conflictMarkersAllowed,
    payload.conflict_markers_allowed,
    payload.conflictMarkerAllowed,
    payload.conflict_marker_allowed,
  ]

  for (const candidate of candidates) {
    if (candidate === true) return true
    if (typeof candidate === 'string' && candidate.trim().toLowerCase() === 'true') return true
  }

  return false
}

export const isNoopAllowed = ({ issueTitle, issueBody, prompt, runCompletePayload }: NoopContext) => {
  if (readNoopFlag(runCompletePayload)) return true
  const combined = [issueTitle, issueBody, prompt].map((value) => normalizeText(value)).join('\n')
  return hasNoopMarker(combined)
}

// Explicit codex:allow-conflict-markers markers/flags skip conflict-marker detection in diff/logs.
export const isConflictMarkerAllowed = ({ issueTitle, issueBody, prompt, runCompletePayload }: NoopContext) => {
  if (readConflictMarkerFlag(runCompletePayload)) return true
  const combined = [issueTitle, issueBody, prompt].map((value) => normalizeText(value)).join('\n')
  return hasConflictMarkerOverride(combined)
}

const extractStatusConflicts = (status: string) => {
  const lines = status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
  const conflictLines = lines.filter((line) => CONFLICT_STATUS_CODES.some((code) => line.startsWith(`${code} `)))
  return conflictLines.slice(0, 3)
}

const extractConflictMarkers = (diff: string) => {
  const lines = diff
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
  const markers = lines.filter((line) => CONFLICT_MARKER_REGEX.test(line))
  return markers.slice(0, 3)
}

const collectLogText = (logExcerpt?: CodexLogExcerpt | null) => {
  if (!logExcerpt) return ''
  return [logExcerpt.output, logExcerpt.events, logExcerpt.agent, logExcerpt.runtime, logExcerpt.status]
    .map((value) => normalizeText(value))
    .filter((value) => value.length > 0)
    .join('\n')
}

const detectConflictSignals = ({
  diff,
  logExcerpt,
  allowConflictMarkers,
}: Pick<GateContext, 'diff' | 'logExcerpt'> & { allowConflictMarkers?: boolean }) => {
  const details: string[] = []
  const statusText = normalizeText(logExcerpt?.status ?? null)
  const conflictLines = statusText ? extractStatusConflicts(statusText) : []
  if (conflictLines.length > 0) {
    details.push(`git status reports unmerged entries (${conflictLines.join(', ')})`)
  }

  const diffMarkers = allowConflictMarkers ? [] : extractConflictMarkers(diff)
  if (diffMarkers.length > 0) {
    details.push('diff contains conflict markers')
  }

  const logText = collectLogText(logExcerpt)
  const logHasConflict = !allowConflictMarkers && logText.length > 0 && LOG_CONFLICT_REGEX.test(logText)
  if (logHasConflict) {
    details.push('log excerpt mentions merge conflicts')
  }

  const logHasPatchFailure = logText.length > 0 && PATCH_FAILURE_REGEX.test(logText)
  if (logHasPatchFailure) {
    details.push('log excerpt indicates patch apply failure')
  }

  const mergeConflict = conflictLines.length > 0 || diffMarkers.length > 0 || logHasConflict

  return { mergeConflict, patchApplyFailure: logHasPatchFailure, details }
}

export const evaluateDeterministicGates = ({
  diff,
  logExcerpt,
  issueTitle,
  issueBody,
  prompt,
  runCompletePayload,
}: GateContext): DeterministicGateFailure | null => {
  const normalizedDiff = typeof diff === 'string' ? diff : ''
  const allowConflictMarkers = isConflictMarkerAllowed({ issueTitle, issueBody, prompt, runCompletePayload })
  const conflictSignals = detectConflictSignals({ diff: normalizedDiff, logExcerpt, allowConflictMarkers })
  if (conflictSignals.mergeConflict) {
    return {
      decision: 'needs_human',
      reason: 'merge_conflict',
      detail: conflictSignals.details.slice(0, 2).join('; '),
      suggestedFix: 'Resolve merge conflicts on the branch and update the PR.',
      nextPrompt: 'Resolve merge conflicts on the branch and update the PR.',
    }
  }

  if (conflictSignals.patchApplyFailure) {
    return {
      decision: 'needs_iteration',
      reason: 'patch_apply_failed',
      detail: conflictSignals.details.slice(0, 2).join('; '),
      suggestedFix: 'Reapply the patch cleanly and ensure the working tree is consistent.',
      nextPrompt: 'Reapply the patch cleanly and ensure the working tree is consistent.',
    }
  }

  const diffEmpty = normalizedDiff.trim().length === 0
  const noopAllowed = isNoopAllowed({ issueTitle, issueBody, prompt, runCompletePayload })
  if (diffEmpty && !noopAllowed) {
    return {
      decision: 'needs_iteration',
      reason: 'empty_diff',
      suggestedFix: 'Produce a non-empty diff or explicitly mark the task as a no-op.',
      nextPrompt: 'Make the required code changes so the PR includes a non-empty diff.',
    }
  }

  return null
}
