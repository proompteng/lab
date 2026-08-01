import type { CandidateDevelopmentCommandFailure } from './contracts'
import {
  candidateDevelopmentCommandFailureListFields,
  candidateDevelopmentCommandFailureNestedFields,
  candidateDevelopmentCommandFailureObjectSupported,
  candidateDevelopmentCommandFailureOutputMaxBytes,
  candidateDevelopmentCommandFailureOutputSchemaVersion,
  candidateDevelopmentCommandFailureProjectionMaxDepth,
  candidateDevelopmentCommandFailureProjectionMaxNodes,
  candidateDevelopmentCommandFailureScalarFields,
  candidateDevelopmentCommandIsSchemaError,
  candidateDevelopmentCommandIsSchemaIssue,
  candidateDevelopmentCommandSchemaTags,
  projectCandidateDevelopmentCommandSchemaError,
  projectCandidateDevelopmentCommandSchemaIssue,
  readCandidateDevelopmentCommandFailureProperty,
  rejectedCandidateDevelopmentCommandFailureDetail,
  safeCandidateDevelopmentCommandFailureFieldPathScalar,
  safeCandidateDevelopmentCommandFailureScalar,
  safeCandidateDevelopmentCommandFailureToken,
  safeCandidateDevelopmentCommandFailureTokenList,
  type CandidateDevelopmentCommandFailureProjectionBudget,
} from './failure-core'
import {
  candidateDevelopmentCommandFailureDetailIsImmutableGitCause,
  candidateDevelopmentCommandFailureDetailIsKnownMismatch,
  candidateDevelopmentCommandFailureDetailIsLineageCause,
  candidateDevelopmentCommandFailureDetailIsMissingPreregistrationCause,
  candidateDevelopmentCommandFailureDetailIsModuleNoveltyCause,
  candidateDevelopmentCommandFailureDetailIsUntagged,
  projectCandidateDevelopmentCommandImmutableGitCause,
  projectCandidateDevelopmentCommandKnownMismatch,
  projectCandidateDevelopmentCommandLineageCause,
  projectCandidateDevelopmentCommandMissingPreregistrationCause,
  projectCandidateDevelopmentCommandModuleNoveltyCause,
  projectCandidateDevelopmentCommandOperationalError,
  projectCandidateDevelopmentGeometryFail,
} from './failure-operational'
import {
  candidateDevelopmentCommandFailureDetailIsMalformedPreregistrationCause,
  projectCandidateDevelopmentCommandCanonicalJsonPath,
  projectCandidateDevelopmentCommandMalformedPreregistrationCause,
  projectCandidateDevelopmentCommandModuleFormatCause,
  projectCandidateDevelopmentCommandModulePath,
  projectCandidateDevelopmentCommandValidationMismatchFields,
} from './failure-validation'
import {
  projectCandidateDevelopmentCommandMarkedEquityCause,
  projectCandidateDevelopmentCommandSimulationDomainFields,
  projectCandidateDevelopmentCommandSimulationReconciliationIssueFields,
} from './failure-domain'
import {
  candidateDevelopmentCommandFailureScalarIsSpecialized,
  projectCandidateDevelopmentCommandExecutionModelFields,
  projectCandidateDevelopmentCommandTaggedDomainFields,
} from './failure-execution'

