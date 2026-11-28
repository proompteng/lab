import { ByteSize, Clock, Effect, Result, Schema, Stream } from 'effect'
import { HttpClient, HttpClientRequest, HttpIncomingMessage } from 'effect/http'

import { canonicalHashV1Result, sha256 } from '../hash'
import { admitOpenCodeCall } from '../opencode/gateway'
import { strictParseOptions } from '../schemas'
import {
  parseResearchOutput,
  ResearchError,
  ResearchOutcome,
  hashResearch,
  ResearchServingIdentitySchema,
  OpenCodeResponseSchema,
  researchServingIdentity,
  researchRequest,
  sealResearchReceipt,
  maximumResearchStreamBytes,
  type ResearchRun,
  type RetainedResearchRun,
  type ResearchReceipt,
} from './contract'

const maximumRequestBytes = 262144
const TokenCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const ChunkSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  choices: Schema.Array(
    Schema.Struct({
      index: Schema.Int,
      delta: Schema.Struct({
        content: Schema.optionalKey(Schema.NullOr(Schema.String)),
        reasoning: Schema.optionalKey(Schema.NullOr(Schema.String)),
        reasoning_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      finish_reason: Schema.NullOr(Schema.String),
    }),
  ),
  usage: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ prompt_tokens: TokenCount, completion_tokens: TokenCount, total_tokens: TokenCount }),
    ),
  ),
})

export const makeResearchStreamDecoder = (run: RetainedResearchRun) => {
  let output = ''
  let pending = ''
  let totalBytes = 0
  const received: Uint8Array[] = []
  let finished = false
  let done = false
  let modelObserved = false
  let firstTokenAtMs: number | null = null
  let serverRequestId: string | null = null
  let usage: typeof ChunkSchema.Type.usage = null
  let finalUsage = false
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const consume = (frame: string, now: number) =>
    Result.gen(function* () {
      if (frame.trim() === '' || frame.startsWith(':')) return
      const lines = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
      if (lines.length === 0) return
      if (done) return yield* Result.fail(new ResearchError({ message: 'Research stream continued after DONE' }))
      const data = lines.join('\n')
      if (data === '[DONE]') {
        done = true
        return
      }
      const chunk = yield* Schema.decodeUnknownResult(Schema.fromJsonString(ChunkSchema))(data).pipe(
        Result.mapError(() => new ResearchError({ message: 'Research stream contains malformed SSE data' })),
      )
      if (chunk.model !== undefined && chunk.model !== run.policy.model)
        return yield* Result.fail(
          new ResearchError({ message: 'Research response model differs from its frozen policy' }),
        )
      if (chunk.model !== undefined) modelObserved = true
      if (chunk.id !== undefined) {
        if (chunk.id.length > 160 || (serverRequestId !== null && serverRequestId !== chunk.id))
          return yield* Result.fail(new ResearchError({ message: 'Research stream request identity changed' }))
        serverRequestId = chunk.id
      }
      if (chunk.usage !== undefined && chunk.usage !== null) {
        if (finalUsage)
          return yield* Result.fail(new ResearchError({ message: 'Research stream continued after final usage' }))
        if (chunk.usage.total_tokens !== chunk.usage.prompt_tokens + chunk.usage.completion_tokens)
          return yield* Result.fail(new ResearchError({ message: 'Research token usage does not add up' }))
        if (chunk.usage.completion_tokens > run.policy.max_tokens)
          return yield* Result.fail(
            new ResearchError({ message: 'Research completion exceeds its approved token budget' }),
          )
        if (
          usage !== null &&
          usage !== undefined &&
          (chunk.usage.prompt_tokens !== usage.prompt_tokens || chunk.usage.completion_tokens < usage.completion_tokens)
        )
          return yield* Result.fail(
            new ResearchError({ message: 'Research cumulative token usage changed or decreased' }),
          )
        if (chunk.choices.length === 0) {
          if (!finished)
            return yield* Result.fail(new ResearchError({ message: 'Research final usage precedes generation finish' }))
          finalUsage = true
        }
        usage = chunk.usage
      }
      if (chunk.choices.length > 1)
        return yield* Result.fail(new ResearchError({ message: 'Research stream has multiple choices' }))
      for (const choice of chunk.choices) {
        if (choice.index !== 0 || finished)
          return yield* Result.fail(new ResearchError({ message: 'Research stream choice continued after finish' }))
        if ((choice.delta.reasoning?.length ?? 0) > 0 || (choice.delta.reasoning_content?.length ?? 0) > 0)
          firstTokenAtMs ??= now
        const content = choice.delta.content
        if (content !== undefined && content !== null && content !== '') {
          firstTokenAtMs ??= now
          output += content
        }
        if (choice.finish_reason !== null) {
          if (choice.finish_reason !== 'stop')
            return yield* Result.fail(new ResearchError({ message: 'Research generation did not finish normally' }))
          finished = true
        }
      }
    })
  const push = (bytes: Uint8Array, now: number) =>
    Result.gen(function* () {
      totalBytes += bytes.length
      if (totalBytes > maximumResearchStreamBytes)
        return yield* Result.fail(new ResearchError({ message: 'Research stream exceeds 2 MiB' }))
      received.push(new Uint8Array(bytes))
      pending += yield* Result.try({
        try: () => decoder.decode(bytes, { stream: true }),
        catch: () => new ResearchError({ message: 'Research stream is not UTF-8' }),
      })
      pending = pending.replaceAll('\r\n', '\n')
      let boundary: number
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        yield* consume(frame, now)
      }
    })
  const snapshot = () => {
    const bytes = Buffer.concat(received)
    return {
      responseText: output,
      responseBase64: bytes.toString('base64'),
      responseHash: bytes.length === 0 ? null : sha256(bytes),
      firstTokenAtMs,
      serverRequestId,
      usage: usage ?? null,
    }
  }
  const complete = () =>
    Result.gen(function* () {
      const tail = yield* Result.try({
        try: () => decoder.decode(),
        catch: () => new ResearchError({ message: 'Research stream ended inside UTF-8' }),
      })
      if (
        tail !== '' ||
        pending.trim() !== '' ||
        !finished ||
        !done ||
        !modelObserved ||
        !finalUsage ||
        usage === null ||
        usage === undefined ||
        serverRequestId === null
      )
        return yield* Result.fail(
          new ResearchError({ message: 'Research stream lacks complete termination, identity or usage' }),
        )
      return yield* parseResearchOutput(run, output)
    })
  return { push, snapshot, complete }
}

