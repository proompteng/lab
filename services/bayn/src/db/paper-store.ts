import { Layer } from 'effect'

import type { RuntimeConfig } from '../config'
import { PaperStore } from './paper-store/contract'
import { makePaperStore } from './paper-store/postgres'

export {
  PaperStore,
  PaperStoreError,
  VALUATION_SNAPSHOT_MAX_SKEW_MS,
  type EnsureAuthorityGenerationInput,
  type EventReceipt,
  type PaperStoreShape,
  type PositionSnapshotReceipt,
} from './paper-store/contract'

export const PaperStoreLive = (config: RuntimeConfig) => Layer.effect(PaperStore, makePaperStore(config))
