import { Order, Schema, type Redacted } from 'effect'

import {
  AccountResponseSchema,
  AccountStatus,
  AssetClass,
  OrderResponseSchema,
  PositionResponseSchema,
  PositionSide,
} from '../src/broker/alpaca/model'
import { UtcInstantSchema } from '../src/schemas'

export enum Phase {
  PreOpen = 'pre-open',
  PostFlatten = 'post-flatten',
  PostCutover = 'post-cutover',
}

export enum Format {
  Json = 'json',
  Markdown = 'markdown',
}

export enum CheckStatus {
  Pass = 'PASS',
  Fail = 'FAIL',
  Skipped = 'SKIPPED',
}

export enum OntologyStatus {
  Healthy = 'HEALTHY',
  Degraded = 'DEGRADED',
  Unreachable = 'UNREACHABLE',
}

export enum AlpacaEndpoint {
  Paper = 'PAPER',
  Live = 'LIVE',
}

export const AccountIdentitySchema = Schema.Struct({
  id: AccountResponseSchema.fields.id,
  status: AccountResponseSchema.fields.status,
})
export const MacroAccountSchema = Schema.Struct({
  ...AccountIdentitySchema.fields,
  equity: AccountResponseSchema.fields.equity.check(Schema.makeFilter((value) => Number.isFinite(Number(value)))),
  buying_power: AccountResponseSchema.fields.buying_power.check(
    Schema.makeFilter((value) => Number.isFinite(Number(value))),
  ),
})
const { symbol, qty, side, asset_class } = PositionResponseSchema.fields
export const PositionsSchema = Schema.Array(Schema.Struct({ symbol, qty, side, asset_class }))
export const openOrderLimit = 500
export const OpenOrdersSchema = Schema.Array(
  Schema.Struct({
    symbol: OrderResponseSchema.fields.symbol,
    status: OrderResponseSchema.fields.status,
    legs: Schema.optionalKey(Schema.Null),
  }),
).check(Schema.isMaxLength(openOrderLimit - 1, { description: 'an untruncated flat open-order response' }))

enum PassResult {
  Success = 'SUCCESS',
  Failure = 'FAILURE',
}

enum PassOutcome {
  Waiting = 'WAITING',
  AdmissionWaiting = 'ADMISSION_WAITING',
  WindowClosed = 'WINDOW_CLOSED',
  AlreadyAcquired = 'ALREADY_ACQUIRED',
  AlreadyTerminal = 'ALREADY_TERMINAL',
  Recovered = 'RECOVERED',
  Acquired = 'ACQUIRED',
  Reacquired = 'REACQUIRED',
}

export const ObservationSchema = Schema.Union([
  Schema.Struct({
    timestamp: UtcInstantSchema,
    result: Schema.Literal(PassResult.Success),
    outcome: Schema.Enum(PassOutcome),
  }),
  Schema.Struct({
    timestamp: UtcInstantSchema,
    result: Schema.Literal(PassResult.Failure),
    outcome: Schema.Null,
  }),
])

export type AccountIdentity = typeof AccountIdentitySchema.Type
export type MacroAccount = typeof MacroAccountSchema.Type
export type Positions = typeof PositionsSchema.Type
export type OpenOrders = typeof OpenOrdersSchema.Type
export interface PostgresEvidence {
  readonly standby: boolean
  readonly latestObservation: typeof ObservationSchema.Type | null
}

export enum FailureKind {
  Configuration = 'CONFIGURATION',
  Transport = 'TRANSPORT',
  Timeout = 'TIMEOUT',
  HttpStatus = 'HTTP_STATUS',
  Decode = 'DECODE',
  Database = 'DATABASE',
  Output = 'OUTPUT',
}

export interface ProbeProblem {
  readonly kind: FailureKind
  readonly operation: string
  readonly message: string
  readonly cause?: Redacted.Redacted<unknown>
  readonly httpStatus?: number
}

export type Check<A> =
  | {
      readonly status: CheckStatus.Pass | CheckStatus.Fail
      readonly evidence: A
      readonly failures: readonly string[]
      readonly warnings: readonly string[]
    }
  | { readonly status: CheckStatus.Fail; readonly problems: readonly ProbeProblem[] }
  | { readonly status: CheckStatus.Skipped; readonly reason: string }

export const evaluated = <A>(evidence: A, failures: readonly string[], warnings: readonly string[] = []): Check<A> => ({
  status: failures.length === 0 ? CheckStatus.Pass : CheckStatus.Fail,
  evidence,
  failures,
  warnings,
})

export const failed = (problems: readonly ProbeProblem[]): Check<never> => ({ status: CheckStatus.Fail, problems })
export const skipped = (reason: string) => ({ status: CheckStatus.Skipped, reason }) as const

