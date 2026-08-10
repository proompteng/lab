import { Result } from 'effect'

import { evidenceRecoveryContract, type ArtifactIndex, type EvidenceRecoveryIssue, type StoredArtifact } from './model'
import { recoveryFailure } from './shared'
import { Pipeable } from '../../pipeable'

const requiredArtifactDataFirst = (
  artifacts: ArtifactIndex,
  name: string,
): Result.Result<StoredArtifact, EvidenceRecoveryIssue> => {
  const artifact = artifacts.get(name)
  if (artifact !== undefined) return Result.succeed(artifact)
  const required = evidenceRecoveryContract.artifacts.find((candidate) => candidate.name === name)
  return recoveryFailure({
    _tag: 'ArtifactSetFailure',
    problem: {
      _tag: 'MissingArtifact',
      name,
      expectedSchemaVersion: required?.schemaVersion ?? 'unknown',
    },
  })
}

export const requiredArtifact = Pipeable.dual(2, requiredArtifactDataFirst)
