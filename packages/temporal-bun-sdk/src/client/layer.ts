import { Context, Effect, Layer } from 'effect'

import type { TemporalClient } from '../client'
import { type CreateTemporalClientOptions, makeTemporalClientEffect } from '../client'

export class TemporalClientService extends Context.Tag('@proompteng/temporal-bun-sdk/TemporalClient')<
  TemporalClientService,
  TemporalClient
>() {}

export const createTemporalClientLayer = (options: CreateTemporalClientOptions = {}) =>
  Layer.scoped(
    TemporalClientService,
    Effect.acquireRelease(makeTemporalClientEffect(options).pipe(Effect.map((result) => result.client)), (client) =>
      Effect.promise(() => client.shutdown()),
    ),
  )

export const TemporalClientLayer = createTemporalClientLayer()
