import type { MarketDataInspection } from '../../market-data'
import { Pipeable } from '../../pipeable'
import { CycleState, CycleTerminalReason, type AutonomousCycle } from '../model'
import { isTerminalCycleState } from '../transitions'
import type { NonEmptyPublications } from './calendar-decisions'

type CycleAuthoritySlotDecision =
  | { readonly _tag: 'UNCLAIMED'; readonly publication: MarketDataInspection }
  | { readonly _tag: 'TERMINAL'; readonly cycle: AutonomousCycle }
  | { readonly _tag: 'RESUME'; readonly publication: MarketDataInspection; readonly cycle: AutonomousCycle }
  | { readonly _tag: 'ALREADY_ACQUIRED'; readonly publication: MarketDataInspection; readonly cycle: AutonomousCycle }

export interface CycleAuthoritySlot {
  readonly publication: MarketDataInspection
  readonly existing: AutonomousCycle | undefined
}

type NonEmptyAuthoritySlots = readonly [CycleAuthoritySlot, ...CycleAuthoritySlot[]]

interface TerminalCycleAuthoritySlot {
  readonly publication: MarketDataInspection
  readonly cycle: AutonomousCycle
}

export type CycleAuthoritySelection =
  | Extract<CycleAuthoritySlotDecision, { readonly _tag: 'RESUME' | 'ALREADY_ACQUIRED' }>
  | {
      readonly _tag: 'READ_CALENDAR'
      readonly publications: NonEmptyPublications
      readonly reason: 'DISCOVERY' | 'MISSED_PAPER_BOOTSTRAP'
    }
  | { readonly _tag: 'ALREADY_TERMINAL'; readonly cycle: AutonomousCycle }

export type CycleAuthoritySelectionState =
  | {
      readonly _tag: 'UNCLAIMED'
      readonly publications: NonEmptyPublications
      readonly latestTerminal: TerminalCycleAuthoritySlot | undefined
    }
  | { readonly _tag: 'TERMINAL'; readonly latestTerminal: TerminalCycleAuthoritySlot }

type CycleAuthoritySelectionReduction =
  | { readonly _tag: 'CONTINUE'; readonly state: CycleAuthoritySelectionState }
  | Extract<CycleAuthoritySelection, { readonly _tag: 'RESUME' | 'ALREADY_ACQUIRED' }>

const classifyCycleAuthoritySlot = (
  publication: MarketDataInspection,
  existing: AutonomousCycle | undefined,
): CycleAuthoritySlotDecision => {
  if (existing === undefined) return { _tag: 'UNCLAIMED', publication }
  if (isTerminalCycleState(existing.state)) return { _tag: 'TERMINAL', cycle: existing }
  return existing.bindings.snapshotId === undefined
    ? { _tag: 'RESUME', publication, cycle: existing }
    : { _tag: 'ALREADY_ACQUIRED', publication, cycle: existing }
}

export const beginCycleAuthoritySelection = (slot: CycleAuthoritySlot): CycleAuthoritySelectionReduction => {
  const decision = classifyCycleAuthoritySlot(slot.publication, slot.existing)
  switch (decision._tag) {
    case 'UNCLAIMED':
      return {
        _tag: 'CONTINUE',
        state: { _tag: 'UNCLAIMED', publications: [decision.publication], latestTerminal: undefined },
      }
    case 'TERMINAL':
      return {
        _tag: 'CONTINUE',
        state: { _tag: 'TERMINAL', latestTerminal: { publication: slot.publication, cycle: decision.cycle } },
      }
    case 'RESUME':
    case 'ALREADY_ACQUIRED':
      return decision
  }
}

