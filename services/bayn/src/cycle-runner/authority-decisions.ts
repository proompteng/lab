import { isTerminalCycleState, type AutonomousCycle } from '../cycle'
import type { MarketDataInspection } from '../market-data'
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

export type CycleAuthoritySelection =
  | Extract<CycleAuthoritySlotDecision, { readonly _tag: 'RESUME' | 'ALREADY_ACQUIRED' }>
  | { readonly _tag: 'READ_CALENDAR'; readonly publications: NonEmptyPublications }
  | { readonly _tag: 'ALREADY_TERMINAL'; readonly cycle: AutonomousCycle }

export type CycleAuthoritySelectionState =
  | {
      readonly _tag: 'UNCLAIMED'
      readonly publications: NonEmptyPublications
      readonly latestTerminal: AutonomousCycle | undefined
    }
  | { readonly _tag: 'TERMINAL'; readonly latestTerminal: AutonomousCycle }

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
      return { _tag: 'CONTINUE', state: { _tag: 'TERMINAL', latestTerminal: decision.cycle } }
    case 'RESUME':
    case 'ALREADY_ACQUIRED':
      return decision
  }
}

export const reduceCycleAuthoritySelection = (
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
            ? { ...state, latestTerminal: decision.cycle }
            : state,
      }
    case 'RESUME':
    case 'ALREADY_ACQUIRED':
      return decision
  }
}

export const completeCycleAuthoritySelection = (state: CycleAuthoritySelectionState): CycleAuthoritySelection =>
  state._tag === 'UNCLAIMED'
    ? { _tag: 'READ_CALENDAR', publications: state.publications }
    : { _tag: 'ALREADY_TERMINAL', cycle: state.latestTerminal }

export const selectCycleAuthoritySlots = (slots: NonEmptyAuthoritySlots): CycleAuthoritySelection => {
  const [first, ...remaining] = slots
  const reduction = remaining.reduce<CycleAuthoritySelectionReduction>(
    (current, slot) => (current._tag === 'CONTINUE' ? reduceCycleAuthoritySelection(current.state, slot) : current),
    beginCycleAuthoritySelection(first),
  )
  return reduction._tag === 'CONTINUE' ? completeCycleAuthoritySelection(reduction.state) : reduction
}
