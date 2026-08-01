import {
  defaultProtocolDocument,
  frozenCandidateDevelopmentSessions,
  officialMonthEndSignalDates,
  openCandidateDevelopmentGitBatchObjectReader,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentSourceGit,
  type CandidateDevelopmentSourceManifest,
  type CandidateDevelopmentStrategyProtocol,
  type CandidateDevelopmentVerifiedSourceFiles,
} from '../test-api'
import { execFilePromise } from './process'
import { execFile } from '../test-runtime'

export const frozenSourcePreregistrationRevision = '0b0a951465e1c4644bc3fd04b7b448b8701dc609'
export const frozenSourcePreregistrationPath =
  'services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-preregistration.json'
export const frozenSourcePreregistrationBlobOid = '066a4d44cd41b871cad95474eb00e411af532c76'
export const frozenSourceModuleRepositoryPath =
  'services/bayn/src/strategy/cross-sectional-short-term-reversal/candidate-20.ts'
export const frozenSourceModuleSha256 = '15570022245f8bba1c121c6657369d66085d6c3659aa326b50048be1ab050441'
export const frozenSourceModuleBlobOid = '4'.repeat(40)
export const frozenSourceSourceManifestRepositoryPath =
  'services/bayn/candidates/ordinal-20-cross-sectional-short-term-reversal-source-manifest.json'
