import { createServer } from 'node:http2'
import { describe, expect, test } from 'bun:test'
import { Config, Effect, Option, Redacted, Result } from 'effect'
import * as restate from '@restatedev/restate-sdk'
import { NodeHttpClient } from '@effect/platform-node'

import {
  hashResearch,
  ResearchOutcome,
  researchRequest,
  researchServingIdentity,
  sealResearchReceipt,
} from '../research-inference/contract'
import { fullTokenBudgetStreamFixture, editorFixture } from '../research-inference/test-support'
import { sha256 } from '../hash'
import { submitResearch } from '../research-inference/submission'
import { approveResearchRun } from '../research-inference/approval'
import { makeBaynResearchRun } from './restate-research-run'
import { acquireRestateHttp2Server } from './restate-http2-server'

const admin = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_ADMIN_URL'))).pipe(Option.getOrUndefined)
const ingress = Effect.runSync(Config.option(Config.String('BAYN_TEST_RESTATE_INGRESS_URL'))).pipe(
  Option.getOrUndefined,
)
const integration = admin === undefined || ingress === undefined ? describe.skip : describe
integration('real Restate research Workflow', () => {
  test('journals one run, rejects a wrong key and returns retained output after endpoint replacement', async () => {
    if (
      admin === undefined ||
      ingress === undefined ||
      ![admin, ingress].every((url) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
    )
      throw new Error('Restate research tests require local endpoints')
    let calls = 0
    const run = { ...editorFixture(), studyHash: crypto.randomUUID().replaceAll('-', '').repeat(2) }
    const id = Result.getOrThrow(hashResearch(run))
    const approvalKey = Redacted.make('7'.repeat(64))
    const approval = Result.getOrThrow(approveResearchRun(run, approvalKey))
    const responseText = '{"entry":"Assess the supplied complete long plan."}'
    const stream = fullTokenBudgetStreamFixture(run.policy.model, responseText)
    const retained = Result.getOrThrow(
      sealResearchReceipt(run, {
        runId: id,
        workerSourceRevision: null,
        requestHash: Result.getOrThrow(hashResearch(researchRequest(run))),
        startedAtMs: 0,
        completedAtMs: 1000,
        firstTokenAtMs: 1,
        outcome: ResearchOutcome.Complete,
        httpStatus: 200,
        servingIdentity: researchServingIdentity(run.policy),
        serverRequestId: 'chatcmpl-synthetic',
        responseHash: sha256(stream),
        responseText,
        responseBase64: Buffer.from(stream).toString('base64'),
        usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 },
        instructions: { entry: 'Assess the supplied complete long plan.' },
      }),
    )
    expect(Buffer.byteLength(JSON.stringify(retained))).toBeGreaterThan(786432)
    const invoke = async (key: string) => {
      const response = await fetch(`${ingress}/restate/call/BaynResearchRun/${key}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run, approval }),
        signal: AbortSignal.timeout(15000),
      })
      if (response.status === 409) {
        await response.body?.cancel()
        const attached = await fetch(`${ingress}/restate/attach`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target: 'workflow', workflowName: 'BaynResearchRun', workflowKey: key }),
          signal: AbortSignal.timeout(15000),
        })
        return { status: attached.status, body: (await attached.json()) as unknown }
      }
      return { status: response.status, body: (await response.json()) as unknown }
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const register = (replacement: boolean) =>
            Effect.gen(function* () {
              const workflow = makeBaynResearchRun(
                {
                  run: () => {
                    calls++
                    return replacement
                      ? Promise.reject(new Error('Retained workflow must not execute replacement code'))
                      : Promise.resolve(retained)
                  },
                },
                approvalKey,
              )
              const server = createServer(restate.createEndpointHandler({ services: [workflow] }))
              yield* acquireRestateHttp2Server(server, 0)
              const address = server.address()
              if (address === null || typeof address === 'string') throw new Error('Missing local research endpoint')
              yield* Effect.promise(async () => {
                const response = await fetch(`${admin}/deployments`, {
                  method: 'POST',
                  body: JSON.stringify({ uri: `http://host.docker.internal:${address.port}` }),
                  headers: { 'content-type': 'application/json' },
                })
                if (!response.ok) throw new Error(`Research registration failed with HTTP ${response.status}`)
                await response.body?.cancel()
              })
            })
          yield* register(false)
          const unapproved = { ...run, attempt: 1 }
          const unauthorized = yield* Effect.promise(() =>
            fetch(`${ingress}/restate/call/BaynResearchRun/${Result.getOrThrow(hashResearch(unapproved))}/run`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ run: unapproved, approval }),
              signal: AbortSignal.timeout(15000),
            }),
          )
          expect(unauthorized.status).toBe(500)
          yield* Effect.promise(() => unauthorized.body?.cancel() ?? Promise.resolve())
          expect(calls).toBe(0)
          const bad = yield* Effect.promise(() => invoke(crypto.randomUUID().replaceAll('-', '').repeat(2)))
          expect(bad.status).toBe(500)
          expect(yield* submitResearch(run, ingress, approvalKey)).toEqual(retained)
          expect(yield* submitResearch(run, ingress, approvalKey)).toEqual(retained)
          yield* register(true)
          expect(yield* submitResearch(run, ingress, approvalKey)).toEqual(retained)
          expect(calls).toBe(1)
        }),
      ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
    )
  }, 60_000)
})
