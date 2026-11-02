import { expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { sha256 } from '../hash'
import { inferResearch } from '../research-inference/client'
import {
  decodeResearchRun,
  hashResearch,
  ResearchOutcome,
  researchServingIdentity,
} from '../research-inference/contract'
import { verifyResearchReceipt } from '../research-inference/store'
import { editorFixture, streamFixture } from '../research-inference/test-support'
import { openCodeConfiguration, openCodeConfigurationHash, openCodeModel } from './configuration'

const run = Result.getOrThrow(
  decodeResearchRun({
    ...editorFixture(),
    policy: {
      harness: 'opencode',
      harnessVersion: '2.1.3',
      model: openCodeModel,
      configurationHash: Result.getOrThrow(openCodeConfigurationHash),
      maximumModelCalls: 1,
      maximumInputBytes: 32768,
      temperature: 0.6,
      max_tokens: 4096,
    },
  }),
)
const runId = Result.getOrThrow(hashResearch(run))
const wire = streamFixture('{"entry":"Assess the complete plan using available net-payoff evidence."}', openCodeModel)
const nativeRequest = JSON.stringify({
  model: openCodeModel,
  stream: true,
  stream_options: { include_usage: true },
  max_completion_tokens: 4096,
  temperature: 0.6,
  tool_choice: 'none',
  reasoning_effort: 'low',
  response_format: openCodeConfiguration.providers.opencode.body.response_format,
  messages: [
    { role: 'user', content: `Bayn research attempt ${runId}\n${run.promptTemplate}\n${run.context.memory.text}` },
  ],
  tools: [],
})
const envelope = () => ({
  schemaVersion: 'bayn.opencode-response.v1',
  harnessEvidence: {
    firstTokenAtMs: 0,
    serverSourceRevision: run.sourceRevision,
    sessionId: 'ses_nativefixture',
    studyHash: run.studyHash,
    configurationHash: Result.getOrThrow(openCodeConfigurationHash),
    modelCalls: 1,
    providerCostUsd: 0,
    providerRequestHash: sha256(nativeRequest),
    providerRequestBase64: Buffer.from(nativeRequest).toString('base64'),
  },
  providerResponseBase64: Buffer.from(wire).toString('base64'),
})
const infer = (
  body: unknown,
  headers = {
    'x-model-serving-identity': JSON.stringify(researchServingIdentity(run.policy)),
    'x-bayn-source-revision': run.sourceRevision,
  },
) =>
  Effect.runPromise(
    inferResearch(run, runId, 'http://fixture.invalid/proposal', {}, run.sourceRevision).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { headers }))),
        ),
      ),
      Effect.provide(TestClock.layer()),
    ),
  )

test('hosted native receipts retain and verify actual provider input and raw SSE without pretending to know hosted weights', async () => {
  const receipt = await infer(envelope())
  expect(receipt.outcome).toBe(ResearchOutcome.Complete)
  expect(receipt.servingIdentity).toEqual(researchServingIdentity(run.policy))
  expect(receipt.harnessEvidence?.providerRequestHash).toBe(sha256(nativeRequest))
  expect(Buffer.from(receipt.responseBase64, 'base64').toString()).toBe(wire)
  expect(Result.isSuccess(verifyResearchReceipt(run, receipt))).toBe(true)
  expect(receipt.instructions?.entry).toContain('net-payoff')
})

test('another study, hidden extra call, paid usage, different feedback and changed source are rejected', async () => {
  for (const evidence of [
    { ...envelope().harnessEvidence, studyHash: 'e'.repeat(64) },
    { ...envelope().harnessEvidence, modelCalls: 2 },
    { ...envelope().harnessEvidence, providerCostUsd: 0.01 },
    {
      ...envelope().harnessEvidence,
      providerRequestBase64: Buffer.from(nativeRequest.replace('synthetic memory', 'different feedback')).toString(
        'base64',
      ),
    },
  ])
    expect((await infer({ ...envelope(), harnessEvidence: evidence })).outcome).toBe(ResearchOutcome.Rejected)
  expect(
    (
      await infer(envelope(), {
        'x-model-serving-identity': JSON.stringify(researchServingIdentity(run.policy)),
        'x-bayn-source-revision': 'f'.repeat(40),
      })
    ).outcome,
  ).toBe(ResearchOutcome.Rejected)
})

test('resealing changed provider bytes cannot turn an unrelated prompt into a verified proposal', async () => {
  const changed = nativeRequest.replace('synthetic memory', 'unrelated evidence')
  const evidence = {
    ...envelope().harnessEvidence,
    providerRequestBase64: Buffer.from(changed).toString('base64'),
    providerRequestHash: sha256(changed),
  }
  expect((await infer({ ...envelope(), harnessEvidence: evidence })).outcome).toBe(ResearchOutcome.Rejected)
})

test('standalone harness records its independent server revision alongside the Bayn worker revision', async () => {
  const serverSourceRevision = 'a'.repeat(40)
  const receipt = await infer(
    { ...envelope(), harnessEvidence: { ...envelope().harnessEvidence, serverSourceRevision } },
    {
      'x-model-serving-identity': JSON.stringify(researchServingIdentity(run.policy)),
      'x-bayn-source-revision': serverSourceRevision,
    },
  )
  expect(receipt.outcome).toBe(ResearchOutcome.Complete)
  expect(receipt.workerSourceRevision).toBe(run.sourceRevision)
  expect(receipt.harnessEvidence?.serverSourceRevision).toBe(serverSourceRevision)
  expect(Result.isSuccess(verifyResearchReceipt(run, receipt))).toBe(true)
})