const reduceCycleAuthoritySelectionDataFirst = (
  state: CycleAuthoritySelectionState,
  slot: CycleAuthoritySlot,
): CycleAuthoritySelectionReduction => {
  const decision = classifyCycleAuthoritySlot(slot.publication, slot.existing)
  switch (decision._tag) {
    case 'UNCLAIMED':
      return {
        _tag: 'CONTINUE',
        state:
          state._tag === 'UNCLAIMED'
            ? { ...state, publications: [...state.publications, decision.publication] }
            : { _tag: 'UNCLAIMED', publications: [decision.publication], latestTerminal: state.latestTerminal },
      }
    case 'TERMINAL':
      return {
        _tag: 'CONTINUE',
        state:
          state._tag === 'UNCLAIMED' && state.latestTerminal === undefined
            ? { ...state, latestTerminal: { publication: slot.publication, cycle: decision.cycle } }
            : state,
      }
    case 'RESUME':
    case 'ALREADY_ACQUIRED':
      return decision
  }
}

export const reduceCycleAuthoritySelection = Pipeable.dual(2, reduceCycleAuthoritySelectionDataFirst)

const completeCycleAuthoritySelectionDataFirst = (
  state: CycleAuthoritySelectionState,
  cadence?: 'MONTHLY' | 'PAPER_BOOTSTRAP',
): CycleAuthoritySelection => {
  if (state._tag === 'TERMINAL') {
    const cycle = state.latestTerminal.cycle
    return cadence === 'PAPER_BOOTSTRAP' && cycle.terminalReason === CycleTerminalReason.MissedPublication
      ? {
          _tag: 'READ_CALENDAR',
          publications: [state.latestTerminal.publication],
          reason: 'MISSED_PAPER_BOOTSTRAP',
        }
      : { _tag: 'ALREADY_TERMINAL', cycle }
  }
  const latestTerminal = state.latestTerminal?.cycle
  if (cadence === 'PAPER_BOOTSTRAP' && latestTerminal !== undefined && latestTerminal.state !== CycleState.NoTrade) {
    const newerPublications = state.publications.filter(
      (publication) => publication.signalSession.session_date > latestTerminal.identity.signalSessionDate,
    )
    const [firstNewerPublication, ...remainingNewerPublications] = newerPublications
    if (
      latestTerminal.state === CycleState.Blocked &&
      latestTerminal.terminalReason === CycleTerminalReason.MissedPublication &&
      firstNewerPublication !== undefined
    ) {
      return {
        _tag: 'READ_CALENDAR',
        publications: [firstNewerPublication, ...remainingNewerPublications],
        reason: 'DISCOVERY',
      }
    }
    if (
      latestTerminal.state === CycleState.Blocked &&
      latestTerminal.terminalReason === CycleTerminalReason.MissedPublication &&
      state.latestTerminal !== undefined
    ) {
      return {
        _tag: 'READ_CALENDAR',
        publications: [state.latestTerminal.publication],
        reason: 'MISSED_PAPER_BOOTSTRAP',
      }
    }
    return { _tag: 'ALREADY_TERMINAL', cycle: latestTerminal }
  }
  return { _tag: 'READ_CALENDAR', publications: state.publications, reason: 'DISCOVERY' }
}

export const completeCycleAuthoritySelection = Pipeable.by<
  (
    cadence?: 'MONTHLY' | 'PAPER_BOOTSTRAP',
  ) => (state: CycleAuthoritySelectionState) => ReturnType<typeof completeCycleAuthoritySelectionDataFirst>,
  typeof completeCycleAuthoritySelectionDataFirst
>((arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null, completeCycleAuthoritySelectionDataFirst)

export const selectCycleAuthoritySlots = (slots: NonEmptyAuthoritySlots): CycleAuthoritySelection => {
  const [first, ...remaining] = slots
  const reduction = remaining.reduce<CycleAuthoritySelectionReduction>(
    (current, slot) => (current._tag === 'CONTINUE' ? reduceCycleAuthoritySelection(current.state, slot) : current),
    beginCycleAuthoritySelection(first),
  )
  return reduction._tag === 'CONTINUE' ? completeCycleAuthoritySelection(reduction.state) : reduction
}
