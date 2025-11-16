import { Context, Layer } from 'effect'

import type { TemporalClient } from '../client'
import { type CreateTemporalClientOptions, makeTemporalClientEffect } from '../client'

export class TemporalClientService extends Context.Tag('@proompteng/temporal-bun-sdk/TemporalClient')<
  TemporalClientService,
  TemporalClient
>() {}

export const createTemporalClientLayer = (options: CreateTemporalClientOptions = {}) =>
  Layer.effect(TemporalClientService, makeTemporalClientEffect(options))

export const TemporalClientLayer = createTemporalClientLayer()
