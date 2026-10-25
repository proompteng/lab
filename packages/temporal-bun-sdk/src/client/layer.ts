import { Context, Effect, Layer } from 'effect'

import type { TemporalClient } from '../client'
import { type CreateTemporalClientOptions, makeTemporalClientEffect } from '../client'

export class TemporalClientService extends Context.Service<TemporalClientService, TemporalClient>()(
  '@proompteng/temporal-bun-sdk/TemporalClient',
) {}

export const createTemporalClientLayer = (options: CreateTemporalClientOptions = {}) =>
  Layer.effect(
    TemporalClientService,
    Effect.acquireRelease(makeTemporalClientEffect(options).pipe(Effect.map((result) => result.client)), (client) =>
      Effect.promise(() => client.shutdown()),
    ),
  )

export const TemporalClientLayer = createTemporalClientLayer()
