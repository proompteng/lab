import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexJudgeStore } from '../codex-judge-store'

const getSignedUrl = vi.fn()
const s3ClientConfigs: Array<Record<string, unknown>> = []
const getObjectInputs: Array<Record<string, unknown>> = []

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl,
}))

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    config: Record<string, unknown>
    constructor(config: Record<string, unknown>) {
      this.config = config
      s3ClientConfigs.push(config)
    }
  }

  class GetObjectCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
      getObjectInputs.push(input)
    }
  }

  return { S3Client, GetObjectCommand }
})

const globalState = globalThis as typeof globalThis & {
  __codexJudgeStoreMock?: CodexJudgeStore
  __codexJudgeGithubMock?: {
    getRefSha: ReturnType<typeof vi.fn>
    getCheckRuns: ReturnType<typeof vi.fn>
    getPullRequestByHead: ReturnType<typeof vi.fn>
    getPullRequest: ReturnType<typeof vi.fn>
    getPullRequestDiff: ReturnType<typeof vi.fn>
    getReviewSummary: ReturnType<typeof vi.fn>
    getFile: ReturnType<typeof vi.fn>
    updateFile: ReturnType<typeof vi.fn>
    createBranch: ReturnType<typeof vi.fn>
    createPullRequest: ReturnType<typeof vi.fn>
  }
  __codexJudgeConfigMock?: {
    githubToken: string | null
    githubApiBaseUrl: string
    codexReviewers: string[]
    ciEventStreamEnabled: boolean
    ciMaxWaitMs: number
    reviewMaxWaitMs: number
    maxAttempts: number
    backoffScheduleMs: number[]
    facteurBaseUrl: string
    argoServerUrl: string | null
    workflowArtifactsBucket: string
    workflowNamespace: string | null
    discordBotToken: string | null
    discordChannelId: string | null
    discordApiBaseUrl: string
    promptTuningEnabled: boolean
    promptTuningRepo: string | null
    promptTuningFailureThreshold: number
    promptTuningWindowHours: number
    promptTuningCooldownHours: number
    rerunOrchestrationName: string | null
    rerunOrchestrationNamespace: string
    systemImprovementOrchestrationName: string | null
    systemImprovementOrchestrationNamespace: string
  }
  __codexJudgeMemoryStoreMock?: { persist: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
}

if (!globalState.__codexJudgeStoreMock) {
  globalState.__codexJudgeStoreMock = {
    ready: Promise.resolve(),
    upsertRunComplete: vi.fn(),
    attachNotify: vi.fn(),
    updateCiStatus: vi.fn(),
    updateReviewStatus: vi.fn(),
    updateDecision: vi.fn(),
    updateRunStatus: vi.fn(),
    updateRunPrompt: vi.fn(),
    updateRunPrInfo: vi.fn(),
    upsertArtifacts: vi.fn(),
    listArtifactsForRun: vi.fn(async () => []),
    listRunsByStatus: vi.fn(),
    claimRerunSubmission: vi.fn(),
    updateRerunSubmission: vi.fn(),
    enqueueRerunSubmission: vi.fn(),
    listRerunSubmissions: vi.fn(),
    getRunByWorkflow: vi.fn(),
    getRunById: vi.fn(),
    listRunsByIssue: vi.fn(),
    listRunsByBranch: vi.fn(),
    listRunsByCommitSha: vi.fn(),
    listRunsByPrNumber: vi.fn(),
    getRunHistory: vi.fn(),
    listRecentRuns: vi.fn(),
    listRunsPage: vi.fn(),
    listIssueSummaries: vi.fn(),
    getLatestPromptTuningByIssue: vi.fn(),
    createPromptTuning: vi.fn(),
    close: vi.fn(),
  }
}

if (!globalState.__codexJudgeGithubMock) {
  globalState.__codexJudgeGithubMock = {
    getRefSha: vi.fn(),
    getCheckRuns: vi.fn(),
    getPullRequestByHead: vi.fn(),
    getPullRequest: vi.fn(),
    getPullRequestDiff: vi.fn(),
    getReviewSummary: vi.fn(),
    getFile: vi.fn(),
    updateFile: vi.fn(),
    createBranch: vi.fn(),
    createPullRequest: vi.fn(),
  }
}

if (!globalState.__codexJudgeConfigMock) {
  globalState.__codexJudgeConfigMock = {
    githubToken: null,
    githubApiBaseUrl: 'https://api.github.com',
    codexReviewers: [],
    ciEventStreamEnabled: false,
    ciMaxWaitMs: 10_000,
    reviewMaxWaitMs: 10_000,
    maxAttempts: 3,
    backoffScheduleMs: [0],
    facteurBaseUrl: 'http://facteur.test',
    argoServerUrl: null,
    workflowArtifactsBucket: 'jangar-artifacts',
    workflowNamespace: null,
    discordBotToken: null,
    discordChannelId: null,
    discordApiBaseUrl: 'https://discord.com/api/v10',
    promptTuningEnabled: false,
    promptTuningRepo: null,
    promptTuningFailureThreshold: 3,
    promptTuningWindowHours: 24,
    promptTuningCooldownHours: 6,
    rerunOrchestrationName: null,
    rerunOrchestrationNamespace: 'jangar',
    systemImprovementOrchestrationName: null,
    systemImprovementOrchestrationNamespace: 'jangar',
  }
}

if (!globalState.__codexJudgeMemoryStoreMock) {
  globalState.__codexJudgeMemoryStoreMock = {
    persist: vi.fn(),
    close: vi.fn(),
  }
}

let __private: Awaited<typeof import('../codex-judge')>['__private'] | null = null

const requirePrivate = async () => {
  if (!__private) {
    __private = (await import('../codex-judge')).__private
  }
  if (!__private) {
    throw new Error('Missing codex judge private API')
  }
  return __private
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  getSignedUrl.mockReset()
  s3ClientConfigs.length = 0
  getObjectInputs.length = 0
})

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch
  }
  delete process.env.MINIO_ENDPOINT
  delete process.env.MINIO_ACCESS_KEY
  delete process.env.MINIO_SECRET_KEY
  delete process.env.MINIO_SECURE
})