export const inferResearch = Effect.fn('bayn.research.inference')(function* (
  run: ResearchRun,
  runId: string,
  endpoint: string,
  traceHeaders: Readonly<Record<string, string>> = {},
  workerSourceRevision: string | null = null,
) {
  if (run.schemaVersion !== 'bayn.jev-editor.v1')
    return yield* new ResearchError({ message: 'Retired research contracts cannot dispatch new model inference' })
  const startedAtMs = yield* Clock.currentTimeMillis
  const deadline = Date.parse(run.deadlineAt)
  const request = researchRequest(run)
  const requestHash = yield* Effect.fromResult(canonicalHashV1Result(request)).pipe(
    Effect.mapError((cause) => new ResearchError({ message: 'Research request cannot be hashed', cause })),
  )
  const stream = makeResearchStreamDecoder(run)
  let httpStatus: number | null = null
  let servingIdentity: typeof ResearchServingIdentitySchema.Type | null = null
  const cutoff = Date.parse(run.featureCutoff)
  const state: { outcome: ResearchOutcome } = {
    outcome: startedAtMs < cutoff ? ResearchOutcome.Rejected : ResearchOutcome.Expired,
  }
  let instructions: ResearchReceipt['instructions'] = null
  let harnessEvidence: ResearchReceipt['harnessEvidence']
  if (startedAtMs >= cutoff && startedAtMs < deadline) {
    const response = yield* Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const body = JSON.stringify(request)
      if (Buffer.byteLength(body) > maximumRequestBytes)
        return yield* new ResearchError({ message: 'Research request exceeds 256 KiB' })
      const incoming = yield* http.execute(
        HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.bodyText(body, 'application/json'),
          HttpClientRequest.setHeaders(traceHeaders),
        ),
      )
      httpStatus = incoming.status
      if (httpStatus !== 200) {
        state.outcome = ResearchOutcome.Unavailable
        return
      }
      state.outcome = ResearchOutcome.Rejected
      const attestation = incoming.headers['x-model-serving-identity']
      if (attestation === undefined || attestation.length > 1024)
        return yield* new ResearchError({ message: 'Research response lacks bounded serving attestation' })
      servingIdentity = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ResearchServingIdentitySchema))(
        attestation,
      )
      if (
        (yield* Effect.fromResult(hashResearch(servingIdentity))) !==
        (yield* Effect.fromResult(hashResearch(researchServingIdentity(run.policy))))
      )
        return yield* new ResearchError({ message: 'Research serving artifacts differ from the frozen policy' })
      if ('harness' in run.policy) {
        const envelope = yield* Schema.decodeUnknownEffect(
          OpenCodeResponseSchema,
          strictParseOptions,
        )(yield* incoming.json.pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(3))))
        harnessEvidence = envelope.harnessEvidence
        if (harnessEvidence.serverSourceRevision !== incoming.headers['x-bayn-source-revision'])
          return yield* new ResearchError({ message: 'OpenCode response and serving source identities differ' })
        yield* Effect.fromResult(verifyOpenCodeEvidence(run, harnessEvidence, startedAtMs))
        yield* Effect.fromResult(
          stream.push(Buffer.from(envelope.providerResponseBase64, 'base64'), harnessEvidence.firstTokenAtMs),
        )
      } else {
        yield* incoming.stream.pipe(
          Stream.runForEach((bytes) =>
            Effect.gen(function* () {
              yield* Effect.fromResult(stream.push(bytes, yield* Clock.currentTimeMillis))
            }),
          ),
        )
      }
      instructions = yield* Effect.fromResult(stream.complete())
      state.outcome = ResearchOutcome.Complete
    }).pipe(Effect.timeout(`${deadline - startedAtMs} millis`), Effect.result)
    if (Result.isFailure(response) && (yield* Clock.currentTimeMillis) >= deadline)
      state.outcome = ResearchOutcome.Expired
    else if (Result.isFailure(response) && httpStatus === null) state.outcome = ResearchOutcome.Ambiguous
  }
  const completedAtMs = yield* Clock.currentTimeMillis
  if (completedAtMs >= deadline && state.outcome === ResearchOutcome.Complete) {
    state.outcome = ResearchOutcome.Expired
    instructions = null
  }
  return yield* Effect.fromResult(
    sealResearchReceipt(run, {
      runId,
      workerSourceRevision,
      requestHash,
      startedAtMs,
      completedAtMs,
      outcome: state.outcome,
      httpStatus,
      servingIdentity,
      ...(harnessEvidence === undefined ? {} : { harnessEvidence }),
      ...stream.snapshot(),
      instructions,
    }),
  )
}, Effect.scoped)