export const projectCandidateDevelopmentCommandFailureDetail = (
  value: unknown,
  depth: number,
  ancestors: ReadonlySet<object>,
  budget: CandidateDevelopmentCommandFailureProjectionBudget,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) {
    return rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value')
  }
  if (candidateDevelopmentCommandIsSchemaError(value)) {
    return projectCandidateDevelopmentCommandSchemaError(value, depth, ancestors, budget)
  }
  if (candidateDevelopmentCommandIsSchemaIssue(value)) {
    return projectCandidateDevelopmentCommandSchemaIssue(value, depth, ancestors, budget)
  }
  if (depth > candidateDevelopmentCommandFailureProjectionMaxDepth) {
    return rejectedCandidateDevelopmentCommandFailureDetail('depth-limit')
  }
  if (ancestors.has(value)) return rejectedCandidateDevelopmentCommandFailureDetail('cycle')
  if (budget.nodes >= candidateDevelopmentCommandFailureProjectionMaxNodes) {
    return rejectedCandidateDevelopmentCommandFailureDetail('detail-limit')
  }
  if (!candidateDevelopmentCommandFailureObjectSupported(value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('non-plain-object')
  }

  const operationalError = projectCandidateDevelopmentCommandOperationalError(value, ancestors, budget)
  if (operationalError !== undefined) return operationalError

  const tag = readCandidateDevelopmentCommandFailureProperty(value, '_tag')
  if (tag._tag === 'Rejected') return rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
  if (tag._tag === 'Absent') return rejectedCandidateDevelopmentCommandFailureDetail('untyped-object')
  if (!safeCandidateDevelopmentCommandFailureToken(tag.value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-tag')
  }
  if (candidateDevelopmentCommandSchemaTags.has(tag.value)) {
    return rejectedCandidateDevelopmentCommandFailureDetail('invalid-tag')
  }

  budget.nodes += 1
  budget.scalars += 1
  const projected: Record<string, unknown> = { _tag: tag.value }
  const rejectedFields: string[] = []

  for (const field of candidateDevelopmentCommandFailureScalarFields) {
    if (candidateDevelopmentCommandFailureScalarIsSpecialized(tag.value, field)) continue
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    if (property._tag === 'Rejected') {
      rejectedFields.push(field)
      continue
    }
    const scalar =
      field === 'field'
        ? safeCandidateDevelopmentCommandFailureFieldPathScalar(property.value, budget)
        : safeCandidateDevelopmentCommandFailureScalar(property.value, budget)
    if (scalar === undefined) rejectedFields.push(field)
    else projected[field] = scalar
  }

  for (const field of candidateDevelopmentCommandFailureListFields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    if (property._tag === 'Rejected') {
      rejectedFields.push(field)
      continue
    }
    const list = safeCandidateDevelopmentCommandFailureTokenList(property.value, budget)
    if (list === undefined) rejectedFields.push(field)
    else projected[field] = list
  }

  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  Object.assign(
    projected,
    projectCandidateDevelopmentCommandExecutionModelFields(value, tag.value, budget),
    projectCandidateDevelopmentCommandSimulationDomainFields(value, tag.value, budget),
    projectCandidateDevelopmentCommandTaggedDomainFields(value, tag.value, nextAncestors, budget),
    projectCandidateDevelopmentCommandValidationMismatchFields(value, tag.value, nextAncestors, budget),
    projectCandidateDevelopmentCommandCanonicalJsonPath(value, tag.value, budget),
    projectCandidateDevelopmentCommandModulePath(value, tag.value, budget),
    projectCandidateDevelopmentCommandSimulationReconciliationIssueFields(
      value,
      tag.value,
      depth,
      nextAncestors,
      budget,
    ),
  )
  for (const field of candidateDevelopmentCommandFailureNestedFields) {
    const property = readCandidateDevelopmentCommandFailureProperty(value, field)
    if (property._tag === 'Absent') continue
    projected[field] =
      property._tag === 'Rejected'
        ? rejectedCandidateDevelopmentCommandFailureDetail('introspection-failed')
        : field === 'preflight' && tag.value === 'CandidateDevelopmentPreflightFailed'
          ? projectCandidateDevelopmentGeometryFail(property.value, nextAncestors, budget)
          : field === 'cause' && tag.value === 'CandidateDevelopmentCommandMarkedEquityInvalid'
            ? projectCandidateDevelopmentCommandMarkedEquityCause(property.value, depth + 1, nextAncestors, budget)
            : field === 'cause' &&
                tag.value === 'CandidateDevelopmentCommandProgramInvalid' &&
                projected.reason === 'strategy-protocol-hash-mismatch' &&
                candidateDevelopmentCommandFailureDetailIsUntagged(property.value)
              ? projectCandidateDevelopmentCommandKnownMismatch(
                  property.value,
                  nextAncestors,
                  budget,
                  'program-strategy-protocol-hash',
                )
              : field === 'cause' &&
                  tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                  projected.operation === 'verify-module-format' &&
                  candidateDevelopmentCommandFailureDetailIsUntagged(property.value)
                ? projectCandidateDevelopmentCommandModuleFormatCause(property.value, nextAncestors, budget)
                : field === 'cause' &&
                    tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                    projected.operation === 'verify-preregistration-blob' &&
                    candidateDevelopmentCommandFailureDetailIsMalformedPreregistrationCause(property.value)
                  ? projectCandidateDevelopmentCommandMalformedPreregistrationCause(
                      property.value,
                      nextAncestors,
                      budget,
                    )
                  : field === 'cause' &&
                      tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                      projected.operation === 'verify-preregistration-lineage' &&
                      candidateDevelopmentCommandFailureDetailIsLineageCause(property.value)
                    ? projectCandidateDevelopmentCommandLineageCause(property.value, nextAncestors, budget)
                    : field === 'cause' &&
                        tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                        projected.operation === 'verify-preregistration-module-novelty' &&
                        candidateDevelopmentCommandFailureDetailIsModuleNoveltyCause(property.value)
                      ? projectCandidateDevelopmentCommandModuleNoveltyCause(property.value, nextAncestors, budget)
                      : field === 'cause' &&
                          tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                          candidateDevelopmentCommandFailureDetailIsImmutableGitCause(property.value)
                        ? (projectCandidateDevelopmentCommandImmutableGitCause(property.value, nextAncestors, budget) ??
                          rejectedCandidateDevelopmentCommandFailureDetail('unsupported-value'))
                        : field === 'cause' &&
                            tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                            projected.operation === 'verify-program-binding' &&
                            candidateDevelopmentCommandFailureDetailIsMissingPreregistrationCause(property.value)
                          ? projectCandidateDevelopmentCommandMissingPreregistrationCause(
                              property.value,
                              nextAncestors,
                              budget,
                            )
                          : field === 'cause' &&
                              tag.value === 'CandidateDevelopmentCommandSourceVerificationFailed' &&
                              candidateDevelopmentCommandFailureDetailIsKnownMismatch(property.value)
                            ? projectCandidateDevelopmentCommandKnownMismatch(
                                property.value,
                                nextAncestors,
                                budget,
                                'verified-program-binding',
                              )
                            : projectCandidateDevelopmentCommandFailureDetail(
                                property.value,
                                depth + 1,
                                nextAncestors,
                                budget,
                              )
  }

  if (rejectedFields.length > 0) projected.rejectedFields = rejectedFields
  return projected
}

export const renderCandidateDevelopmentCommandFailure = (failure: CandidateDevelopmentCommandFailure): string => {
  const projectedFailure = projectCandidateDevelopmentCommandFailureDetail(failure, 0, new Set(), {
    nodes: 0,
    scalars: 0,
  })
  const rendered = `${JSON.stringify({
    schemaVersion: candidateDevelopmentCommandFailureOutputSchemaVersion,
    error: {
      _tag: 'CandidateDevelopmentCommandError',
      failure: projectedFailure,
    },
  })}\n`
  if (Buffer.byteLength(rendered, 'utf8') <= candidateDevelopmentCommandFailureOutputMaxBytes) return rendered

  const topLevelTag = projectedFailure._tag
  return `${JSON.stringify({
    schemaVersion: candidateDevelopmentCommandFailureOutputSchemaVersion,
    error: {
      _tag: 'CandidateDevelopmentCommandError',
      failure: {
        ...(safeCandidateDevelopmentCommandFailureToken(topLevelTag) ? { _tag: topLevelTag } : {}),
        detail: rejectedCandidateDevelopmentCommandFailureDetail('output-limit'),
      },
    },
  })}\n`
}

export const renderCandidateDevelopmentCommandDefect = (): string =>
  `${JSON.stringify({
    schemaVersion: candidateDevelopmentCommandFailureOutputSchemaVersion,
    error: {
      _tag: 'CandidateDevelopmentCommandDefect',
      reason: 'unhandled-defect',
    },
  })}\n`
