/**
 * Candidate 20 is permanently closed without an attempt.
 *
 * The reviewed precommit remains preserved in Git history and is bound by the
 * immutable invalidation record. This module intentionally exports no
 * executable strategy artifact and cannot be evaluated or preregistered.
 */
export const candidate20InvalidPrecommit = {
  schemaVersion: 'bayn.candidate-development-precommit-tombstone.v1',
  candidateOrdinal: 20,
  status: 'PRECOMMIT_INVALID',
  attemptStatus: 'UNATTEMPTED',
  invalidatedModuleSha256: '15570022245f8bba1c121c6657369d66085d6c3659aa326b50048be1ab050441',
  nextCandidatePreregistration: null,
} as const
