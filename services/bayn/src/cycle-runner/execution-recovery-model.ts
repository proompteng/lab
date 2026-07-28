import type { MutationEvidence } from '../broker/alpaca-mutations'
import type { TerminalOutcome } from '../execution/contracts'
import type { MutationEvent } from '../execution/mutations'

export type RecoverySelection =
  | { readonly _tag: 'RecoveryComplete'; readonly event: MutationEvent }
  | { readonly _tag: 'RecoveryRequired'; readonly event: MutationEvent }

export type InterruptedStartDecision =
  | { readonly _tag: 'MarkSubmitUnknown'; readonly event: MutationEvent; readonly occurredAt: string }
  | {
      readonly _tag: 'MarkCancelUnknown'
      readonly event: MutationEvent
      readonly brokerOrderId: string
      readonly occurredAt: string
    }
  | { readonly _tag: 'KeepMutation'; readonly event: MutationEvent }

export type RecoveryPersistenceDecision =
  | {
      readonly _tag: 'RecoveryFound'
      readonly brokerOrderId: string
      readonly evidence: MutationEvidence
      readonly terminalOutcome?: TerminalOutcome
    }
  | { readonly _tag: 'RecoveryNotFound'; readonly evidence: MutationEvidence }
  | { readonly _tag: 'RecoveryUnknown'; readonly evidence?: MutationEvidence }
