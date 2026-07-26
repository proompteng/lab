import { Context, Effect } from 'effect'

import type { EvaluationBounds, FinalizedSnapshotProvenance } from '../contracts'
import type { OperationalError } from '../errors'
import type { DailyBar, InputManifest, IsoDate, Protocol } from '../types'
import type { SignalSessionRow } from './rows'

export interface SnapshotRequest {
  readonly snapshotId: string
  readonly publicationAsOf: string
  readonly calendarVersion: string
  readonly universe: readonly string[]
  readonly bounds: EvaluationBounds
  readonly observedAt: string
  readonly universeId: FinalizedSnapshotProvenance['universeId']
  readonly universeSymbolHash: string
  readonly historyStart: IsoDate
  readonly evaluationStart: IsoDate
}

export type MarketDataContract = Pick<
  Protocol,
  'universeId' | 'universeSymbolHash' | 'universe' | 'historyStart' | 'evaluationStart'
>

export interface MarketDataSnapshot {
  readonly bars: readonly DailyBar[]
  readonly manifest: InputManifest
}

export type VerifiedSignalSession = Pick<
  SignalSessionRow,
  'calendar_version' | 'session_date' | 'close_time' | 'timezone'
>

export interface MarketDataInspection {
  readonly manifest: InputManifest
  readonly sessionDates: readonly IsoDate[]
  readonly signalSession: VerifiedSignalSession
}

export interface FinalizedPublicationRequest {
  readonly signalSessionDate: IsoDate
  readonly signalCalendarVersion: string
}

export interface SnapshotPublicationRequest extends FinalizedPublicationRequest {
  readonly snapshotId: string
}

export type FinalizedPublicationInspection =
  | {
      readonly outcome: 'MISSING'
      readonly observedAt: string
    }
  | {
      readonly outcome: 'FINALIZED'
      readonly observedAt: string
      readonly inspection: MarketDataInspection
    }

export type FinalizedPublicationDiscovery =
  | {
      readonly outcome: 'MISSING'
      readonly observedAt: string
    }
  | {
      readonly outcome: 'FINALIZED'
      readonly observedAt: string
      readonly publications: readonly MarketDataInspection[]
    }

export interface MarketDataService {
  readonly check: Effect.Effect<FinalizedSnapshotProvenance, OperationalError>
  readonly inspect: Effect.Effect<MarketDataInspection, OperationalError>
  readonly inspectCyclePublications: Effect.Effect<FinalizedPublicationDiscovery, OperationalError>
  readonly inspectPublication: (
    request: FinalizedPublicationRequest,
  ) => Effect.Effect<FinalizedPublicationInspection, OperationalError>
  readonly inspectSnapshotPublication: (
    request: SnapshotPublicationRequest,
  ) => Effect.Effect<FinalizedPublicationInspection, OperationalError>
  readonly loadSnapshotPublication: (
    request: SnapshotPublicationRequest,
  ) => Effect.Effect<MarketDataSnapshot, OperationalError>
  readonly load: Effect.Effect<MarketDataSnapshot, OperationalError>
}

export type MarketData = {
  readonly MarketData: unique symbol
  readonly Service: MarketDataService
}

export const MarketData = Context.Service<MarketData, MarketDataService>('bayn/MarketData')
