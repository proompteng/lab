import { createHmac, timingSafeEqual } from 'node:crypto'
import { Redacted, Result, Schema } from 'effect'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { decodeResearchRun, hashResearch, ResearchError, type ResearchRun } from './contract'

const ApprovalSchema = Schema.Struct({ run: Schema.Unknown, approval: Sha256Schema })

export const validateResearchApprovalKey = (key: Redacted.Redacted<string>) =>
  /^[0-9a-f]{64}$/.test(Redacted.value(key))
    ? Result.succeed(key)
    : Result.fail(new ResearchError({ message: 'Research approval key must be 32 bytes encoded as lowercase hex' }))

export const approveResearchRun = (run: ResearchRun, key: Redacted.Redacted<string>) =>
  Result.gen(function* () {
    yield* validateResearchApprovalKey(key)
    const runId = yield* hashResearch(run)
    return createHmac('sha256', Buffer.from(Redacted.value(key), 'hex'))
      .update(`bayn.research-approval.v1:${runId}`)
      .digest('hex')
  })

export const decodeApprovedResearchRun = (input: unknown, key: Redacted.Redacted<string>) =>
  Result.gen(function* () {
    const envelope = yield* Schema.decodeUnknownResult(
      ApprovalSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError(() => new ResearchError({ message: 'Research approval envelope is malformed' })))
    const run = yield* decodeResearchRun(envelope.run)
    const expected = yield* approveResearchRun(run, key)
    if (!timingSafeEqual(Buffer.from(envelope.approval, 'hex'), Buffer.from(expected, 'hex')))
      return yield* Result.fail(new ResearchError({ message: 'Research run lacks valid operator approval' }))
    return run
  })
