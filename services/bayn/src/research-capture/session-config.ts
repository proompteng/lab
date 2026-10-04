import { Config, Option, Result, Schema } from 'effect'

import { canonicalHashV1 } from '../hash'
import { SnapshotCalendarSchema } from '../market-data/streaming/manifest-schema'
import { IsoDateSchema, strictParseOptions } from '../schemas'
import { CaptureSessionDeclarationSchema, ResearchCaptureFailure, ResearchCaptureIdSchema } from './capture'

export const ResearchCaptureSessionConfigSchema = Schema.Struct({
  captureId: ResearchCaptureIdSchema,
  ...CaptureSessionDeclarationSchema.fields,
  sessionDate: IsoDateSchema,
  calendar: Schema.Struct({
    ...SnapshotCalendarSchema.fields,
    sessions: SnapshotCalendarSchema.fields.sessions.check(Schema.isMaxLength(366)),
  }),
}).check(
  Schema.makeFilter(
    (value) => {
      const { normalizedResponseHash, ...material } = value.calendar
      const selected = value.calendar.sessions.find(({ date }) => date === value.sessionDate)
      const weekday = new Date(`${value.sessionDate}T00:00:00.000Z`).getUTCDay()
      const partitions = value.expectedPartitions.map(({ topic, partition }) => `${topic}:${partition}`)
      return (
        selected !== undefined &&
        weekday !== 0 &&
        weekday !== 6 &&
        value.calendar.requestedRange.start <= value.sessionDate &&
        value.sessionDate <= value.calendar.requestedRange.end &&
        value.calendar.sessions.every(
          (session, index, rows) =>
            session.openAt.slice(0, 10) === session.date &&
            session.closeAt.slice(0, 10) === session.date &&
            session.openAt < session.closeAt &&
            (index === 0 || (rows[index - 1]?.date ?? '') < session.date),
        ) &&
        canonicalHashV1(material) === normalizedResponseHash &&
        value.calendarHash === normalizedResponseHash &&
        Date.parse(value.calendarObservedAt) < value.bootstrapDeadlineMs &&
        value.coverageStartMs === Date.parse(selected.openAt) &&
        value.coverageEndMs === Date.parse(selected.closeAt) &&
        value.startAtMs < value.bootstrapDeadlineMs &&
        value.bootstrapDeadlineMs < value.coverageStartMs &&
        value.startAtMs >= Date.parse(`${value.sessionDate}T00:00:00.000Z`) &&
        value.stopAtMs > value.coverageEndMs &&
        value.stopAtMs - value.coverageEndMs <= 5 * 60 * 1000 &&
        new Set(partitions).size === partitions.length &&
        value.expectedPartitions.every((position, index, rows) => {
          const previous = rows[index - 1]
          return (
            previous === undefined ||
            previous.topic < position.topic ||
            (previous.topic === position.topic && previous.partition < position.partition)
          )
        })
      )
    },
    { expected: 'one canonical calendar session, ordered partition inventory and fixed bootstrap and stop deadlines' },
  ),
)
export type ResearchCaptureSessionConfig = typeof ResearchCaptureSessionConfigSchema.Type

export const decodeResearchCaptureSessionConfig = (input: string) =>
  Buffer.byteLength(input, 'utf8') > 64 * 1024
    ? Result.fail(new ResearchCaptureFailure({ message: 'Capture session configuration exceeds 64 KiB' }))
    : Schema.decodeUnknownResult(
        Schema.fromJsonString(ResearchCaptureSessionConfigSchema),
        strictParseOptions,
      )(input).pipe(
        Result.mapError(
          (cause) => new ResearchCaptureFailure({ message: 'Capture session configuration is invalid', cause }),
        ),
      )

export const researchCaptureSessionConfig = Config.option(Config.NonEmptyString('BAYN_RESEARCH_CAPTURE_SESSION')).pipe(
  Config.map((value) => (Option.isNone(value) ? undefined : decodeResearchCaptureSessionConfig(value.value))),
)

export const researchCaptureS3Config = Config.all({
  endpoint: Config.NonEmptyString('BAYN_RESEARCH_CAPTURE_S3_ENDPOINT'),
  bucket: Config.NonEmptyString('BAYN_RESEARCH_CAPTURE_S3_BUCKET'),
  region: Config.String('BAYN_RESEARCH_CAPTURE_S3_REGION').pipe(Config.withDefault('')),
  accessKeyId: Config.Redacted('BAYN_RESEARCH_CAPTURE_S3_ACCESS_KEY_ID'),
  secretAccessKey: Config.Redacted('BAYN_RESEARCH_CAPTURE_S3_SECRET_ACCESS_KEY'),
  timeoutMs: Config.succeed(1000),
})
