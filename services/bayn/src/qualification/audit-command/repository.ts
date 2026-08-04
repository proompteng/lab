import { Effect } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import type { RepositoryAudit } from '../../audit/audit'
import {
  QualificationAuditCommandError,
  qualificationAuditCommandError,
  type AcquireAuditRepositoryClient,
  type AuditRepositoryClient,
} from './model'

const repositoryAuditWithClient = (
  processes: ChildProcessSpawner.ChildProcessSpawner['Service'],
  repositoryPath: string,
  sourceRevision: string,
  lockCreatedAt: string,
  resultIdentity: readonly string[],
): Effect.Effect<RepositoryAudit, QualificationAuditCommandError> =>
  Effect.gen(function* () {
    const exists = yield* processes.exitCode(
      ChildProcess.make('git', ['-C', repositoryPath, 'cat-file', '-e', `${sourceRevision}^{commit}`]),
    )
    const ancestor = yield* processes.exitCode(
      ChildProcess.make('git', ['-C', repositoryPath, 'merge-base', '--is-ancestor', sourceRevision, 'origin/main']),
    )
    const pattern = resultIdentity.join('|')
    const lines = yield* processes.lines(
      ChildProcess.make('git', [
        '-C',
        repositoryPath,
        'log',
        'origin/main',
        `--before=${lockCreatedAt}`,
        '--format=%H',
        `-G${pattern}`,
      ]),
    )
    const references = new Set(lines.filter((line) => /^[0-9a-f]{40}$/.test(line)))
    return {
      sourceCommitExists: Number(exists) === 0,
      sourceCommitAncestorOfMain: Number(ancestor) === 0,
      preLockResultReferences: [...references].sort(),
    }
  }).pipe(
    Effect.mapError((cause) =>
      qualificationAuditCommandError('repository', 'repository provenance audit failed', cause),
    ),
  )

const verifySourceCheckoutWithClient = (
  processes: ChildProcessSpawner.ChildProcessSpawner['Service'],
  repositoryPath: string,
  sourceRevision: string,
  candidateModulePath?: string,
): Effect.Effect<void, QualificationAuditCommandError> =>
  Effect.gen(function* () {
    const headLines = yield* processes.lines(
      ChildProcess.make('git', ['-C', repositoryPath, '--no-optional-locks', 'rev-parse', '--verify', 'HEAD']),
    )
    const statusLines = yield* processes.lines(
      ChildProcess.make('git', [
        '-C',
        repositoryPath,
        '--no-optional-locks',
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]),
    )
    const trackedModuleLines =
      candidateModulePath === undefined
        ? []
        : yield* processes.lines(
            ChildProcess.make('git', [
              '-C',
              repositoryPath,
              '--no-optional-locks',
              'ls-files',
              '--error-unmatch',
              '--',
              candidateModulePath,
            ]),
          )
    if (
      headLines[0] !== sourceRevision ||
      statusLines.length > 0 ||
      (candidateModulePath !== undefined && (trackedModuleLines.length !== 1 || trackedModuleLines[0] === undefined))
    ) {
      return yield* Effect.fail(
        qualificationAuditCommandError(
          'repository',
          'audit repository must be a clean checkout at the persisted source revision',
        ),
      )
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof QualificationAuditCommandError
        ? cause
        : qualificationAuditCommandError('repository', 'audit source checkout could not be verified', cause),
    ),
  )

export const acquireAuditRepositoryClient: AcquireAuditRepositoryClient<ChildProcessSpawner.ChildProcessSpawner> = (
  input,
) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.map(
      (processes): AuditRepositoryClient => ({
        verifySourceCheckout: (sourceRevision, candidateModulePath) =>
          verifySourceCheckoutWithClient(processes, input.repositoryPath, sourceRevision, candidateModulePath),
        audit: (sourceRevision, lockCreatedAt, resultIdentity) =>
          repositoryAuditWithClient(processes, input.repositoryPath, sourceRevision, lockCreatedAt, resultIdentity),
      }),
    ),
  )
