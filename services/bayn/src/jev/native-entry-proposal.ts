import { Schema } from 'effect'
import { EntryProposalSchema, type EntryProposal } from './entry-proposals'
import { ShortEntryProposalSchema, type ShortEntryProposal } from './short-entry'
import { shortEntryProposalExitPlan } from './short-exit-plan'
import { entryProposalExitPlan } from './strategy-exit-plan'

export const NativeEntryProposalSchema = Schema.Union([EntryProposalSchema, ShortEntryProposalSchema])
export type NativeEntryProposal = typeof NativeEntryProposalSchema.Type
export const isShortEntryProposal = (proposal: NativeEntryProposal): proposal is ShortEntryProposal =>
  proposal.schemaVersion === 'bayn.equity-short-entry-proposal.v1'
export const isLongEntryProposal = (proposal: NativeEntryProposal): proposal is EntryProposal =>
  proposal.schemaVersion === 'bayn.entry-proposal.v1'
export const nativeModeledLossMicros = (proposal: NativeEntryProposal): bigint =>
  isShortEntryProposal(proposal)
    ? -BigInt(proposal.funding.estimatedStopPnlMicros)
    : BigInt(proposal.funding.acquisitionCostMicros) - BigInt(proposal.funding.estimatedStopNetMicros)
export const nativeModeledGainMicros = (proposal: NativeEntryProposal): bigint =>
  isShortEntryProposal(proposal)
    ? BigInt(proposal.funding.estimatedTargetPnlMicros)
    : BigInt(proposal.funding.estimatedTargetNetMicros) - BigInt(proposal.funding.acquisitionCostMicros)
export const nativeEntryProposalExitPlan = (proposal: NativeEntryProposal) =>
  isShortEntryProposal(proposal) ? shortEntryProposalExitPlan(proposal) : entryProposalExitPlan(proposal)
