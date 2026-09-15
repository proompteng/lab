import { describe, expect, it } from 'bun:test'

import {
  assertAtlasManifestMatches,
  buildAtlasReconciliationWorkflowId,
  computeAtlasTreeHash,
  parseAtlasGitTree,
  planAtlasFileChanges,
} from './reconciliation'

describe('Atlas Git reconciliation', () => {
  const tree = [
    '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12\tdocs/README.md',
    '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 24\tservices/jangar/src/server/atlas.ts',
    '100644 blob cccccccccccccccccccccccccccccccccccccccc 30\timage.png',
    '',
  ].join('\0')

  it('uses one stable workflow ID per repository', () => {
    expect(buildAtlasReconciliationWorkflowId('proompteng/lab')).toBe(
      buildAtlasReconciliationWorkflowId(' PROOMPTENG/LAB '),
    )
    expect(buildAtlasReconciliationWorkflowId('proompteng/lab')).not.toBe(
      buildAtlasReconciliationWorkflowId('proompteng/other'),
    )
  })

  it('builds a sorted, eligibility-filtered manifest and stable tree hash', () => {
    const manifest = parseAtlasGitTree(tree)

    expect(manifest.files.map((file) => file.path)).toEqual(['docs/README.md', 'services/jangar/src/server/atlas.ts'])
    expect(manifest.skipped).toBe(1)
    expect(manifest.treeHash).toBe(computeAtlasTreeHash(manifest.files))
    expect(manifest.treeHash).toHaveLength(64)
  })

  it('classifies additions, modifications, unchanged paths, and deletions from Git object ids', () => {
    const manifest = parseAtlasGitTree(tree)
    const plan = planAtlasFileChanges(manifest, [
      { path: 'docs/README.md', contentHash: 'old', gitObjectId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { path: 'services/jangar/src/server/atlas.ts', contentHash: 'old', gitObjectId: 'old-object' },
      { path: 'deleted.ts', contentHash: 'old', gitObjectId: 'deleted-object' },
    ])

    expect(plan.unchanged.map((file) => file.path)).toEqual(['docs/README.md'])
    expect(plan.changed.map((file) => file.path)).toEqual(['services/jangar/src/server/atlas.ts'])
    expect(plan.deleted.map((file) => file.path)).toEqual(['deleted.ts'])
  })

  it('validates the manifest by path when database and JavaScript row orders differ', () => {
    const commit = 'dddddddddddddddddddddddddddddddddddddddd'
    const manifest = parseAtlasGitTree(
      [
        '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 12\t.github/actionlint.yaml',
        '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 24\t.github/ISSUE_TEMPLATE/codex-task.md',
        '',
      ].join('\0'),
    )

    expect(manifest.files.map((file) => file.path)).toEqual([
      '.github/ISSUE_TEMPLATE/codex-task.md',
      '.github/actionlint.yaml',
    ])
    expect(() =>
      assertAtlasManifestMatches(
        manifest,
        [
          {
            path: '.github/actionlint.yaml',
            repositoryCommit: commit,
            gitObjectId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          {
            path: '.github/ISSUE_TEMPLATE/codex-task.md',
            repositoryCommit: commit,
            gitObjectId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        ],
        commit,
      ),
    ).not.toThrow()
  })
})