export const verifyOpenCodeEvidence = (
  run: RetainedResearchRun,
  evidence: ResearchReceipt['harnessEvidence'],
  nowMs: number,
) =>
  Result.gen(function* () {
    if (!('harness' in run.policy)) {
      if (evidence !== undefined)
        return yield* Result.fail(
          new ResearchError({ message: 'Unexpected hosted-harness evidence for a self-hosted run' }),
        )
      return
    }
    if (
      evidence === undefined ||
      evidence.configurationHash !== run.policy.configurationHash ||
      evidence.studyHash !== run.studyHash
    )
      return yield* Result.fail(
        new ResearchError({ message: 'OpenCode evidence differs from the registered study or configuration' }),
      )
    const bytes = Buffer.from(evidence.providerRequestBase64, 'base64')
    if (sha256(bytes) !== evidence.providerRequestHash)
      return yield* Result.fail(
        new ResearchError({ message: 'OpenCode provider request bytes differ from retained evidence' }),
      )
    const request = yield* admitOpenCodeCall(
      { sessionId: evidence.sessionId, deadlineAtMs: Date.parse(run.deadlineAt), calls: 0 },
      { body: bytes.toString('utf8'), sessionId: evidence.sessionId },
      nowMs,
    )
    const latest = request.messages.at(-1)
    const contains = (text: string) =>
      typeof latest?.content === 'string' &&
      (latest.content.includes(text) || latest.content.includes(JSON.stringify(text).slice(1, -1)))
    if (
      latest?.role !== 'user' ||
      typeof latest.content !== 'string' ||
      !contains(`Bayn research attempt ${yield* hashResearch(run)}`) ||
      !contains(run.promptTemplate) ||
      !contains(run.context.memory.text)
    )
      return yield* Result.fail(
        new ResearchError({ message: 'OpenCode provider input does not contain this attempt and its frozen feedback' }),
      )
  })
