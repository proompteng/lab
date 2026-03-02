import { describe, expect, it } from 'bun:test'

import { __private } from '../resolve-release-metadata'

const f22a8cbc = 'f22a8cbc91f8462d5e375e7684a38b03af271dde'
const ddd07d2f = 'ddd07d2f5a8eb0b7d96f297d3a892f48bdef1d1b'
const bf889391 = 'bf889391d4f55a10d6d7ca702289925cc2c5c869'

describe('resolve-release-metadata', () => {
  it('regression fixture: allows promotion when newer main files are docs-only', () => {
    const decision = __private.evaluateWorkflowRunStaleness({
      sourceSha: ddd07d2f,
      mainHead: bf889391,
      isAncestor: true,
      changedMainFiles: ['docs/agents/README.md', 'docs/agents/designs/jangar-swarm-intelligence-owner-serving.md'],
    })

    expect(decision).toEqual({
      promote: true,
      reason: 'newer-main-non-jangar-only',
    })
  })

  it('regression from git history: keeps ddd07d2f promotable after docs-only main advance', () => {
    expect(__private.commitExists(ddd07d2f)).toBe(true)
    expect(__private.commitExists(bf889391)).toBe(true)

    const changedMainFiles = __private.listChangedFilesBetween(ddd07d2f, bf889391)
    const decision = __private.evaluateWorkflowRunStaleness({
      sourceSha: ddd07d2f,
      mainHead: bf889391,
      isAncestor: __private.isAncestorCommit(ddd07d2f, bf889391),
      changedMainFiles,
    })

    expect(decision).toEqual({
      promote: true,
      reason: 'newer-main-non-jangar-only',
    })
    expect(changedMainFiles.length).toBeGreaterThan(0)
    expect(changedMainFiles.some((filePath) => filePath.startsWith('docs/agents/'))).toBe(true)
    expect(changedMainFiles.some((filePath) => __private.isBuildTriggerPath(filePath))).toBe(false)
  })

  it('regression from git history: blocks f22a8cbc promotion when newer main has jangar changes', () => {
    expect(__private.commitExists(f22a8cbc)).toBe(true)
    expect(__private.commitExists(ddd07d2f)).toBe(true)

    const changedMainFiles = __private.listChangedFilesBetween(f22a8cbc, ddd07d2f)
    const decision = __private.evaluateWorkflowRunStaleness({
      sourceSha: f22a8cbc,
      mainHead: ddd07d2f,
      isAncestor: __private.isAncestorCommit(f22a8cbc, ddd07d2f),
      changedMainFiles,
    })

    expect(decision).toEqual({
      promote: false,
      reason: 'newer-main-has-jangar-changes',
    })
    expect(changedMainFiles.some((filePath) => __private.isBuildTriggerPath(filePath))).toBe(true)
  })
})
