import { Result } from 'effect'

import { OperationalError, type Component } from '../errors'
import { renderCanonicalJsonFailure } from '../hash'
import { renderQualificationConstructionFailure } from '../qualification'
import { renderQualificationStatisticsFailure } from '../qualification-statistics'
import { renderRiskBalancedTrendFailure, renderRiskBalancedTrendEvaluationIssues } from '../risk-balanced-trend'
import type { StrategyPrepareLockFailure } from '../strategy'
import type { StartupDecisionFailure } from './model'

const causeMessage = (cause: unknown): string => {
  const rendered = Result.try({
    try: () => String(cause instanceof Error ? cause.message : cause),
    catch: () => undefined,
  })
  return Result.isSuccess(rendered) ? rendered.success : 'unrenderable cause'
}

interface StartupFailurePresentation {
  readonly component: Component
  readonly operation: string
  readonly message: string
}

const presentFailure = (component: Component, operation: string, message: string): StartupFailurePresentation => ({
  component,
  operation,
  message,
})

const renderCanonicalizationFailure = (
  failure: Extract<StartupDecisionFailure, { readonly _tag: 'CanonicalizationFailed' }>,
): StartupFailurePresentation => {
  const detail = renderCanonicalJsonFailure(failure.details.cause)
  switch (failure.details.target) {
    case 'stored-protocol-parameters':
      return presentFailure(
        'database',
        'recover-pinned-qualification',
        `stored qualification provenance is invalid: ${detail}`,
      )
    case 'qualification-lock':
      return presentFailure('database', 'open-qualification', `qualification lock binding failed: ${detail}`)
    case 'pinned-lock':
    case 'pinned-snapshot':
      return presentFailure(
        'database',
        'recover-pinned-qualification',
        `pinned qualification binding failed: ${detail}`,
      )
    case 'pinned-verdict':
      return presentFailure(
        'database',
        'recover-pinned-qualification',
        `pinned qualification recovery failed: ${detail}`,
      )
    case 'terminal-verdict':
      return presentFailure('database', 'recover-qualification', `qualification recovery failed: ${detail}`)
    case 'locked-manifest':
      return presentFailure('market-data', 'load-locked', `locked Signal load failed: ${detail}`)
  }
}

const renderPrepareLockFailure = (failure: StrategyPrepareLockFailure): string => {
  switch (failure._tag) {
    case 'QualificationCanonicalizationFailed':
    case 'QualificationSchemaInvalid':
    case 'QualificationRunIdMismatch':
    case 'QualificationPriorTrialLineageMismatch':
      return renderQualificationConstructionFailure(failure)
    default:
      return renderRiskBalancedTrendFailure(failure)
  }
}

const renderStrategyOperationFailure = (
  failure: Extract<StartupDecisionFailure, { readonly _tag: 'StrategyOperationFailed' }>,
): string => {
  switch (failure.operation) {
    case 'prepare-lock':
      return renderPrepareLockFailure(failure.cause)
    case 'evaluate':
      return renderRiskBalancedTrendEvaluationIssues(failure.cause)
    case 'analyze':
      return renderQualificationStatisticsFailure(failure.cause)
    case 'qualify':
      return renderQualificationConstructionFailure(failure.cause)
  }
}

const startupFailurePresentation = (failure: StartupDecisionFailure): StartupFailurePresentation => {
  switch (failure._tag) {
    case 'StoredProvenanceInvalid': {
      const detail =
        failure.issue.reason === 'unsupported-contract'
          ? 'stored evaluation uses an unsupported strategy contract'
          : failure.issue.reason === 'malformed'
            ? causeMessage(failure.issue.cause)
            : 'stored evaluation protocol does not match its own provenance'
      return presentFailure(
        'database',
        'recover-pinned-qualification',
        `stored qualification provenance is invalid: ${detail}`,
      )
    }
    case 'CanonicalizationFailed':
      return renderCanonicalizationFailure(failure)
    case 'QualificationStateInvalid':
      switch (failure.details.reason) {
        case 'evidence-missing':
          return failure.details.phase === 'recover-terminal'
            ? presentFailure(
                'database',
                'recover-evaluation',
                `terminal qualification run ${failure.details.runId} is missing`,
              )
            : presentFailure(
                'database',
                failure.details.phase === 'read-pinned' ? 'read-pinned-qualification' : 'recover-pinned-qualification',
                `pinned evaluation ${failure.details.runId} is missing`,
              )
        case 'pinned-not-terminal':
          return presentFailure(
            'database',
            'read-pinned-qualification',
            `pinned qualification ${failure.details.runId} is not terminal`,
          )
        case 'opened-incomplete':
          return presentFailure(
            'database',
            'open-qualification',
            `qualification ${failure.details.lockId} was opened without a terminal result`,
          )
      }
    case 'BindingMismatch':
      switch (failure.details.binding) {
        case 'qualification-lock':
          return presentFailure(
            'database',
            'open-qualification',
            'qualification lock binding failed: store returned a different candidate lock',
          )
        case 'pinned-run':
          return presentFailure(
            'database',
            'recover-pinned-qualification',
            'pinned qualification binding failed: stored evaluation and terminal qualification run IDs differ',
          )
        case 'pinned-lock':
          return presentFailure(
            'database',
            'recover-pinned-qualification',
            'pinned qualification binding failed: qualification lock differs from the stored execution provenance',
          )
        case 'pinned-snapshot':
          return presentFailure(
            'database',
            'recover-pinned-qualification',
            'pinned qualification binding failed: configured Signal snapshot differs from the pinned qualification',
          )
        case 'recovery':
          return failure.details.phase === 'pinned'
            ? presentFailure(
                'database',
                'recover-pinned-qualification',
                'pinned qualification recovery failed: recovered evidence differs from the terminal qualification',
              )
            : presentFailure(
                'database',
                'recover-qualification',
                'qualification recovery failed: terminal qualification differs from the recovered evaluation',
              )
        case 'terminal-run':
          return presentFailure(
            'database',
            'recover-qualification',
            'qualification recovery failed: terminal lock and result run IDs differ',
          )
        case 'locked-manifest':
          return presentFailure(
            'market-data',
            'load-locked',
            'locked Signal load failed: loaded Signal manifest differs from the locked inspection',
          )
        case 'evaluation-run':
          return presentFailure('strategy', 'evaluate', 'evaluation run identity differs from the qualification lock')
      }
    case 'StrategyOperationFailed': {
      const label = {
        'prepare-lock': 'lock preparation',
        evaluate: 'evaluation',
        analyze: 'analysis',
        qualify: 'qualification',
      }[failure.operation]
      const detail = renderStrategyOperationFailure(failure)
      return presentFailure('strategy', failure.operation, `${failure.strategyName} ${label} failed: ${detail}`)
    }
  }
}

export const renderStartupDecisionFailure = (failure: StartupDecisionFailure): OperationalError =>
  new OperationalError({
    ...startupFailurePresentation(failure),
    retryable: false,
    cause: failure,
  })
