import { Data, Redacted, Result } from 'effect'

export class EvidenceReaderFailure extends Data.TaggedError('EvidenceReaderFailure')<{
  readonly message: string
}> {}

export const evidenceReaderUrl = (input: Redacted.Redacted<string>) =>
  Result.gen(function* () {
    const url = yield* Result.try({
      try: () => new URL(Redacted.value(input)),
      catch: () => new EvidenceReaderFailure({ message: 'Evidence reader database URL is invalid' }),
    })
    const user = yield* Result.try({
      try: () => url.searchParams.getAll('user').at(-1) ?? decodeURIComponent(url.username),
      catch: () => new EvidenceReaderFailure({ message: 'Evidence reader identity encoding is invalid' }),
    })
    if (!['postgresql:', 'postgres:'].includes(url.protocol))
      return yield* Result.fail(new EvidenceReaderFailure({ message: 'Evidence reader requires a PostgreSQL URL' }))
    if (user !== 'bayn_evidence')
      return yield* Result.fail(
        new EvidenceReaderFailure({ message: 'Evidence export requires the dedicated bayn_evidence reader identity' }),
      )
    url.searchParams.set(
      'options',
      `${url.searchParams.get('options') ?? ''} -c default_transaction_read_only=on -c timezone=UTC`,
    )
    return Redacted.make(url.toString())
  })
