import { Data } from 'effect'

import type { BaynReconciliationReportV1 } from './reconcile'

export class BaynAccountingValidationError extends Data.TaggedError('BaynAccountingValidationError')<{
  readonly rule: string
  readonly message: string
}> {}

export class TigerBeetleConfigurationError extends Data.TaggedError('TigerBeetleConfigurationError')<{
  readonly message: string
}> {}

export class TigerBeetleConnectionError extends Data.TaggedError('TigerBeetleConnectionError')<{
  readonly message: string
  readonly cause: unknown
}> {}

export class TigerBeetleRequestError extends Data.TaggedError('TigerBeetleRequestError')<{
  readonly operation: string
  readonly message: string
  readonly cause: unknown
}> {}

export class TigerBeetleCreateError extends Data.TaggedError('TigerBeetleCreateError')<{
  readonly entity: 'account' | 'transfer'
  readonly index: number
  readonly id: bigint
  readonly status: string
}> {}

export class TigerBeetleDuplicateConflictError extends Data.TaggedError('TigerBeetleDuplicateConflictError')<{
  readonly entity: 'account' | 'transfer'
  readonly id: bigint
  readonly field: string
  readonly expected: string
  readonly actual: string
}> {}

export class BaynReconciliationError extends Data.TaggedError('BaynReconciliationError')<{
  readonly report: BaynReconciliationReportV1
}> {}
