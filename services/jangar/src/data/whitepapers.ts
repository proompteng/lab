export type WhitepaperListItem = {
  runId: string
  status: string
  triggerSource: string
  triggerActor: string | null
  failureReason: string | null
  createdAt: string | null
  startedAt: string | null
  completedAt: string | null
  document: {
    key: string | null
    title: string | null
    source: string | null
    sourceIdentifier: string | null
    status: string | null
    lastProcessedAt: string | null
  }
  version: {
    versionNumber: number | null
    parseStatus: string | null
    fileName: string | null
    fileSizeBytes: number | null
    checksumSha256: string | null
    cephBucket: string | null
    cephObjectKey: string | null
    sourceAttachmentUrl: string | null
  }
  latestAgentrun: {
    name: string | null
    status: string | null
    headBranch: string | null
    startedAt: string | null
    completedAt: string | null
  } | null
  verdict: {
    verdict: string | null
    score: number | null
    confidence: number | null
    requiresFollowup: boolean
  } | null
  designPullRequest: {
    status: string | null
    prNumber: number | null
    prUrl: string | null
    isMerged: boolean
  } | null
  engineeringTrigger: {
    implementationGrade: string | null
    decision: string | null
    rolloutProfile: string | null
    approvalSource: string | null
    dispatchedAgentrunName: string | null
  } | null
}

export type WhitepaperDetail = {
  run: {
    id: string
    runId: string
    status: string
    triggerSource: string
    triggerActor: string | null
    failureCode: string | null
    failureReason: string | null
    createdAt: string | null
    startedAt: string | null
    completedAt: string | null
    requestPayload: unknown
    resultPayload: unknown
  }
  document: {
    id: string
    key: string | null
    title: string | null
    source: string | null
    sourceIdentifier: string | null
    status: string | null
    lastProcessedAt: string | null
    metadata: unknown
    createdAt: string | null
  }
  version: {
    id: string
    versionNumber: number | null
    fileName: string | null
    fileSizeBytes: number | null
    checksumSha256: string | null
    parseStatus: string | null
    parseError: string | null
    pageCount: number | null
    charCount: number | null
    tokenCount: number | null
    cephBucket: string | null
    cephObjectKey: string | null
    uploadedBy: string | null
    uploadMetadata: unknown
    createdAt: string | null
  }
  pdf: {
    fileName: string | null
    cephBucket: string | null
    cephObjectKey: string | null
    sourceAttachmentUrl: string | null
  }
  synthesis: {
    executiveSummary: string | null
    methodologySummary: string | null
    problemStatement: string | null
    implementationPlanMd: string | null
    confidence: number | null
    keyFindings: string[]
    noveltyClaims: string[]
    riskAssessment: unknown
    citations: unknown
    raw: unknown
  } | null
  verdict: {
    verdict: string | null
    score: number | null
    confidence: number | null
    decisionPolicy: string | null
    rationale: string | null
    requiresFollowup: boolean
    rejectionReasons: string[]
    recommendations: string[]
    gating: unknown
  } | null
  engineeringTrigger: {
    triggerId: string
    implementationGrade: string
    decision: string
    reasonCodes: string[]
    approvalToken: string | null
    dispatchedAgentrunName: string | null
    rolloutProfile: string
    approvalSource: string | null
    approvedBy: string | null
    approvedAt: string | null
    approvalReason: string | null
    policyRef: string | null
    gateSnapshotHash: string | null
    gateSnapshot: unknown
    createdAt: string | null
    updatedAt: string | null
  } | null
  latestAgentrun: {
    id: string
    name: string
    status: string
    requestedBy: string | null
    namespace: string | null
    vcsRepository: string | null
    vcsBaseBranch: string | null
    vcsHeadBranch: string | null
    startedAt: string | null
    completedAt: string | null
    failureReason: string | null
    logArtifactRef: string | null
    patchArtifactRef: string | null
    createdAt: string | null
  } | null
  agentruns: {
    id: string
    name: string
    status: string
    requestedBy: string | null
    namespace: string | null
    vcsRepository: string | null
    vcsBaseBranch: string | null
    vcsHeadBranch: string | null
    startedAt: string | null
    completedAt: string | null
    failureReason: string | null
    logArtifactRef: string | null
    patchArtifactRef: string | null
    createdAt: string | null
  }[]
  designPullRequests: {
    id: string
    attempt: number | null
    status: string
    repository: string | null
    baseBranch: string | null
    headBranch: string | null
    prNumber: number | null
    prUrl: string | null
    title: string | null
    ciStatus: string | null
    isMerged: boolean
    mergedAt: string | null
    createdAt: string | null
  }[]
  steps: {
    id: string
    stepName: string
    attempt: number | null
    status: string
    executor: string | null
    startedAt: string | null
    completedAt: string | null
    durationMs: number | null
    error: unknown
    output: unknown
    createdAt: string | null
  }[]
  artifacts: {
    id: string
    artifactScope: string
    artifactType: string
    artifactRole: string | null
    cephBucket: string | null
    cephObjectKey: string | null
    artifactUri: string | null
    contentType: string | null
    sizeBytes: number | null
    createdAt: string | null
  }[]
  rolloutTransitions: {
    id: string
    transitionId: string
    fromStage: string | null
    toStage: string | null
    transitionType: string
    status: string
    reasonCodes: string[]
    blockingGate: string | null
    evidenceHash: string | null
    createdAt: string | null
  }[]
}