export type OntologyCheck =
  | ReturnType<typeof skipped>
  | { readonly status: OntologyStatus; readonly problem?: ProbeProblem }

export const intradayPolicyVersion = 'bayn.intraday-alpha-policy.v3'
// The canonical parameter hash binds the deployed build to the reviewed v3 policy document (#16395).
const v3ParameterHash = '40d0643d63c368dd207d0f6a55b3feadb673dbd74b7c8b82bd7ee8d52e256eb5'
const allowedEtfs = new Set(['QQQ', 'SMH', 'XLK'])
const isZero = (quantity: string) => /^0(?:\.0+)?$/.test(quantity)

interface PolicyComparison {
  readonly expectedBehaviorHash: string
  readonly observed: { readonly behaviorHash: string; readonly parameterHash: string } | null
}

interface AccountBinding<A> {
  readonly account: A
  readonly expectedId: string | undefined
}

const accountFailures = ({ account, expectedId }: AccountBinding<AccountIdentity>, label: string): string[] => [
  ...(account.status === AccountStatus.Active ? [] : [`${label} is not ACTIVE.`]),
  ...(expectedId === undefined || account.id === expectedId
    ? []
    : [`${label} differs from its configured account ID.`]),
]

export const verifyIntraday = (
  phase: Phase,
  binding: AccountBinding<AccountIdentity>,
  positions: Positions,
  openOrders: OpenOrders,
  policy: PolicyComparison | null = null,
) => {
  const failures = accountFailures(binding, 'Account #1')
  const googlQuantities = positions
    .filter(({ symbol, qty }) => symbol === 'GOOGL' && !isZero(qty))
    .map(({ qty, side }) => `${side === PositionSide.Short ? '-' : ''}${qty.replace(/^-/, '')}`)
    .sort(Order.String)
  const googlOpenOrders = openOrders.filter(({ symbol }) => symbol === 'GOOGL').length
  const unexpectedPositions = positions
    .filter(({ asset_class, symbol }) => asset_class !== AssetClass.UsEquity || !allowedEtfs.has(symbol))
    .map(({ symbol }) => symbol)
    .sort(Order.String)

  if (phase === Phase.PostFlatten) {
    if (googlQuantities.length > 0) failures.push('A non-zero GOOGL position remains.')
    if (googlOpenOrders > 0) failures.push('An open GOOGL order remains.')
  }
  let verifiedPolicy: typeof intradayPolicyVersion | null = null
  if (phase === Phase.PostCutover) {
    if (unexpectedPositions.length > 0) failures.push('Positions outside the QQQ, SMH, XLK ETF allowlist remain.')
    if (policy !== null) {
      if (policy.observed === null) {
        failures.push('Deployed strategy behavior and parameter hashes are required to verify the policy.')
      } else {
        if (policy.observed.behaviorHash !== policy.expectedBehaviorHash) {
          failures.push('The deployed strategy behavior hash does not match --expected-policy-hash.')
        }
        if (policy.observed.parameterHash !== v3ParameterHash) {
          failures.push(`The deployed strategy parameters do not match ${intradayPolicyVersion}.`)
        } else if (policy.observed.behaviorHash === policy.expectedBehaviorHash) {
          verifiedPolicy = intradayPolicyVersion
        }
      }
    }
  }
  return evaluated(
    {
      accountStatus: binding.account.status,
      positionCount: positions.length,
      openOrderCount: openOrders.length,
      googlQuantities,
      googlOpenOrders,
      unexpectedPositions,
      verifiedPolicy,
    },
    failures,
  )
}

export const accountCollision = (intraday?: AccountIdentity, core?: AccountIdentity, canary?: AccountIdentity) => {
  if (intraday !== undefined && intraday.id === core?.id) return 'Accounts #1 and #2 share an Alpaca account ID.'
  if (intraday !== undefined && intraday.id === canary?.id) return 'Accounts #1 and #3 share an Alpaca account ID.'
  if (core !== undefined && core.id === canary?.id) return 'Accounts #2 and #3 share an Alpaca account ID.'
  return null
}

interface Sleeve extends AccountBinding<MacroAccount> {
  readonly endpoint: AlpacaEndpoint
  readonly positions: Positions
}

