import { isChartEntryTarget } from '../strategy/runtime-decision'
import { projectSessionCash } from './cash-history'
import { accountMarkValue } from './valuation'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { MutationEventType } from '../execution/mutations/model'
import { isSnapshotExecutionMarketDataBinding } from '../shadow-decision-contract'
import { SystemAssessmentInputSchema } from './assessment'
import { SystemAssessmentError, advanceQualificationEquity, netTradingPnl } from './economics'
import { registeredFinancialAccounts, retainedFinancialMarks } from './forward-evidence'
import { type SystemSourceCut } from './source-cut'
import { ObligationClass, ObligationOutcome, type ObligationCompletionSchema } from './reliability'
import { registeredSchedule } from './schedule'
import { cashFlowsSupported, cashFlowTotals, cashFlowsMatchSession } from './cash-flows'
import { requiredInferenceInputs } from './decision-inputs'
import type { VerifiedEntryTiming } from './entry-timing'
import type { VerifiedLatencyStress } from './latency-report'
import { executionOrderPlans } from './execution-plans'
import { bindExecutionEvidence } from './execution-evidence'
import { accountProtectionWork, decisionDocumentWork, entryAbstentionWork, positionHoldWork } from './decision-work'
import { earliestDurableWitnesses, indexObligationWitnesses } from './obligation-witnesses'
import { systemQualificationPolicy } from './policy'
import { assessSession } from './session'
import { costAttributionRule } from './cost-attribution'
import { decisionAdmissionWitnesses } from './decision-admissions'

/** Freeze dynamic denominators at the first admission/uncertainty, never at the most recent retry. */
export const mutationObligations = (
  cut: SystemSourceCut,
  registration: typeof SystemAssessmentInputSchema.Type.registration,
) =>
  Result.gen(function* () {
    const lastClose = registration.calendar.sessions.at(-1)?.closeAt
    if (lastClose === undefined)
      return yield* Result.fail(new SystemAssessmentError({ message: 'Missing registered window' }))
    const schedule = []
    const grouped = new Map<string, SystemSourceCut['mutations'][number]['event'][]>()
    for (const { event } of cut.mutations) {
      const events = grouped.get(event.mutationId)
      if (events === undefined) grouped.set(event.mutationId, [event])
      else events.push(event)
    }
    for (const [mutationId, retained] of grouped) {
      const events = retained.toSorted((a, b) => a.sequence - b.sequence)
      const start = events.find(
        (e) => e.eventType === MutationEventType.SubmitStarted || e.eventType === MutationEventType.CancelStarted,
      )
      if (start === undefined || start.occurredAt > lastClose) continue
      const deadlineAt = new Date(
        Date.parse(start.occurredAt) + registration.obligations.mutationDeadlineMs,
      ).toISOString()
      const scheduleEvidenceHash = yield* canonicalHashV1Result(start)
      schedule.push({
        obligationId: yield* canonicalHashV1Result({
          registrationHash: cut.registrationHash,
          mutationId,
          class: ObligationClass.Mutation,
        }),
        class: ObligationClass.Mutation,
        dueAt: start.occurredAt,
        deadlineAt,
        scheduleEvidenceHash,
      })
      const firstOutcome = events.find((e) => e.sequence > start.sequence)
      const recovered = events.some((e) =>
        [
          MutationEventType.RecoveryFound,
          MutationEventType.RecoveryNotFound,
          MutationEventType.RecoveryUnknown,
        ].includes(e.eventType),
      )
      const uncertain =
        firstOutcome === undefined ||
        [MutationEventType.SubmitUnknown, MutationEventType.CancelUnknown, MutationEventType.RecoveryUnknown].includes(
          firstOutcome.eventType,
        )
      const uncertainAt =
        uncertain && firstOutcome !== undefined
          ? firstOutcome.occurredAt
          : recovered
            ? new Date(Date.parse(start.occurredAt) + start.consistencyDelayMs).toISOString()
            : deadlineAt
      if (
        (uncertain || recovered || (firstOutcome !== undefined && firstOutcome.occurredAt > deadlineAt)) &&
        uncertainAt <= cut.asOf
      ) {
        const dueAt = uncertainAt < deadlineAt ? uncertainAt : deadlineAt
        schedule.push({
          obligationId: yield* canonicalHashV1Result({
            registrationHash: cut.registrationHash,
            mutationId,
            class: ObligationClass.Recovery,
          }),
          class: ObligationClass.Recovery,
          dueAt,
          deadlineAt: new Date(Date.parse(dueAt) + registration.obligations.recoveryDeadlineMs).toISOString(),
          scheduleEvidenceHash,
        })
      }
    }
    return schedule
  })

