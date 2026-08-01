import { candidate20ArchiveReceipt } from '../../candidate-archive/legacy-candidate-receipts'

/** Candidate 20 is a data-only tombstone; no executable artifact is exported. */
export const candidate20InvalidPrecommit = {
  schemaVersion: 'bayn.candidate-development-precommit-tombstone.v1',
  candidateOrdinal: candidate20ArchiveReceipt.candidateOrdinal,
  status: candidate20ArchiveReceipt.status,
  attemptStatus: candidate20ArchiveReceipt.facts.attemptStatus,
  invalidatedModuleSha256: candidate20ArchiveReceipt.facts.invalidatedModule.sha256,
  nextCandidatePreregistration: null,
} as const
