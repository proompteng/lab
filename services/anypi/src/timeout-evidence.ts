import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { runCommand } from './command'
import type { AnypiStatus } from './types'

export type TimeoutEvidence = {
  git: {
    branch: string
    head: string
    statusShort: string
    diffStat?: string
  }
  patchFile?: string
}

export const TIMEOUT_ERROR_PREFIX = 'Pi prompt exceeded'

export class TimeoutErrorWithEvidence extends Error {
  constructor(
    message: string,
    public evidence: TimeoutEvidence,
  ) {
    super(message)
    this.name = 'TimeoutErrorWithEvidence'
  }
}

const captureGitState = async (
  worktree: string,
  env?: Record<string, string | undefined>,
): Promise<TimeoutEvidence['git']> => {
  const branchResult = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: worktree,
    env,
    allowFailure: true,
  })
  const branch = branchResult.stdout.trim() || 'unknown'

  const headResult = await runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: worktree,
    env,
    allowFailure: true,
  })
  const head = headResult.stdout.trim() || 'unknown'

  const statusResult = await runCommand('git', ['status', '--short'], {
    cwd: worktree,
    env,
    allowFailure: true,
  })
  const statusShort = statusResult.stdout.trim()

  const diffStatResult = await runCommand('git', ['diff', '--stat', 'HEAD'], {
    cwd: worktree,
    env,
    allowFailure: true,
  })

  return {
    branch,
    head,
    statusShort,
    diffStat: diffStatResult.exitCode === 0 ? diffStatResult.stdout.trim() : undefined,
  }
}

export const captureTimeoutEvidence = async (
  worktree: string,
  env?: Record<string, string | undefined>,
): Promise<TimeoutEvidence> => {
  const git = await captureGitState(worktree, env)

  // Create a patch file with the full diff
  const patchFileName = `timeout-patch-${Date.now()}.patch`
  const patchFilePath = join(worktree, '.agent', patchFileName)

  try {
    await mkdir(dirname(patchFilePath), { recursive: true })
  } catch {
    // Directory may already exist, ignore
  }

  const diffResult = await runCommand('git', ['diff', 'HEAD'], {
    cwd: worktree,
    env,
    allowFailure: true,
  })

  if (diffResult.exitCode === 0 && diffResult.stdout) {
    await writeFile(patchFilePath, diffResult.stdout, 'utf8')
  } else {
    // Write an empty patch file even if diff failed
    await writeFile(patchFilePath, '', 'utf8')
  }

  return {
    git,
    patchFile: patchFilePath,
  }
}

export const mergeTimeoutEvidence = (status: AnypiStatus, evidence: TimeoutEvidence): AnypiStatus => {
  // Preserve all existing fields and add timeout evidence
  return {
    ...status,
    gitBranch: evidence.git.branch,
    gitHead: evidence.git.head,
    gitStatusShort: evidence.git.statusShort,
    gitDiffStat: evidence.git.diffStat,
    timeoutPatchFile: evidence.patchFile,
  }
}