export type WhitepaperListResult = {
  ok: true
  items: WhitepaperListItem[]
  total: number
  limit: number
  offset: number
}

export type WhitepaperListError = {
  ok: false
  message: string
}

export type WhitepaperDetailResult =
  | {
      ok: true
      item: WhitepaperDetail
    }
  | {
      ok: false
      message: string
    }

export type WhitepaperApprovalPayload = {
  approvedBy: string
  approvalReason: string
  targetScope?: string
  repository?: string
  base?: string
  head?: string
  rolloutProfile?: 'manual' | 'assisted' | 'automatic'
}

export type WhitepaperApprovalResult =
  | {
      ok: true
      result: Record<string, unknown>
    }
  | {
      ok: false
      message: string
    }

export type WhitepaperListParams = {
  query?: string
  status?: string
  verdict?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}

const toQueryString = (params: WhitepaperListParams) => {
  const query = new URLSearchParams()
  if (params.query) query.set('q', params.query)
  if (params.status) query.set('status', params.status)
  if (params.verdict) query.set('verdict', params.verdict)
  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) query.set('limit', String(params.limit))
  if (typeof params.offset === 'number' && Number.isFinite(params.offset)) query.set('offset', String(params.offset))
  return query.toString()
}

export const listWhitepapers = async (
  params: WhitepaperListParams = {},
): Promise<WhitepaperListResult | WhitepaperListError> => {
  const query = toQueryString(params)
  const url = `/api/whitepapers/${query ? `?${query}` : ''}`
  const response = await fetch(url, {
    method: 'GET',
    signal: params.signal,
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok || !payload || typeof payload !== 'object' || (payload as Record<string, unknown>).ok !== true) {
    const message =
      payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).message === 'string'
        ? String((payload as Record<string, unknown>).message)
        : `Library request failed (${response.status})`
    return { ok: false, message }
  }

  return payload as WhitepaperListResult
}

export const getWhitepaperDetail = async (
  runId: string,
  options: { signal?: AbortSignal } = {},
): Promise<WhitepaperDetailResult> => {
  const response = await fetch(`/api/whitepapers/${encodeURIComponent(runId)}/`, {
    method: 'GET',
    signal: options.signal,
  })

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok || !payload || typeof payload !== 'object') {
    return {
      ok: false,
      message: `Whitepaper detail request failed (${response.status})`,
    }
  }

  if ((payload as Record<string, unknown>).ok !== true) {
    const message =
      typeof (payload as Record<string, unknown>).message === 'string'
        ? String((payload as Record<string, unknown>).message)
        : 'Whitepaper detail request failed'
    return {
      ok: false,
      message,
    }
  }

  return payload as WhitepaperDetailResult
}

export const whitepaperPdfPath = (runId: string) => `/api/whitepapers/${encodeURIComponent(runId)}/pdf`

export const approveWhitepaperImplementation = async (
  runId: string,
  payload: WhitepaperApprovalPayload,
): Promise<WhitepaperApprovalResult> => {
  const response = await fetch(`/api/whitepapers/${encodeURIComponent(runId)}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (!response.ok || !body || typeof body !== 'object') {
    return {
      ok: false,
      message: `Whitepaper approval request failed (${response.status})`,
    }
  }

  if ((body as Record<string, unknown>).ok !== true) {
    return {
      ok: false,
      message:
        typeof (body as Record<string, unknown>).message === 'string'
          ? String((body as Record<string, unknown>).message)
          : 'Whitepaper approval request failed',
    }
  }

  return body as WhitepaperApprovalResult
}
