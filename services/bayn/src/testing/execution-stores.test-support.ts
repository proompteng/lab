import { Effect } from 'effect'

import { CycleStore, type CycleStoreShape } from '../cycle/store/model'
import { IntentStore, planExecutionIntent, type IntentStoreService } from '../execution/intents/domain'
import { MutationStore, type MutationStoreShape } from '../execution/mutations/model'
import { intentPlanSchemaVersion, type AuthorityState } from '../execution/contracts'
import type { CycleDecisionDocument } from '../shadow-decision-contract'

const unexpected = (operation: string) => () => Effect.die(new Error(`Unexpected fixture operation: ${operation}`))

export const cycleStoreFixture = (overrides: Partial<CycleStoreShape>): CycleStoreShape => ({
  acquire: unexpected('acquire cycle'),
  read: unexpected('read cycle'),
  readAuthoritySlot: unexpected('read authority slot'),
  readDecisionDocument: unexpected('read cycle decision'),
  readOldestUnfinished: unexpected('read unfinished cycle'),
  activate: unexpected('activate cycle'),
  bindDecision: unexpected('bind cycle decision'),
  finish: unexpected('finish cycle'),
  block: unexpected('block cycle'),
  ...overrides,
})

export const noProtection: Pick<IntentStoreService, 'protectionForCycle'> = {
  protectionForCycle: () => Effect.succeed([]),
}

export const intentStoreFixture = (overrides: Partial<IntentStoreService>): IntentStoreService => ({
  read: unexpected('read intent'),
  commit: unexpected('commit intent'),
  protectionForCycle: unexpected('read position protection'),
  beginProtectionCancel: unexpected('begin protection cancellation'),
  recordProtectionCancelAccepted: unexpected('record protection cancellation'),
  ...overrides,
})

export const mutationStoreFixture = (overrides: Partial<MutationStoreShape>): MutationStoreShape => ({
  authorizeSubmit: unexpected('authorize submit'),
  beginSubmit: unexpected('begin submit'),
  submitAccepted: unexpected('record accepted submit'),
  submitRejected: unexpected('record rejected submit'),
  submitDenied: unexpected('record denied submit'),
  submitUnknown: unexpected('record uncertain submit'),
  beginCancel: unexpected('begin cancel'),
  cancelAccepted: unexpected('record accepted cancel'),
  cancelUnknown: unexpected('record uncertain cancel'),
  recoveryFound: unexpected('recover found mutation'),
  recoveryNotFound: unexpected('recover missing mutation'),
  recoveryUnknown: unexpected('recover uncertain mutation'),
  latest: unexpected('read latest mutation'),
  ...overrides,
})

export const withFixtureCycleStore = (overrides: Partial<CycleStoreShape> = {}) =>
  Effect.provideService(CycleStore, cycleStoreFixture(overrides))

export const withFixtureIntentStore = (overrides: Partial<IntentStoreService> = {}) =>
  Effect.provideService(IntentStore, intentStoreFixture(overrides))

export const withFixtureMutationStore = (overrides: Partial<MutationStoreShape> = {}) =>
  Effect.provideService(MutationStore, mutationStoreFixture(overrides))

export const planFixtureIntents = (document: CycleDecisionDocument, authority: AuthorityState) =>
  Effect.forEach(document.targetPlan.intentTargets, (target, index) => {
    const risk = document.deltaRisk[index]
    if (risk === undefined) return Effect.die('Missing bound intent risk')
    return planExecutionIntent(
      {
        schemaVersion: intentPlanSchemaVersion,
        ...target,
        notionalLimitMicros: risk.notionalLimitMicros,
        limitPriceMicros: risk.limitPriceMicros,
        ...(risk.protection === undefined ? {} : { protection: risk.protection }),
        createdAt: document.createdAt,
      },
      { authority },
    ).pipe(Effect.map((intent) => ({ intent, decision: risk.evaluation.decision })))
  })
