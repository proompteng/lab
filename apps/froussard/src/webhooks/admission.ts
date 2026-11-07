import { Effect, Option, Schema } from 'effect'

import { Headers, HttpTraceContext } from 'effect/http'
import type { AppRuntime } from '@/effect/runtime'
import { publishKafkaMessage } from './utils'

export const ADMISSION_TOPIC = 'froussard.webhook.admissions.v1'
export const ADMISSION_GROUP = 'froussard-policy-v1'

export const WebhookAdmissionSchema = Schema.Struct({
  provider: Schema.Literals(['github', 'linear']),
  deliveryId: Schema.String,
  receivedAt: Schema.Number,
  body: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
})
export type WebhookAdmission = typeof WebhookAdmissionSchema.Type
export const decodeAdmission = Schema.decodeUnknownSync(Schema.fromJsonString(WebhookAdmissionSchema))

export const publishAdmission = (runtime: AppRuntime, admission: WebhookAdmission) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      yield* publishKafkaMessage({
        topic: ADMISSION_TOPIC,
        key: admission.deliveryId,
        value: JSON.stringify({ ...admission, headers: { ...admission.headers, ...HttpTraceContext.toHeaders(span) } }),
      })
    }).pipe(
      Effect.withSpan('webhook.admit', {
        kind: 'producer',
        parent: Option.getOrUndefined(HttpTraceContext.fromHeaders(Headers.fromInput(admission.headers))),
        attributes: {
          'messaging.destination.name': ADMISSION_TOPIC,
          'webhook.provider': admission.provider,
          'webhook.delivery.id': admission.deliveryId,
        },
      }),
    ),
  )

export class DeadlineExceededError extends Error {
  constructor(readonly operation: 'body' | 'kafka') {
    super(`${operation} deadline exceeded`)
    this.name = 'DeadlineExceededError'
  }
}

export const withDeadline = async <T>(
  work: Promise<T>,
  budgetMs: number,
  operation: 'body' | 'kafka' = 'kafka',
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError(operation)), Math.max(1, budgetMs))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
