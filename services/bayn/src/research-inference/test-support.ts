import { Result } from 'effect'
import { sha256 } from '../hash'
import {
  decodeResearchRun,
  decodeRetainedResearchRun,
  editorModel,
  editorCheckpoint,
  hashResearch,
  ResearchOutcome,
  researchRequest,
  researchServingIdentity,
  sealResearchReceipt,
  type RetainedResearchRun,
} from './contract'

export const editorFixture = () => {
  const run = Result.getOrThrow(
    decodeResearchRun({
      schemaVersion: 'bayn.jev-editor.v1',
      purpose: 'prompt-edit',
      sourceRevision: 'a'.repeat(40),
      studyHash: 'b'.repeat(64),
      armManifestHashes: ['c'.repeat(64)],
      captureManifestHash: 'd'.repeat(64),
      featureCutoff: '1970-01-01T00:00:00.000Z',
      registeredAt: '1970-01-01T00:00:00.000Z',
      deadlineAt: '1970-01-01T00:00:30.000Z',
      attempt: 0,
      promptTemplate: 'Revise only the conditional complete-plan question using development execution evidence.',
      context: {
        memory: {
          sha256: sha256('synthetic memory'),
          text: 'synthetic memory',
          availableAt: '1970-01-01T00:00:00.000Z',
        },
      },
      policy: {
        model: editorModel,
        checkpoint: editorCheckpoint,
        servingImage: 'sha256:7ef5a35d1ef8ce2cf9d671dd91eec6e367c5849262e0362b4d3d4a26be0d87d2',
        tokenizerRevision: editorCheckpoint,
        chatTemplateRevision: editorCheckpoint,
        temperature: 0.7,
        top_p: 0.8,
        top_k: 20,
        min_p: 0,
        seed: 1,
        presence_penalty: 0,
        frequency_penalty: 0,
        repetition_penalty: 1,
        enable_thinking: false,
        max_tokens: 4096,
        stop: [],
      },
      costBasis: {
        sourceEvidenceHash: '4'.repeat(64),
        effectiveFrom: '1970-01-01T00:00:00.000Z',
        effectiveUntil: '1970-01-02T00:00:00.000Z',
        allocation: 'reserved-capacity-wall-time',
        picoUsdPerSecond: '1000000001',
      },
    }),
  )
  if ('harness' in run.policy) throw new Error('Expected the Flamingo test policy')
  return { ...run, policy: run.policy }
}

export const retainedEditorFixture = () => {
  const run = editorFixture()
  const checkpoint = 'b968826d9c46dd6066d109eabc6255188de91218'
  return Result.getOrThrow(
    decodeRetainedResearchRun({
      ...run,
      policy: {
        ...run.policy,
        model: 'qwen3-jev-editor-b968826d9c46',
        checkpoint,
        tokenizerRevision: checkpoint,
        chatTemplateRevision: checkpoint,
      },
    }),
  )
}

export const retainedReceiptFixture = (run: RetainedResearchRun) => {
  const wire = streamFixture('{"entry":"Assess"}', run.policy.model)
  return Result.getOrThrow(
    sealResearchReceipt(run, {
      runId: Result.getOrThrow(hashResearch(run)),
      workerSourceRevision: null,
      requestHash: Result.getOrThrow(hashResearch(researchRequest(run))),
      startedAtMs: 0,
      completedAtMs: 1001,
      firstTokenAtMs: 1,
      outcome: ResearchOutcome.Complete,
      httpStatus: 200,
      servingIdentity: researchServingIdentity(run.policy),
      serverRequestId: 'chatcmpl-synthetic',
      responseBase64: Buffer.from(wire).toString('base64'),
      responseHash: sha256(wire),
      responseText: '{"entry":"Assess"}',
      instructions: { entry: 'Assess' },
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  )
}

export const streamFixture = (content = '{"entry":"Assess"}', model: string = editorModel) =>
  [
    {
      id: 'chatcmpl-synthetic',
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    },
    {
      id: 'chatcmpl-synthetic',
      model,
      choices: [{ index: 0, delta: { reasoning: 'thinking' }, finish_reason: null }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
    {
      id: 'chatcmpl-synthetic',
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
      usage: { prompt_tokens: 10, completion_tokens: 19, total_tokens: 29 },
    },
    {
      id: 'chatcmpl-synthetic',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
    {
      id: 'chatcmpl-synthetic',
      model,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('') + 'data: [DONE]\n\n'

export const fullTokenBudgetStreamFixture = (model: string = editorModel, content = '{"entry":"Assess"}') => {
  const chunk = (completion: number, delta: Record<string, string>, finish: string | null = null) => ({
    id: 'chatcmpl-synthetic',
    object: 'chat.completion.chunk',
    created: 1791792592,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish, token_ids: null }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: completion,
      total_tokens: 10 + completion,
      completion_tokens_details: { reasoning_tokens: Math.min(completion, 4095) },
    },
  })
  return (
    [
      chunk(0, { role: 'assistant', content: '' }),
      ...Array.from({ length: 4095 }, (_, index) => chunk(index + 1, { reasoning: ' test' })),
      chunk(4096, { content }, 'stop'),
      { ...chunk(4096, {}), choices: [] },
    ]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
      .join('') + 'data: [DONE]\n\n'
  )
}
