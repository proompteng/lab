import { Effect, Redacted, Schema, Stream } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import {
  decodeResearchRun,
  hashResearch,
  maximumResearchReceiptBytes,
  ResearchError,
  ResearchReceiptSchema,
} from './contract'
import { verifyResearchReceipt } from './store'
import { approveResearchRun } from './approval'

export const submitResearch = Effect.fn('bayn.research.submit')(
  function* (input: unknown, origin: string, approvalKey: Redacted.Redacted<string>) {
    const run = yield* Effect.fromResult(decodeResearchRun(input))
    if (run.schemaVersion !== 'bayn.jev-editor.v1')
      return yield* new ResearchError({ message: 'Retired research contracts cannot be submitted for new inference' })
    const runId = yield* Effect.fromResult(hashResearch(run))
    const approval = yield* Effect.fromResult(approveResearchRun(run, approvalKey))
    const url = yield* Effect.try({
      try: () => new URL(origin),
      catch: (cause) => new ResearchError({ message: 'Restate research origin is invalid', cause }),
    })
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    )
      return yield* new ResearchError({ message: 'Restate research origin must be an uncredentialed HTTP(S) origin' })
    const http = yield* HttpClient.HttpClient
    const initial = yield* http.execute(
      HttpClientRequest.post(`${url.origin}/restate/call/BaynResearchRun/${runId}/run`).pipe(
        HttpClientRequest.bodyText(JSON.stringify({ run, approval }), 'application/json'),
      ),
    )
    const response =
      initial.status === 409
        ? yield* http.execute(
            HttpClientRequest.post(`${url.origin}/restate/attach`).pipe(
              HttpClientRequest.bodyText(
                JSON.stringify({ target: 'workflow', workflowName: 'BaynResearchRun', workflowKey: runId }),
                'application/json',
              ),
            ),
          )
        : initial
    if (response.status !== 200)
      return yield* new ResearchError({ message: `Research Workflow returned HTTP ${response.status}` })
    let bytes = 0
    const chunks = yield* response.stream.pipe(
      Stream.runFoldEffect(
        (): Uint8Array[] => [],
        (chunks, chunk) => {
          bytes += chunk.length
          return bytes > maximumResearchReceiptBytes
            ? Effect.fail(new ResearchError({ message: 'Research Workflow response exceeds 5 MiB' }))
            : Effect.succeed([...chunks, chunk])
        },
      ),
    )
    const text = Buffer.concat(chunks).toString('utf8')
    const receipt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ResearchReceiptSchema))(text)
    return yield* Effect.fromResult(verifyResearchReceipt(run, receipt))
  },
  Effect.scoped,
  Effect.timeout('195 seconds'),
)
