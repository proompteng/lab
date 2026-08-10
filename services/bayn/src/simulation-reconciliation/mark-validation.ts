import { pipe, Result } from 'effect'

import type { CashChange, CashYieldEvent, DailyPositionMark, FeeEvent, FillEvent } from '../types'
import type { EvidenceMismatchProblem, SimulationReconciliationIssue, Validation } from './model'
import { fail, failIssues, signed, validateCanonicalIdentity } from './validation'
import { Pipeable } from '../pipeable'

const validateCashChangeDataFirst = (
  runId: string,
  change: CashChange,
  event: FillEvent | FeeEvent | CashYieldEvent,
  amountMicros: bigint,
  cashAfterMicros: bigint,
): Validation<void> => {
  const mismatch = (
    field: Extract<EvidenceMismatchProblem, { readonly _tag: 'CashChange' }>['field'],
    actual: string,
    expected: string,
  ): SimulationReconciliationIssue => ({
    _tag: 'EvidenceMismatch',
    problem: { _tag: 'CashChange', cashChangeId: change.id, sourceId: event.id, field, actual, expected },
  })
  const bindingIssues: readonly SimulationReconciliationIssue[] = [
    ...(change.sourceKind === event.kind ? [] : [mismatch('sourceKind', change.sourceKind, event.kind)]),
    ...(change.sessionDate === event.sessionDate
      ? []
      : [mismatch('sessionDate', change.sessionDate, event.sessionDate)]),
  ]
  if (bindingIssues.length > 0) return failIssues(bindingIssues)
  const amount = signed({
    kind: 'cash-change',
    cashChangeId: change.id,
    field: 'amountMicros',
    value: change.amountMicros,
  })
  if (Result.isFailure(amount)) return failIssues(amount.failure)
  const amountIssues: readonly SimulationReconciliationIssue[] =
    amount.success === amountMicros
      ? []
      : [mismatch('amountMicros', amount.success.toString(), amountMicros.toString())]
  const cashAfter = signed({
    kind: 'cash-change',
    cashChangeId: change.id,
    field: 'cashAfterMicros',
    value: change.cashAfterMicros,
  })
  if (Result.isFailure(cashAfter)) {
    return amountIssues.length > 0 ? failIssues(amountIssues) : Result.fail(cashAfter.failure)
  }
  const valueIssues: readonly SimulationReconciliationIssue[] =
    cashAfter.success === cashAfterMicros
      ? amountIssues
      : [...amountIssues, mismatch('cashAfterMicros', cashAfter.success.toString(), cashAfterMicros.toString())]
  if (valueIssues.length > 0) return failIssues(valueIssues)
  const { id: _, ...payload } = change
  return validateCanonicalIdentity(
    { kind: 'cash-change', id: change.id, sourceId: change.sourceId, sessionDate: change.sessionDate },
    { runId, kind: 'cash-change', ...payload },
  )
}

export const validateCashChange = Pipeable.dual(5, validateCashChangeDataFirst)

const validateMark = (mark: DailyPositionMark, previous: DailyPositionMark | undefined): Validation<void> => {
  if (previous !== undefined && previous.sessionDate >= mark.sessionDate) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: { _tag: 'InvalidMarkOrder', previousSessionDate: previous.sessionDate, sessionDate: mark.sessionDate },
    })
  }
  const symbols = mark.positions.map((position) => position.symbol)
  if (new Set(symbols).size !== symbols.length) {
    return fail({
      _tag: 'InvalidEvidenceState',
      problem: { _tag: 'DuplicateMarkedPosition', sessionDate: mark.sessionDate, symbols },
    })
  }
  return symbols.some((symbol, symbolIndex) => {
    if (symbolIndex === 0) return false
    const previous = symbols[symbolIndex - 1]
    return previous === undefined || previous >= symbol
  })
    ? fail({
        _tag: 'InvalidEvidenceState',
        problem: { _tag: 'UnsortedMarkedPositions', sessionDate: mark.sessionDate, symbols },
      })
    : Result.succeed(undefined)
}

export const validateMarks = (marks: readonly DailyPositionMark[]): Validation<void> =>
  marks.length === 0
    ? fail({ _tag: 'IncompleteEvidence', problem: { _tag: 'EmptyDailyMarks' } })
    : marks.reduce<Validation<void>>(
        (validated, mark, index) =>
          pipe(
            validated,
            Result.flatMap(() => validateMark(mark, marks[index - 1])),
          ),
        Result.succeed(undefined),
      )