describe('codex-judge artifact fallback', () => {
  it('uses workflow output filenames for fallback keys', async () => {
    const { buildFallbackArtifactEntries } = await requirePrivate()
    const artifacts = buildFallbackArtifactEntries('workflow-1', 'jangar-artifacts')
    const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]))

    expect(byName.get('implementation-changes')?.key).toBe('workflow-1/workflow-1/.codex-implementation-changes.tar.gz')
    expect(byName.get('implementation-patch')?.key).toBe('workflow-1/workflow-1/.codex-implementation.patch')
    expect(byName.get('implementation-status')?.key).toBe('workflow-1/workflow-1/.codex-implementation-status.txt')
    expect(byName.get('implementation-log')?.key).toBe('workflow-1/workflow-1/.codex-implementation.log')
    expect(byName.get('implementation-events')?.key).toBe('workflow-1/workflow-1/.codex/implementation-events.jsonl')
    expect(byName.get('implementation-agent-log')?.key).toBe('workflow-1/workflow-1/.codex-implementation-agent.log')
    expect(byName.get('implementation-runtime-log')?.key).toBe(
      'workflow-1/workflow-1/.codex-implementation-runtime.log',
    )
    expect(byName.get('implementation-resume')?.key).toBe('workflow-1/workflow-1/.codex/implementation-resume.json')
    expect(byName.get('implementation-notify')?.key).toBe('workflow-1/workflow-1/.codex-implementation-notify.json')
  })
})

describe('codex-judge artifact fetch', () => {
  it('fetches by bucket/key when url is missing', async () => {
    process.env.MINIO_ENDPOINT = 'http://minio.local:9000'
    process.env.MINIO_ACCESS_KEY = 'minio-access'
    process.env.MINIO_SECRET_KEY = 'minio-secret'

    getSignedUrl.mockResolvedValue('http://minio.local/signed')

    const payload = Uint8Array.from([1, 2, 3, 4])
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => String(payload.byteLength) },
      arrayBuffer: async () => payload.buffer,
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    const { fetchArtifactBuffer } = await requirePrivate()
    const result = await fetchArtifactBuffer({
      name: 'implementation-log',
      key: 'workflow-1/workflow-1/.codex-implementation.log',
      bucket: 'jangar-artifacts',
      url: null,
      metadata: {},
    })

    expect(result).toEqual(Buffer.from(payload))
    expect(getSignedUrl).toHaveBeenCalledTimes(1)
    expect(getObjectInputs[0]).toEqual({
      Bucket: 'jangar-artifacts',
      Key: 'workflow-1/workflow-1/.codex-implementation.log',
    })
    expect(fetchMock).toHaveBeenCalledWith('http://minio.local/signed')
  })
})