export const frozenSourceSourceManifestBlobOid = '5'.repeat(40)
export const frozenSourceSourceManifestSha256 = '6'.repeat(64)
export const frozenSourceMarketData = {
  schemaVersion: 'bayn.candidate-development-market-data-source.v1' as const,
  snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
  finalizedSnapshotContentHash: '8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d',
  inputManifestHash: 'b606cf57fb076f5bd2875206973e7c512817430d5cfbbeac8a99396f9983cab4',
  boundedContentHash: 'e0e7b283de187d8ccaf8a449dacc538f00049cfe446dcf153b558e92bf0e17ed',
}
export const frozenSourcePreregistrationDocument = {
  schemaVersion: 'bayn.candidate-development-next-preregistration.v1' as const,
  candidateOrdinal: 20,
  priorTrialCount: 19,
  strategyProtocolHash: '18b61d027e2235c7fc8ba718313ae8863650c2cb7c497dc4a7a5028829d19e0f',
  strategyIdentityHash: '8c99589120d8f3ed36c5286ce119d20490d42becd014e7fc2cc97b1420600278',
  candidateDevelopmentProtocolHash: 'f7d4d78e70401c01c141fc7b63c4c1cfe9e7350b973c40ffbd7d8fe9832b332f',
  calendarHash: '4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237',
  priorTrialsHash: 'dfda4c7706cdd7b2999a863ac63714c5d46894027442253f031b69bcdeaefde0',
  modulePath: frozenSourceModuleRepositoryPath,
  moduleSha256: frozenSourceModuleSha256,
  marketData: frozenSourceMarketData,
}
export const frozenSourcePreregistrationBytes = Buffer.from(
  `${JSON.stringify(frozenSourcePreregistrationDocument, null, 2)}\n`,
)
export const frozenSourceSourceManifest: CandidateDevelopmentSourceManifest = {
  schemaVersion: 'bayn.candidate-development-source-manifest.v1',
  candidateOrdinal: 20,
  priorTrialCount: 19,
  strategyProtocolHash: frozenSourcePreregistrationDocument.strategyProtocolHash,
  strategyIdentityHash: frozenSourcePreregistrationDocument.strategyIdentityHash,
  candidateDevelopmentProtocolHash: frozenSourcePreregistrationDocument.candidateDevelopmentProtocolHash,
  calendarHash: frozenSourcePreregistrationDocument.calendarHash,
  priorTrialsHash: frozenSourcePreregistrationDocument.priorTrialsHash,
  modulePath: frozenSourceModuleRepositoryPath,
  moduleSha256: frozenSourceModuleSha256,
  moduleFormat: 'self-contained-esm-v1',
  marketData: frozenSourceMarketData,
}
export const frozenSourceSourceManifestBytes = `${JSON.stringify(frozenSourceSourceManifest, null, 2)}\n`
export const frozenSourceOfficialSessions = frozenCandidateDevelopmentSessions()
export const frozenSourceInput: CandidateDevelopmentPreflightInput = {
  candidateOrdinal: 20,
  priorTrialCount: 19,
  expectedStrategyProtocolHash: frozenSourcePreregistrationDocument.strategyProtocolHash,
  officialSessions: frozenSourceOfficialSessions,
  signalSessionDates: officialMonthEndSignalDates(frozenSourceOfficialSessions),
  featureLookbackSessions: 21,
}
export const frozenSourceStrategyProtocol: CandidateDevelopmentStrategyProtocol = {
  schemaVersion: 'bayn.candidate-development-strategy-protocol.v2',
  universe: ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'],
  directVolatilityTarget: 0.1,
  initialCapitalMicros: '1000000000000',
  executionModel: defaultProtocolDocument.executionModel,
  thresholds: {
    minimumObservations: 504,
    minimumAnnualizedReturn: 0,
    minimumSharpeImprovement: 0,
    maximumDrawdown: 0.35,
    maximumAnnualTurnover: 12,
    requirePositiveDoubleCostReturn: true,
  },
  marketData: {
    schemaVersion: 'bayn.candidate-development-market-data-contract.v1',
    snapshotId: frozenSourceMarketData.snapshotId,
    contentHash: frozenSourceMarketData.boundedContentHash,
  },
  benchmarks: {
    schemaVersion: 'bayn.candidate-development-benchmark-policy.v1',
    symbol: 'SPY',
    directVolatilityWindow: 63,
    terminalPolicy: 'last-all-cash-strategy-decision',
  },
  strategyIdentity: {
    schemaVersion: 'bayn.candidate-development-strategy-identity.v2',
    family: 'inverse-volatility-risk-diversification',
    identifier: 'candidate-20-cross-sectional-short-term-reversal-21-session-etf-losers',
    researchSources: [
      'https://doi.org/10.1111/j.1540-6261.1990.tb05110.x',
      'https://doi.org/10.2307/2937816',
      'https://doi.org/10.1093/rfs/3.2.175',
    ],
    parameters: {
      id: 'cross-sectional-short-term-reversal-21-two-losers-half-weight-cash',
      lookbackSessions: 21,
      annualizationSessions: 252,
      riskAssets: ['DBC', 'SPY'],
      covarianceEstimator: 'sample',
      targetAnnualizedVolatility: 0.1,
      maximumGrossExposure: 1,
    },
    input: '22-adjusted-closes-ending-at-each-finalized-month-end-for-dbc-efa-ief-spy-vnq',
    weighting:
      'rank-all-five-etfs-by-ascending-21-session-return-select-at-most-two-strictly-negative-losers-at-fixed-half-weight',
    riskScaling:
      'none-covariance-and-target-volatility-fields-are-v2-schema-compatibility-metadata-and-do-not-affect-strategy-weights',
    allocation: 'long-only-up-to-two-assets-with-unallocated-capital-held-as-cash-no-leverage-no-shorting',
    schedule: 'official-month-end-finalized-close-to-next-session-open',
    terminal: '2022-11-30-signal-liquidates-at-2022-12-01-open-and-remains-cash',
    missingData: 'fail-closed-no-imputation-and-no-nonfinite-return-or-volatility',
    doubledCost: 'fixed-baseline-signal-and-ordered-requested-filled-quantity-path-repriced-at-two-times-cost',
  },
}
export const frozenSourceStructuralBindings = {
  schemaVersion: 'bayn.candidate-development-artifact-structural-bindings.v1' as const,
  candidateOrdinal: 20,
  priorTrialCount: 19,
  strategyProtocolHash: frozenSourcePreregistrationDocument.strategyProtocolHash,
  strategyIdentityHash: frozenSourcePreregistrationDocument.strategyIdentityHash,
  candidateDevelopmentProtocolHash: frozenSourcePreregistrationDocument.candidateDevelopmentProtocolHash,
  calendarHash: frozenSourcePreregistrationDocument.calendarHash,
  priorTrialsHash: frozenSourcePreregistrationDocument.priorTrialsHash,
  modulePath: frozenSourceModuleRepositoryPath,
  sourceManifestPath: frozenSourceSourceManifestRepositoryPath,
}

export const frozenSourceVerifiedSourceFiles: CandidateDevelopmentVerifiedSourceFiles = {
  schemaVersion: 'bayn.candidate-development-verified-source-files.v1',
  sourceRevision: '2'.repeat(40),
  modulePath: frozenSourceModuleRepositoryPath,
  moduleBlobOid: frozenSourceModuleBlobOid,
  moduleSha256: frozenSourceModuleSha256,
  sourceManifestPath: frozenSourceSourceManifestRepositoryPath,
  sourceManifestBlobOid: frozenSourceSourceManifestBlobOid,
  sourceManifestSha256: frozenSourceSourceManifestSha256,
  sourceManifest: frozenSourceSourceManifest,
}

