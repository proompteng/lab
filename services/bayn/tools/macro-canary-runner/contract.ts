import { Data } from 'effect'

export enum Mode {
  Shadow = 'shadow',
  PaperSubmit = 'paper-submit',
}

export enum TimeInForce {
  Day = 'day',
  Open = 'opg',
}

export type Options = {
  mode: Mode
  tif: TimeInForce
  confirmPaperAccount?: string
  excludeSymbols: readonly string[]
  capitalBudgetCents?: number
  output: string
}

export class RebalanceFailure extends Data.TaggedError('MacroCanaryRebalanceFailure')<{
  readonly stage: string
  readonly message: string
  readonly cause?: unknown
}> {}

export const failure = (stage: string, message: string, cause?: unknown) =>
  new RebalanceFailure({ stage, message, ...(cause === undefined ? {} : { cause }) })
