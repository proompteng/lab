import type { IsoDate } from './schemas'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema } from './contracts'

export { ContractVersion, DataFeed, DataSource, PriceAdjustment, PublicationSchema } from './contracts'

export type {
  CashYieldEvent,
  EvaluationEvent,
  FeeEvent,
  FillEvent,
  InputManifest,
  ReconciliationResult,
  SymbolCoverage,
} from './evidence-contracts'
export type { IsoDate } from './schemas'

export interface DailyBar {
  readonly symbol: string
  readonly sessionDate: IsoDate
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly source: DataSource
  readonly sourceFeed: DataFeed
  readonly adjustment: PriceAdjustment
  readonly publicationSchemaVersion: PublicationSchema
}