export const frozenSourceVirtualPreregistrationTreeOid = '0'.repeat(40)
export const frozenSourceVirtualPreregistrationCommit = Buffer.from(
  `tree ${frozenSourceVirtualPreregistrationTreeOid}\n\nfrozen source preregistration fixture\n`,
)

export const candidateTestGitEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))

export const candidateTestGitText = (
  repositoryRoot: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryRoot, ...args],
      {
        encoding: 'utf8',
        env: candidateTestGitEnvironment(),
        maxBuffer: 16 * 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        if (error === null) resolveGit(stdout.trim())
        else rejectGit(error)
      },
    )
  })

export const candidateTestGitBytes = (
  repositoryRoot: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<Buffer> =>
  new Promise((resolveGit, rejectGit) => {
    execFile(
      'git',
      ['--no-replace-objects', '-C', repositoryRoot, ...args],
      {
        encoding: 'buffer',
        env: candidateTestGitEnvironment(),
        maxBuffer: 64 * 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        if (error === null) resolveGit(stdout)
        else rejectGit(error)
      },
    )
  })

export const candidateTestSourceGit: CandidateDevelopmentSourceGit = {
  text: candidateTestGitText,
  bytes: candidateTestGitBytes,
  openObjectReader: openCandidateDevelopmentGitBatchObjectReader,
}

export const bindCandidate19VirtualPreregistrationParent = (content: Buffer): Buffer => {
  const encoded = content.toString('utf8')
  const separator = encoded.indexOf('\n\n')
  if (separator < 0) throw new Error('candidate test commit is missing its message separator')
  const headers = encoded
    .slice(0, separator)
    .split('\n')
    .filter((line) => !line.startsWith('parent '))
  const [tree, ...remainingHeaders] = headers
  if (tree === undefined || !tree.startsWith('tree ')) throw new Error('candidate test commit is missing its tree')
  return Buffer.from(
    [tree, `parent ${frozenSourcePreregistrationRevision}`, ...remainingHeaders, '', encoded.slice(separator + 2)].join(
      '\n',
    ),
  )
}

export const frozenSourceVirtualPreregistrationSourceGit = (
  base: CandidateDevelopmentSourceGit = candidateTestSourceGit,
): CandidateDevelopmentSourceGit => {
  let capturedSourceRevision: string | undefined
  const preregistrationSpec = `${frozenSourcePreregistrationRevision}:${frozenSourcePreregistrationPath}`
  return {
    text: async (repositoryRoot, args, signal) => {
      if (args[0] === 'rev-parse' && args[1] === preregistrationSpec) return frozenSourcePreregistrationBlobOid
      const output = await base.text(repositoryRoot, args, signal)
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') capturedSourceRevision = output
      return output
    },
    bytes: (repositoryRoot, args, signal) =>
      args[0] === 'cat-file' && args[1] === 'blob' && args[2] === preregistrationSpec
        ? Promise.resolve(frozenSourcePreregistrationBytes)
        : base.bytes(repositoryRoot, args, signal),
    openObjectReader: async (repositoryRoot, signal) => {
      const delegate = await (base.openObjectReader ?? openCandidateDevelopmentGitBatchObjectReader)(
        repositoryRoot,
        signal,
      )
      return {
        read: async (oid, expectedType) => {
          if (oid === frozenSourcePreregistrationRevision && expectedType === 'commit') {
            return frozenSourceVirtualPreregistrationCommit
          }
          if (oid === frozenSourceVirtualPreregistrationTreeOid && expectedType === 'tree') return Buffer.alloc(0)
          const content = await delegate.read(oid, expectedType)
          return oid === capturedSourceRevision && expectedType === 'commit'
            ? bindCandidate19VirtualPreregistrationParent(content)
            : content
        },
        close: () => delegate.close(),
      }
    },
  }
}

export const initializeFrozenSourceDescendantRepository = async (repository: string): Promise<void> => {
  await execFilePromise('git', ['init', '-q'], repository)
  await execFilePromise('git', ['config', 'user.name', 'Candidate Test'], repository)
  await execFilePromise('git', ['config', 'user.email', 'candidate@example.test'], repository)
}