export const verifyMacro = (core: Sleeve, canary: Sleeve) => {
  const failures: string[] = []
  const warnings: string[] = []
  const inspect = (label: string, sleeve: Sleeve) => {
    const equity = Number(sleeve.account.equity)
    const buyingPower = Number(sleeve.account.buying_power)
    failures.push(...accountFailures(sleeve, label))
    if (!(equity > 0 && buyingPower > 0)) failures.push(`${label} must have positive equity and buying power.`)
    if (equity < 9_000 || equity > 15_000)
      warnings.push(`${label} equity is outside the expected $9,000–$15,000 range.`)
    return {
      accountStatus: sleeve.account.status,
      endpoint: sleeve.endpoint,
      equity,
      buyingPower,
      positionCount: sleeve.positions.length,
    }
  }
  return evaluated(
    { core: inspect('Account #2 (Macro Core)', core), canary: inspect('Account #3 (Macro Canary)', canary) },
    failures,
    warnings,
  )
}

export const postgresIdentityFailure = (role: string, standby: boolean, requireStandby: boolean): string | null => {
  if (role === 'bayn_app') return 'The bayn_app writer role is forbidden; use the read-only audit role.'
  if (requireStandby && !standby) return 'The PostgreSQL server is not a standby.'
  return null
}

export const cutoverReport = (
  phase: Phase,
  checks: {
    readonly intraday: ReturnType<typeof verifyIntraday>
    readonly macroAccounts: ReturnType<typeof verifyMacro>
    readonly postgres: Check<PostgresEvidence>
    readonly autoOntology: OntologyCheck
  },
) => ({
  phase,
  verdict: [checks.intraday, checks.macroAccounts, checks.postgres].some(({ status }) => status === CheckStatus.Fail)
    ? CheckStatus.Fail
    : CheckStatus.Pass,
  checks: {
    intraday: { ...checks.intraday, blocking: true },
    macroAccounts: { ...checks.macroAccounts, blocking: true },
    postgres: { ...checks.postgres, blocking: true },
    autoOntology: { ...checks.autoOntology, blocking: false },
  },
})

export type CutoverReport = ReturnType<typeof cutoverReport>

const problemText = ({ operation, kind, message, httpStatus }: ProbeProblem) =>
  `${operation}: ${message} (${kind}${httpStatus === undefined ? '' : `, HTTP ${httpStatus}`})`

const markdownCheck = <A>(label: string, check: Check<A>, describe: (evidence: A) => readonly string[]) => [
  `\n## ${label} — ${check.status} (blocking)`,
  ...('reason' in check
    ? [check.reason]
    : 'problems' in check
      ? check.problems.map(problemText)
      : [...describe(check.evidence), ...check.failures, ...check.warnings.map((warning) => `Warning: ${warning}`)]
  ).map((line) => `- ${line}`),
]

export const renderCutoverReport = (report: CutoverReport, format: Format): string => {
  if (format === Format.Json) return `${JSON.stringify(report, null, 2)}\n`
  const { intraday, macroAccounts, postgres, autoOntology } = report.checks
  return [
    `# Bayn Monday cutover: ${report.verdict}`,
    `\nPhase: \`${report.phase}\``,
    ...markdownCheck('Account #1 Intraday', intraday, (evidence) => [
      `Status: ${evidence.accountStatus}; positions: ${evidence.positionCount}; open orders: ${evidence.openOrderCount}`,
      `GOOGL position quantity: ${evidence.googlQuantities.join(', ') || 'flat'}; open GOOGL orders: ${evidence.googlOpenOrders}`,
      `Positions outside the post-cutover ETF allowlist: ${evidence.unexpectedPositions.join(', ') || 'none'}`,
      `Verified policy: ${evidence.verifiedPolicy ?? 'not verified'}`,
    ]),
    ...markdownCheck('Accounts #2 and #3 Macro Sleeves', macroAccounts, ({ core, canary }) =>
      (
        [
          ['#2 Macro Core', core],
          ['#3 Macro Canary', canary],
        ] as const
      ).map(
        ([label, evidence]) =>
          `${label}: ${evidence.accountStatus} / ${evidence.endpoint}; equity: $${evidence.equity}; buying power: $${evidence.buyingPower}; positions: ${evidence.positionCount}`,
      ),
    ),
    ...markdownCheck('PostgreSQL', postgres, ({ standby, latestObservation }) => [
      `Standby: ${standby ? 'yes' : 'no'}`,
      latestObservation === null
        ? 'Latest execution observation: none'
        : `Latest execution observation: ${latestObservation.timestamp} / ${latestObservation.result} / ${latestObservation.outcome ?? 'no outcome'}`,
    ]),
    `\n## Auto Ontology — ${autoOntology.status} (advisory)`,
    ...('reason' in autoOntology
      ? [`- ${autoOntology.reason}`]
      : autoOntology.problem === undefined
        ? []
        : [`- ${problemText(autoOntology.problem)}`]),
    '',
  ].join('\n')
}
