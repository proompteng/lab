import { Effect } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import type { RepositoryAudit } from '../../audit/audit'
import {
  qualificationAuditCommandError,
  type AcquireAuditRepositoryClient,
  type AuditRepositoryClient,
  type QualificationAuditCommandError,
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

export const acquireAuditRepositoryClient: AcquireAuditRepositoryClient<ChildProcessSpawner.ChildProcessSpawner> = (
  input,
) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.map(
      (processes): AuditRepositoryClient => ({
        audit: (sourceRevision, lockCreatedAt, resultIdentity) =>
          repositoryAuditWithClient(processes, input.repositoryPath, sourceRevision, lockCreatedAt, resultIdentity),
      }),
    ),
  )