export const bindSystemSourceCut = (
  input: unknown,
  cut: SystemSourceCut,
  verifiedSources: ReadonlySet<string>,
  timings: readonly VerifiedEntryTiming[] = [],
  latencyStress: readonly VerifiedLatencyStress[] = [],
) =>
  Result.gen(function* () {
    const data = yield* Schema.decodeUnknownResult(SystemAssessmentInputSchema)(input)
    const fail = (message: string) => Result.fail(new SystemAssessmentError({ message }))
    const cutHash = yield* canonicalHashV1Result(cut)
    if (
      data.sourceCutHash !== cutHash ||
      data.asOf !== cut.asOf ||
      cut.runtimeConfigurationHash !== data.registration.obligations.runtimeConfigurationHash ||
      (yield* canonicalHashV1Result(data.registration)) !== cut.registrationHash
    )
      return yield* fail('Assessment must use its immutable registration and source cut exactly')
    const candidate = data.registration.policies.find((p) => p.policy === JevResearchPolicy.Candidate)
    if (candidate === undefined) return yield* fail('Registered candidate is missing')
    const admissions = yield* decisionAdmissionWitnesses(cut, candidate.authorityGenerationHash)
    const witnessedCut = { ...cut, durableObservations: [...cut.durableObservations, ...admissions.witnesses] }
    const controllerReceipts = new Map<string, string>()
    for (const pass of cut.controllerPasses) {
      const hash = yield* canonicalHashV1Result(pass)
      const previous = controllerReceipts.get(pass.receiptHash)
      if (previous !== undefined && previous !== hash)
        return yield* fail('Controller receipt has conflicting retained contents')
      controllerReceipts.set(pass.receiptHash, hash)
    }
    const definitionHash = yield* canonicalHashV1Result(candidate)
    const financialAccounts = yield* registeredFinancialAccounts(data.registration, cut.financial)
    const sources = new Set([
      ...verifiedSources,
      ...admissions.sources,
      yield* canonicalHashV1Result(costAttributionRule),
      cutHash,
      cut.registrationHash,
      cut.sourceMaterialHash,
      cut.inferenceLedgerEvidenceHash,
      ...cut.financial.flatMap((account) => [account.sourceHash, ...account.sessions.map((s) => s.evidenceHash)]),
    ])
    const policies = []
    for (const supplied of data.policies) {
      const stress = latencyStress.find((receipt) => receipt.policy === supplied.policy)
      if (stress !== undefined) {
        if (stress.registrationHash !== cut.registrationHash || stress.sourceCutHash !== cutHash)
          return yield* fail('Latency stress receipt differs from the registered source cut')
        sources.add(stress.sourceHash)
        if (stress.executionReceiptHash !== null) sources.add(stress.executionReceiptHash)
      }
      const policy = {
        ...supplied,
        sessions: supplied.sessions.map((session) => {
          const economics = stress?.economics?.sessions.find((s) => s.sessionDate === session.sessionDate)
          return {
            ...session,
            p95LatencyStress:
              stress !== undefined &&
              stress.image !== null &&
              stress.executionReceiptHash !== null &&
              economics?.complete === true &&
              economics.qualificationPnlMicros !== null
                ? {
                    protocolHash: stress.protocolHash,
                    sourceHash: stress.sourceHash,
                    qualificationPnlMicros: economics.qualificationPnlMicros,
                    image: stress.image,
                    executionReceiptHash: stress.executionReceiptHash,
                  }
                : null,
          }
        }),
      }
      const definition = data.registration.policies.find((registered) => registered.policy === policy.policy)
      if (definition === undefined) return yield* fail('Unregistered financial policy')
      const account = financialAccounts.get(policy.policy)
      const sessions = []
      let openingQualificationEquity: bigint | null = BigInt(systemQualificationPolicy.allocationMicros)
      for (const session of policy.sessions) {
        const inference = cut.inference.filter(
          (i) => i.accountBindingHash === definition.accountBindingHash && i.sessionDate === session.sessionDate,
        )
        if (inference.length > 1) return yield* fail('Source cut repeats a registered inference session')
        const inferenceEvidence = inference[0] ?? null
        if (inferenceEvidence !== null) sources.add(yield* canonicalHashV1Result(inferenceEvidence))
        const calendar = data.registration.calendar.sessions.find((s) => s.sessionDate === session.sessionDate)
        const capturedMarks =
          calendar === undefined
            ? []
            : retainedFinancialMarks(cut.accountMarks, {
                accountBindingHash: definition.accountBindingHash,
                ...calendar,
                asOf: cut.asOf,
              })
        const cashFlows =
          calendar !== undefined &&
          session.cashFlows !== null &&
          cashFlowsMatchSession(session.cashFlows, {
            ...calendar,
            accountBindingHash: definition.accountBindingHash,
            asOf: cut.asOf,
          }) &&
          (yield* cashFlowsSupported(session.cashFlows, sources))
            ? session.cashFlows
            : null
        const projectedMarks =
          calendar === undefined
            ? capturedMarks
            : yield* projectSessionCash(capturedMarks, account?.cashHistory ?? null, cashFlows, calendar.closeAt)
        const valued = projectedMarks.map((mark) => ({ ...mark, value: accountMarkValue(mark) }))
        // Preserve endpoint economics independently of unresolved intraday risk evidence.
        const opening = valued.find((mark) => mark.at === calendar?.openAt)
        const closing = valued.findLast((mark) => mark.at === calendar?.closeAt)
        const accountMarks = valued.some((mark) => mark.value === null) ? [] : valued
        const observation = account?.sessions.find((s) => s.sessionDate === session.sessionDate)
        const flow = cashFlows === null || closing === undefined ? null : cashFlowTotals(cashFlows, closing.at)
        const financial =
          observation?.facts !== undefined &&
          observation.facts !== null &&
          opening !== undefined &&
          opening.value !== null &&
          closing !== undefined &&
          closing.value !== null &&
          flow !== null &&
          opening.value.positionCount === observation.facts.openingPositionCount &&
          closing.value.positionCount === observation.facts.closingPositionCount
            ? {
                ...observation.facts,
                openingUnrealizedPnlMicros: opening.value.unrealizedPnlMicros,
                closingUnrealizedPnlMicros: closing.value.unrealizedPnlMicros,
                sourceHash: yield* canonicalHashV1Result({
                  financialSourceHash: observation.evidenceHash,
                  opening,
                  closing,
                  cashFlowSourceHash: yield* canonicalHashV1Result(cashFlows),
                }),
                cashInventory: {
                  openingEquityMicros: opening.value.equityMicros,
                  closingEquityMicros: closing.value.equityMicros,
                  netExternalFlowsMicros: flow.external.toString(),
                  passiveCashYieldMicros: flow.yieldAmount.toString(),
                  operatingCostsPaidFromAccountMicros: flow.paidOperating.toString(),
                },
              }
            : null
        const marks = []
        if (
          opening !== undefined &&
          opening.value !== null &&
          openingQualificationEquity !== null &&
          cashFlows !== null
        ) {
          for (const actual of accountMarks) {
            if (actual.value === null) continue
            const flow = cashFlowTotals(cashFlows, actual.at)
            const equity =
              openingQualificationEquity +
              BigInt(actual.value.equityMicros) -
              BigInt(opening.value.equityMicros) -
              flow.external -
              flow.yieldAmount +
              flow.paidOperating
            marks.push({
              at: actual.at,
              sourceHash: actual.sourceHash,
              cashFlowAdjustedTradingEquityMicros: equity.toString(),
            })
          }
        }
        for (const mark of marks) sources.add(mark.sourceHash)
        if (financial !== null) sources.add(financial.sourceHash)
        const boundSession = {
          ...session,
          financial,
          marks,
          inferenceEvidence,
          operatingCosts: {
            ...session.operatingCosts,
            trading:
              financial === null
                ? null
                : {
                    sourceHash: financial.sourceHash,
                    netPnlAfterExecutionFeesMicros: netTradingPnl(financial).toString(),
                  },
          },
        }
        const economics = yield* assessSession(boundSession, data.registration, definition, cut.asOf, sources)
        openingQualificationEquity = advanceQualificationEquity(
          openingQualificationEquity,
          economics.economicEvidenceComplete && economics.qualificationPnlMicros !== null
            ? BigInt(economics.qualificationPnlMicros)
            : null,
        )
        sessions.push(boundSession)
      }
      policies.push({ ...policy, sessions })
    }
    const earliestWitnesses = earliestDurableWitnesses(witnessedCut)
    const orderPlans = yield* executionOrderPlans(cut.decisions, cut.protectionIntents)
    const protectionIds = new Set(cut.protectionIntents.map((row) => row.intentId))
    const decisions = data.realism.decisions.filter((row) => !protectionIds.has(row.decisionId))
    const unsupportedAssumptions = [...data.realism.unsupportedAssumptions]
    for (const stress of latencyStress.filter((receipt) => receipt.executionReceiptHash === null))
      unsupportedAssumptions.push(
        `${stress.image === null ? 'MISSING_REPLAY_IMAGE_MEMBERSHIP' : 'UNAUTHENTICATED_REPLAY_RUNNER'}:${stress.reportHash}`,
      )
    for (const { document } of cut.decisions) {
      const supplied = data.realism.decisions.find((d) => d.decisionId === document.contentHash)
      if (supplied === undefined) continue // The evaluator reports the missing required decision.
      if (
        supplied.authorityGenerationHash !== candidate.authorityGenerationHash ||
        supplied.policyDefinitionHash !== definitionHash ||
        supplied.decisionAt !== document.createdAt ||
        supplied.snapshotHash !== document.bindings.snapshotContentHash
      )
        return yield* fail('Candidate decision identity or timing differs from its durable document')
      sources.add(document.bindings.snapshotContentHash)
      const required = [
        { contentHash: document.bindings.snapshotContentHash, availableAt: document.bindings.snapshotFinalizedAt },
        ...requiredInferenceInputs(document.strategyDecision),
      ]
      for (const binding of [document.bindings.decisionMarketData, document.bindings.executionMarketData]) {
        if (binding === undefined || !isSnapshotExecutionMarketDataBinding(binding)) continue
        for (const record of binding.streaming.records) {
          const availableAt = new Date(record.availableAtMs).toISOString()
          required.push({ contentHash: record.contentHash, availableAt })
        }
        for (const feature of [...binding.streaming.features, ...(binding.streaming.technical?.features ?? [])])
          required.push({
            contentHash: yield* canonicalHashV1Result(feature.value),
            availableAt: new Date(feature.availableAtMs).toISOString(),
          })
      }
      for (const input of required) sources.add(input.contentHash)
      const timing = timings.find((t) => t.timing.decisionHash === document.contentHash)
      if (timing !== undefined) {
        sources.add(timing.receipt.receiptHash)
        sources.add(yield* canonicalHashV1Result(timing.timing))
      } else if (isChartEntryTarget(document.strategyDecision))
        unsupportedAssumptions.push(`MISSING_NATIVE_ENTRY_TIMING:${document.contentHash}`)
      const visibility = earliestWitnesses.get(`DECISION:${document.contentHash}`)
      if (visibility === undefined && timing === undefined)
        unsupportedAssumptions.push(`MISSING_DURABLE_DECISION_VISIBILITY:${document.contentHash}`)
      const index = decisions.findIndex((d) => d.decisionId === document.contentHash)
      if (index >= 0)
        decisions[index] = {
          ...supplied,
          persistedAt: timing?.timing.decisionCommittedAt ?? visibility?.witnessedAt ?? supplied.persistedAt,
          inputs: [
            ...supplied.inputs.filter((i) => !required.some((r) => r.contentHash === i.contentHash)),
            ...required,
          ],
        }
    }
    const execution = yield* bindExecutionEvidence(data.realism.fills, cut, candidate.authorityGenerationHash)
    for (const hash of execution.sources) sources.add(hash)
    unsupportedAssumptions.push(...execution.missing)
    for (const plan of orderPlans.values()) {
      const protection = plan.protectionIntent
      if (protection === null) continue
      if (plan.createdAt > cut.asOf || protection.plan.createdAt > cut.asOf)
        return yield* fail('Protection intent or risk approval is later than the source cut')
      const witness = earliestWitnesses.get(`DECISION:${plan.decisionId}`)
      if (witness === undefined) unsupportedAssumptions.push(`MISSING_PROTECTION_INTENT_PERSISTENCE:${plan.intentId}`)
      sources.add(protection.sourceHash)
      sources.add(plan.document.contentHash)
      sources.add(protection.reconciliation.contentHash)
      decisions.push({
        decisionId: plan.decisionId,
        policyDefinitionHash: definitionHash,
        authorityGenerationHash: candidate.authorityGenerationHash,
        snapshotHash: protection.sourceHash,
        decisionAt: plan.createdAt,
        persistedAt: witness?.witnessedAt ?? cut.asOf,
        inputs: [
          { contentHash: plan.document.contentHash, availableAt: plan.document.createdAt },
          { contentHash: protection.reconciliation.contentHash, availableAt: protection.reconciliation.reconciledAt },
          { contentHash: protection.sourceHash, availableAt: protection.riskDecision.decidedAt },
        ],
      })
    }
    const dynamic = yield* mutationObligations(cut, data.registration)
    for (const row of dynamic) sources.add(row.scheduleEvidenceHash)
    const schedule = [...(yield* registeredSchedule(data.registration)), ...dynamic]
    for (const row of schedule) sources.add(row.scheduleEvidenceHash)
    const completions: (typeof ObligationCompletionSchema.Type)[] = []
    const controllerWork = new Map<string, { sourceAt: string; completedAt: string; correct: boolean }>()
    for (const pass of cut.controllerPasses) {
      const witness = earliestWitnesses.get(`CONTROLLER:${pass.receiptHash}:${pass.completedAt}`)
      if (witness === undefined) continue
      const work =
        (yield* positionHoldWork(pass, data.registration, cut.decisions, witness.witnessedAt)) ??
        (yield* entryAbstentionWork(pass, data.registration, witness.witnessedAt)) ??
        (yield* accountProtectionWork(pass, data.registration, witness.witnessedAt))
      if (work !== undefined) controllerWork.set(pass.receiptHash, { ...work, completedAt: pass.completedAt })
    }
    const documentWork = new Map(
      cut.decisions.map(({ document }) => [document.contentHash, decisionDocumentWork(document, data.registration)]),
    )
    const indexedWitnesses = yield* indexObligationWitnesses(
      witnessedCut,
      data.registration,
      schedule,
      controllerWork,
      documentWork,
    )
    for (const obligation of schedule) {
      const witnesses = indexedWitnesses.get(obligation.obligationId) ?? []
      const selected =
        witnesses.find((w) => w.correct && w.witness.witnessedAt <= obligation.deadlineAt) ?? witnesses[0]
      if (selected === undefined) continue
      const evidenceHash = yield* canonicalHashV1Result(selected.witness)
      sources.add(evidenceHash)
      completions.push({
        obligationId: obligation.obligationId,
        outcome: selected.correct ? ObligationOutcome.Correct : ObligationOutcome.Failed,
        completedAt: selected.witness.witnessedAt,
        evidenceHash,
      })
    }
    const obligationCoverageHash = yield* canonicalHashV1Result({ cutHash, schedule, completions })
    sources.add(obligationCoverageHash)
    return {
      input: {
        ...data,
        policies,
        realism: {
          ...data.realism,
          decisions,
          fills: execution.fills,
          unsupportedAssumptions,
          expectedDecisionIds: [
            ...new Set([
              ...data.realism.expectedDecisionIds,
              ...cut.decisions.map(({ document }) => document.contentHash),
              ...cut.protectionIntents.map((row) => row.intentId),
            ]),
          ],
          expectedFillIds: [...new Set([...data.realism.expectedFillIds, ...cut.fills.map((fill) => fill.fillId)])],
        },
        obligationCoverageHash,
        reliability: { asOf: cut.asOf, schedule, completions },
      },
      verifiedSources: sources,
    }
  })
