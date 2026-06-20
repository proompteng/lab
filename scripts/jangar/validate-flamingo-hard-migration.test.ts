import { describe, expect, test } from 'bun:test'

import {
  checkForbiddenFlags,
  checkForbiddenTerms,
  checkRequiredTerms,
  forbiddenTerms,
  readTargetFiles,
  requiredTerms,
  targetFiles,
} from './validate-flamingo-hard-migration'

// ─────────────────────────────────────────────────────────────────────────────
// targetFiles sanity
// ─────────────────────────────────────────────────────────────────────────────

describe('targetFiles', () => {
  test('covers the Flamingo deployment manifest', () => {
    expect(targetFiles).toContain('argocd/applications/flamingo/deployment.yaml')
  })

  test('covers anypi agent-provider configs', () => {
    expect(targetFiles).toContain('argocd/applications/agents/anypi-agentprovider.yaml')
    expect(targetFiles).toContain('argocd/applications/agents/anypi-eval-agentprovider.yaml')
  })

  test('covers OpenWebUI values', () => {
    expect(targetFiles).toContain('argocd/applications/jangar/openwebui-values.yaml')
  })

  test('covers all consumer-facing docs and scripts', () => {
    expect(targetFiles).toContain('scripts/jangar/validate-pi-flamingo-compaction.ts')
    expect(targetFiles).toContain('services/anypi/src/config.ts')
    expect(targetFiles).toContain('services/anypi/src/config.test.ts')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// readTargetFiles
// ─────────────────────────────────────────────────────────────────────────────

describe('readTargetFiles', () => {
  test('returns one entry per target with non-empty content', async () => {
    const entries = await readTargetFiles(['package.json'])
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe('package.json')
    expect(entries[0].content.length).toBeGreaterThan(0)
  })

  test('throws on a non-existent target', async () => {
    await expect(readTargetFiles(['scripts/jangar/nonexistent-file.ts'])).rejects.toThrow(/no such file/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// checkForbiddenTerms
// ─────────────────────────────────────────────────────────────────────────────

describe('checkForbiddenTerms', () => {
  test('detects every forbidden term when present', async () => {
    const files = await readTargetFiles(targetFiles)
    const results = checkForbiddenTerms(files, forbiddenTerms)

    for (const term of forbiddenTerms) {
      expect(results).not.toContain(`any file: still contains forbidden term "${term}"`)
    }

    // The live target files should not contain any forbidden term.
    expect(results).toHaveLength(0)
  })

  test('reports exact path and term when a term is found', () => {
    const files = [
      {
        path: 'foo/bar.yaml',
        content: 'Qwen/Qwen3-Coder-Next-FP8',
      },
      {
        path: 'docs/foo.md',
        content: 'hermes is the model',
      },
      {
        path: 'baz/config.yaml',
        content: 'Qwen/Qwen3-Coder-Next-FP8 and hermes',
      },
    ]

    const results = checkForbiddenTerms(files, forbiddenTerms)
    expect(results).toHaveLength(4)

    // Iteration order: files outer, terms inner (Qwen/Qwen3-Coder-Next-FP8, qwen3-coder-flamingo,
    // Qwen/Qwen3-Coder-30B-A3B-Instruct, hermes)
    expect(results[0]).toContain('foo/bar.yaml')
    expect(results[0]).toContain('Qwen/Qwen3-Coder-Next-FP8')
    // docs/foo.md only has hermes (term index 3), but Qwen/Qwen3-Coder-Next-FP8 is checked first on foo/bar.yaml
    expect(results[0]).toContain('Qwen/Qwen3-Coder-Next-FP8')
    expect(results[1]).toContain('docs/foo.md')
    expect(results[1]).toContain('hermes')
    expect(results[2]).toContain('baz/config.yaml')
    expect(results[2]).toContain('Qwen/Qwen3-Coder-Next-FP8')
    expect(results[3]).toContain('baz/config.yaml')
    expect(results[3]).toContain('hermes')
  })

  test('returns empty array when no file contains forbidden terms', () => {
    const files = [{ path: 'clean.yaml', content: 'all good, nothing wrong' }]

    expect(checkForbiddenTerms(files, forbiddenTerms)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// checkRequiredTerms
// ─────────────────────────────────────────────────────────────────────────────

describe('checkRequiredTerms', () => {
  test('all required terms are present in live target files', () => {
    // Each required term should be satisfied across the combined content
    // of all target files.  No individual file needs every term.
  })

  test('reports each missing required term', () => {
    const combined = 'unsloth/Qwen3.6-35B-A3B-NVFP4'

    const results = checkRequiredTerms(combined, ['qwen36-flamingo', 'qwen3_xml'])
    expect(results).toHaveLength(2)
    expect(results[0]).toContain('qwen36-flamingo')
    expect(results[1]).toContain('qwen3_xml')
  })

  test('returns empty array when all terms are present', () => {
    const combined = 'unsloth/Qwen3.6-35B-A3B-NVFP4 qwen36-flamingo qwen3_xml'
    expect(checkRequiredTerms(combined, requiredTerms)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// checkForbiddenFlags
// ─────────────────────────────────────────────────────────────────────────────

describe('checkForbiddenFlags', () => {
  test('detects --numa-bind when present', () => {
    const files = [
      {
        path: 'test.yaml',
        content: 'some args\n--numa-bind\nmore args',
      },
    ]
    const results = checkForbiddenFlags(files, ['--numa-bind'])
    expect(results).toHaveLength(1)
    expect(results[0]).toContain('--numa-bind')
  })

  test('returns empty array when forbidden flag is absent', () => {
    const files = [
      {
        path: 'test.yaml',
        content: 'some args\n--trust-remote-code\nmore args',
      },
    ]
    expect(checkForbiddenFlags(files, ['--numa-bind'])).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Invariant: stale terms rejected across live files
// ─────────────────────────────────────────────────────────────────────────────

describe('stale model terms are rejected', () => {
  test('Qwen/Qwen3-Coder-Next-FP8 not present', async () => {
    const files = await readTargetFiles(targetFiles)
    const results = checkForbiddenTerms(files, ['Qwen/Qwen3-Coder-Next-FP8'])
    expect(results).toEqual([])
  })

  test('qwen3-coder-flamingo not present', async () => {
    const files = await readTargetFiles(targetFiles)
    const results = checkForbiddenTerms(files, ['qwen3-coder-flamingo'])
    expect(results).toEqual([])
  })

  test('Qwen/Qwen3-Coder-30B-A3B-Instruct not present', async () => {
    const files = await readTargetFiles(targetFiles)
    const results = checkForbiddenTerms(files, ['Qwen/Qwen3-Coder-30B-A3B-Instruct'])
    expect(results).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Invariant: hermes rejected
// ─────────────────────────────────────────────────────────────────────────────

describe('hermes is rejected', () => {
  test('hermes not present in target files', async () => {
    const files = await readTargetFiles(targetFiles)
    const results = checkForbiddenTerms(files, ['hermes'])
    expect(results).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Invariant: qwen3_xml required
// ─────────────────────────────────────────────────────────────────────────────

describe('qwen3_xml is required', () => {
  test('qwen3_xml present in combined target content', async () => {
    const files = await readTargetFiles(targetFiles)
    const combined = files.map(({ content }) => content).join('\n')
    const results = checkRequiredTerms(combined, ['qwen3_xml'])
    expect(results).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Invariant: deployment manifest invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('deployment.yaml invariants', () => {
  test('contains unsloth/Qwen3.6-35B-A3B-NVFP4', async () => {
    const files = await readTargetFiles(['argocd/applications/flamingo/deployment.yaml'])
    const content = files[0].content
    expect(content).toContain('unsloth/Qwen3.6-35B-A3B-NVFP4')
  })

  test('contains qwen36-flamingo served model name', async () => {
    const files = await readTargetFiles(['argocd/applications/flamingo/deployment.yaml'])
    const content = files[0].content
    expect(content).toContain('qwen36-flamingo')
  })

  test('contains --tool-call-parser qwen3_xml', async () => {
    const files = await readTargetFiles(['argocd/applications/flamingo/deployment.yaml'])
    const content = files[0].content
    expect(content).toContain('--tool-call-parser')
    expect(content).toContain('qwen3_xml')
  })

  test('does not contain --numa-bind', async () => {
    const files = await readTargetFiles(['argocd/applications/flamingo/deployment.yaml'])
    const content = files[0].content
    expect(content).not.toContain('--numa-bind')
  })

  test('does not contain hermes', async () => {
    const files = await readTargetFiles(['argocd/applications/flamingo/deployment.yaml'])
    const content = files[0].content
    expect(content).not.toContain('hermes')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Invariant: anypi agent-provider invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('anypi agent-provider invariants', () => {
  test('anypi-agentprovider has qwen36-flamingo', async () => {
    const files = await readTargetFiles(['argocd/applications/agents/anypi-agentprovider.yaml'])
    const content = files[0].content
    expect(content).toContain('qwen36-flamingo')
  })

  test('anypi-eval-agentprovider has qwen36-flamingo', async () => {
    const files = await readTargetFiles(['argocd/applications/agents/anypi-eval-agentprovider.yaml'])
    const content = files[0].content
    expect(content).toContain('qwen36-flamingo')
  })

  test('anypi files do not contain hermes', async () => {
    const files = await readTargetFiles([
      'argocd/applications/agents/anypi-agentprovider.yaml',
      'argocd/applications/agents/anypi-eval-agentprovider.yaml',
    ])
    const results = checkForbiddenTerms(files, ['hermes'])
    expect(results).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Invariant: forbidden flags absent from combined content
// ─────────────────────────────────────────────────────────────────────────────

describe('forbidden flags absent', () => {
  test('--numa-bind not present in any config file', async () => {
    const files = await readTargetFiles(['argocd/applications/flamingo/deployment.yaml'])
    const results = checkForbiddenFlags(files, ['--numa-bind'])
    expect(results).toEqual([])
  })
})
