#!/usr/bin/env bun

import { appendFile } from 'node:fs/promises'
import { delimiter, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import type {
  QualificationDormancyDecision,
  QualificationDormancyResult,
} from '../../../../services/bayn/src/candidate-development-trials/qualification-dormancy'

export type { QualificationDormancyDecision, QualificationDormancyResult }

const trialHistoryRelativePath = 'services/bayn/src/candidate-development-trials/frozen-lineage.ts'
const lifecycleRelativePath = 'services/bayn/src/candidate-development-trials/qualification-dormancy.ts'
const packageRoot = resolve(import.meta.dir, '../../../..')

// The scripts CI job installs only its selected workspace closure, so the
// service's peer dependency may be present only in Bun's content-addressed
// store. Make that package location visible before importing the canonical
// service module; the lifecycle decision itself remains service-owned.
process.env.NODE_PATH = [
  resolve(packageRoot, 'services/bayn/node_modules'),
  resolve(packageRoot, 'node_modules/.bun/effect@4.0.0-beta.102/node_modules'),
  resolve(packageRoot, 'node_modules/.bun/effect@3.21.2/node_modules'),
  process.env.NODE_PATH,
]
  .filter((entry): entry is string => entry !== undefined && entry.length > 0)
  .join(delimiter)

const lifecycleModule = await import(pathToFileURL(resolve(packageRoot, lifecycleRelativePath)).href)
const { decideQualificationDormancy } = lifecycleModule
export const evaluateQualificationDormancy = decideQualificationDormancy

interface FrozenLineageModule {
  readonly frozenCandidateDevelopmentTrialHistory: unknown
}

/**
 * The lifecycle module owns decoding and fail-closed state validation. The
 * adapter treats only the canonical `ready`/`qualification-eligible` result
 * as runnable; reviewed-only states remain dormant.
 */
export type QualificationLifecycleDecision = QualificationDormancyDecision

type QualificationLifecycleResult = QualificationDormancyResult

const decideQualificationLifecycle = (history: unknown): QualificationLifecycleResult =>
  decideQualificationDormancy(history)

const loadFrozenTrialHistory = async (repositoryRoot: string): Promise<unknown> => {
  const modulePath = resolve(repositoryRoot, trialHistoryRelativePath)
  const loaded = (await import(pathToFileURL(modulePath).href)) as FrozenLineageModule
  return loaded.frozenCandidateDevelopmentTrialHistory
}

export const verifyQualificationDormancy = async (repositoryRoot: string): Promise<QualificationLifecycleDecision> => {
  const result = decideQualificationLifecycle(await loadFrozenTrialHistory(repositoryRoot))
  if (!result.ok) throw new Error(`${result.issue.path}: ${result.issue.reason}`)
  return result.decision
}

export interface QualificationWorkflowOutputs {
  readonly eligible: 'true' | 'false'
  readonly dormant: 'true' | 'false'
  readonly reason: string
  readonly candidateOrdinal: string
}

export const qualificationWorkflowOutputs = (
  decision: QualificationLifecycleDecision,
): QualificationWorkflowOutputs => {
  const eligible = decision.status === 'ready' && decision.reason === 'qualification-eligible'
  return {
    eligible: eligible ? 'true' : 'false',
    dormant: eligible ? 'false' : 'true',
    reason: decision.reason,
    candidateOrdinal: decision.candidateOrdinal === null ? '' : String(decision.candidateOrdinal),
  }
}

const argument = (name: string): string => {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

const run = async (): Promise<void> => {
  const decision = await verifyQualificationDormancy(argument('--repository-root'))
  const outputs = qualificationWorkflowOutputs(decision)
  await appendFile(
    argument('--github-output'),
    [
      `eligible=${outputs.eligible}`,
      `dormant=${outputs.dormant}`,
      `reason=${outputs.reason}`,
      `candidate_ordinal=${outputs.candidateOrdinal}`,
      '',
    ].join('\n'),
    'utf8',
  )
  process.stdout.write(`BAYN_QUALIFICATION_DORMANCY=${JSON.stringify(decision)}\n`)
}

if (import.meta.main) {
  await run().catch((cause) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    process.stderr.write(`qualification dormancy verification failed: ${message}\n`)
    process.exitCode = 1
  })
}
