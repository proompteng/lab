#!/usr/bin/env bun

import { appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

export type QualificationDormancyDecision =
  | {
      readonly status: 'dormant'
      readonly reason: string
      readonly candidateOrdinal: number | null
    }
  | {
      readonly status: 'ready'
      readonly reason: 'qualification-eligible'
      readonly candidateOrdinal: number
      readonly preregistrationSourceRevision: string
      readonly preregistrationBlobOid: string
    }

export type QualificationDormancyResult =
  | { readonly ok: true; readonly decision: QualificationDormancyDecision }
  | { readonly ok: false; readonly issue: { readonly path: string; readonly reason: string } }

const ledgerRelativePath = 'services/bayn/src/candidate-development-trials/ledger.ts'
const lifecycleRelativePath = 'services/bayn/src/candidate-development-trials/qualification-dormancy.ts'
const packageRoot = resolve(import.meta.dir, '../../../..')

interface LifecycleModule {
  readonly decideQualificationDormancy: (value: unknown) => QualificationDormancyResult
  readonly qualificationDormancyDecisionFromLedgerState: (value: unknown) => QualificationDormancyResult
}

let lifecycleModulePromise: Promise<LifecycleModule> | undefined

const lifecycleModule = (): Promise<LifecycleModule> =>
  (lifecycleModulePromise ??= import(
    pathToFileURL(resolve(packageRoot, lifecycleRelativePath)).href
  ) as Promise<LifecycleModule>)

/** The service lifecycle decision is the only authority for qualification state and fail-closed validation. */
export const evaluateQualificationDormancy = async (value: unknown): Promise<QualificationDormancyResult> =>
  (await lifecycleModule()).decideQualificationDormancy(value)

interface LedgerModule {
  readonly candidateDevelopmentTrialLedgerState: unknown
}

/** Only the canonical ready/qualification-eligible decision can cross into the runnable workflow. */
export type QualificationLifecycleDecision = QualificationDormancyDecision

const loadTrialLedgerState = async (repositoryRoot: string): Promise<unknown> => {
  const modulePath = resolve(repositoryRoot, ledgerRelativePath)
  const loaded = (await import(pathToFileURL(modulePath).href)) as LedgerModule
  return loaded.candidateDevelopmentTrialLedgerState
}

export const verifyQualificationDormancy = async (repositoryRoot: string): Promise<QualificationLifecycleDecision> => {
  const result = (await lifecycleModule()).qualificationDormancyDecisionFromLedgerState(
    await loadTrialLedgerState(repositoryRoot),
  )
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
