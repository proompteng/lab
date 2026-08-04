import { Schema } from 'effect'

import {
  candidate20PrecommitInvalidation,
  candidate17Preregistration,
  candidate18Preregistration,
  candidate19Preregistration,
} from './frozen-lineage'
import {
  CandidateDevelopmentLocalSourceManifestBindingSchema,
  CandidateDevelopmentLocalTerminalReportSchema,
} from '../candidate-development-local/domain'
import {
  CandidateDevelopmentNextPreregistrationSchema,
  type CandidateDevelopmentInvalidPrecommit,
  type CandidateDevelopmentNextPreregistration,
} from './model'
import {
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  strictParseOptions,
} from '../schemas'
import type { StrategyApplication } from '../strategy'

const TrialLedgerEntrySchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('QUALIFICATION_TERMINAL'),
    candidateOrdinal: PositiveIntegerSchema,
    priorTrialCount: NonNegativeIntegerSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal('DEVELOPMENT_REJECTED'),
    candidateOrdinal: PositiveIntegerSchema,
    priorTrialCount: NonNegativeIntegerSchema,
    sourceRevision: Schema.String,
    terminalReportHash: Schema.optionalKey(Sha256Schema),
    terminalReport: Schema.optionalKey(CandidateDevelopmentLocalTerminalReportSchema),
  }),
  Schema.Struct({
    _tag: Schema.Literal('DEVELOPMENT_APPROVED'),
    candidateOrdinal: PositiveIntegerSchema,
    priorTrialCount: NonNegativeIntegerSchema,
    sourceRevision: Schema.String,
    terminalReportHash: Sha256Schema,
    terminalReport: CandidateDevelopmentLocalTerminalReportSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal('PRECOMMIT_INVALID'),
    candidateOrdinal: Schema.Literal(20),
    priorTrialCount: Schema.Literal(19),
    attemptStatus: Schema.Literal('UNATTEMPTED'),
    metricBearingAttemptsConsumed: Schema.Literal(0),
    qualificationAttemptConsumed: Schema.Literal(false),
  }),
  Schema.Struct({
    _tag: Schema.Literal('DEVELOPMENT_PENDING'),
    candidateOrdinal: PositiveIntegerSchema,
    priorTrialCount: NonNegativeIntegerSchema,
    strategyName: StrictNonEmptyStringSchema,
    preregistration: CandidateDevelopmentNextPreregistrationSchema,
    sourceManifest: CandidateDevelopmentLocalSourceManifestBindingSchema,
  }),
])

const TrialLedgerSchema = Schema.Array(TrialLedgerEntrySchema)

export const CandidateDevelopmentTrialLedgerSchema = TrialLedgerSchema

export type CandidateDevelopmentTrialLedgerEntry = typeof TrialLedgerEntrySchema.Type

interface RejectedTrialReceipt {
  readonly candidateOrdinal: number
  readonly strategyName: string
  readonly strategyProtocolHash: string
  readonly candidateDevelopmentProtocolHash: string
  readonly priorTrialsHash: string
  readonly moduleSha256: string
  readonly preregistrationSourceRevision: string
  readonly preregistrationPath: string
  readonly preregistrationBlobOid: string
  readonly sourceManifestBlobOid: string
  readonly sourceManifestSha256: string
  readonly sourceRevision: string
  readonly moduleBlobOid: string
  readonly terminalReportHash: string
  readonly bindingHash: string
  readonly evaluationHash: string
  readonly targetHash: string
  readonly qualificationAnalysisHash: string
}

const frozenDevelopmentMarketData = {
  schemaVersion: 'bayn.candidate-development-market-data-source.v1' as const,
  snapshotId: '2a91f0177684f7022f746207333e510c8268f9b77a04b778a04220a33ccf79e0',
  finalizedSnapshotContentHash: '8e376546f6a6cc1dbe2e910db3d68f584fc0bd9c4858166042ce32aa077eed0d',
  inputManifestHash: '1e5377336f2e6feb751000114b81cc89aee5be7542e213c320f2cfbb4185bb2b',
  boundedContentHash: 'b6052c8ebdca855973adf4e41efafb5028fd8dbbaa70809331f6017519b1c995',
}

const rejectedTrialEntries = (
  receipt: RejectedTrialReceipt,
): readonly [CandidateDevelopmentTrialLedgerEntry, CandidateDevelopmentTrialLedgerEntry] => {
  const priorTrialCount = receipt.candidateOrdinal - 1
  const modulePath = `services/bayn/src/strategy/candidate-${receipt.candidateOrdinal}.ts`
  const sourceManifestPath = `services/bayn/candidates/ordinal-${receipt.candidateOrdinal}-source-manifest.json`
  const sourceManifest = {
    path: sourceManifestPath,
    blobOid: receipt.sourceManifestBlobOid,
    sha256: receipt.sourceManifestSha256,
  }

  return [
    {
      _tag: 'DEVELOPMENT_PENDING',
      candidateOrdinal: receipt.candidateOrdinal,
      priorTrialCount,
      strategyName: receipt.strategyName,
      preregistration: {
        schemaVersion: 'bayn.candidate-development-next-preregistration.v1',
        candidateOrdinal: receipt.candidateOrdinal,
        priorTrialCount,
        strategyProtocolHash: receipt.strategyProtocolHash,
        candidateDevelopmentProtocolHash: receipt.candidateDevelopmentProtocolHash,
        calendarHash: '4b2f519f336e4e730c1f0d69e860f25a8d4d0cfbd8e93c6b333ea83623d87237',
        priorTrialsHash: receipt.priorTrialsHash,
        modulePath,
        moduleSha256: receipt.moduleSha256,
        marketData: frozenDevelopmentMarketData,
        preregistration: {
          sourceRevision: receipt.preregistrationSourceRevision,
          path: receipt.preregistrationPath,
          blobOid: receipt.preregistrationBlobOid,
        },
      },
      sourceManifest,
    },
    {
      _tag: 'DEVELOPMENT_REJECTED',
      candidateOrdinal: receipt.candidateOrdinal,
      priorTrialCount,
      sourceRevision: receipt.sourceRevision,
      terminalReportHash: receipt.terminalReportHash,
      terminalReport: {
        schemaVersion: 'bayn.candidate-development-local-terminal.v1',
        source: {
          candidateOrdinal: receipt.candidateOrdinal,
          priorTrialCount,
          trialHistoryHash: receipt.priorTrialsHash,
          strategyName: receipt.strategyName,
          strategyProtocolHash: receipt.strategyProtocolHash,
          snapshotId: frozenDevelopmentMarketData.snapshotId,
          inputManifestHash: frozenDevelopmentMarketData.inputManifestHash,
          boundedContentHash: frozenDevelopmentMarketData.boundedContentHash,
          sourceRevision: receipt.sourceRevision,
          modulePath,
          moduleBlobOid: receipt.moduleBlobOid,
          moduleSha256: receipt.moduleSha256,
          sourceManifestPath,
          sourceManifestBlobOid: receipt.sourceManifestBlobOid,
          sourceManifestSha256: receipt.sourceManifestSha256,
          bindingHash: receipt.bindingHash,
        },
        status: 'HOLD_REJECT',
        evaluationHash: receipt.evaluationHash,
        targetHash: receipt.targetHash,
        qualificationAnalysisHash: receipt.qualificationAnalysisHash,
      },
    },
  ]
}

const historicalLedger = [
  ...Array.from({ length: 16 }, (_, index) => ({
    _tag: 'QUALIFICATION_TERMINAL' as const,
    candidateOrdinal: index + 1,
    priorTrialCount: index,
  })),
  {
    _tag: 'DEVELOPMENT_REJECTED' as const,
    candidateOrdinal: 17,
    priorTrialCount: 16,
    sourceRevision: candidate17Preregistration.preregistration.sourceRevision,
  },
  {
    _tag: 'DEVELOPMENT_REJECTED' as const,
    candidateOrdinal: 18,
    priorTrialCount: 17,
    sourceRevision: candidate18Preregistration.preregistration.sourceRevision,
  },
  {
    _tag: 'DEVELOPMENT_REJECTED' as const,
    candidateOrdinal: 19,
    priorTrialCount: 18,
    sourceRevision: candidate19Preregistration.preregistration.sourceRevision,
  },
  {
    _tag: 'PRECOMMIT_INVALID' as const,
    candidateOrdinal: 20 as const,
    priorTrialCount: 19 as const,
    attemptStatus: 'UNATTEMPTED' as const,
    metricBearingAttemptsConsumed: 0 as const,
    qualificationAttemptConsumed: false as const,
  },
  ...rejectedTrialEntries({
    candidateOrdinal: 21,
    strategyName: 'candidate-21-six-month-rotation',
    strategyProtocolHash: 'fd0a271c22691770246e16ca5aa38ba5b9c546d4070ae5382e8a79f40d5c2bd5',
    candidateDevelopmentProtocolHash: '05c4f3247252d4c3d724593b5c2f654c5b9a11974f865f5d68dac44a792b1b61',
    priorTrialsHash: '295eff4120c4d3deb33e09e3948bc5a670b55a836dc6be6849b2eea979e60008',
    moduleSha256: 'e77081c2c6904a67b293334b6e051d76dd634974ec0055dd099e5c4d84985b06',
    preregistrationSourceRevision: 'f9c90e5158212d862ca4b64cf9624fe424f09ba6',
    preregistrationPath: 'services/bayn/candidates/ordinal-21-six-month-rotation-preregistration.json',
    preregistrationBlobOid: 'f61534e914c854aec0c19c28cfd24490e59f36c7',
    sourceManifestBlobOid: '623a59e183a6700fbde8600629f87ea2b14b59fd',
    sourceManifestSha256: '0613547be32377af4431b87476b7cee15af107f7860fbc5cff346763c5b9150c',
    sourceRevision: 'd98164a2df566c6181fb6ea9580b6273f68c57e7',
    moduleBlobOid: '8e60e66363b06ea20b0dbb7c90996379250907d7',
    terminalReportHash: '66b3d91ecf84d85cf95b12f200b83aa21b9d1d84ea1dd94c8c70d238527cff01',
    bindingHash: '13b33dcea0c9d0d59c3322fe83855c56f6bdf1abeb0365e48843f120d21d87cf',
    evaluationHash: '59523519ec4815f47970927ed38aa29785a4a8fb8ddec300748e629eea96fe12',
    targetHash: 'b89e6f19f883c93126218de50a218a0aa8b5ca588dd55324bcd4831c191b2fea',
    qualificationAnalysisHash: '4a47fa4c5a77ecf162427cba22d101f6f1b0e482c5ca222f58cc6fdeb93f3852',
  }),
  ...rejectedTrialEntries({
    candidateOrdinal: 22,
    strategyName: 'candidate-22-low-dispersion-momentum-tilt',
    strategyProtocolHash: '7439fb7aa6838f77fd936b3332851981bb8c1c8a713653107a8baa43e6eb53ab',
    candidateDevelopmentProtocolHash: '0fbd4067a7421ff8f575dc876e94fae2893457b8a33add847f5e26dfde8091a9',
    priorTrialsHash: 'd0ea5dc985522a99ce93f530218d52a42eb846bea73b5c2a56640bfd2d59ff96',
    moduleSha256: '938a2f83f11c81f10325365f4b0456097c7038eee84e3fc08687f1d4d08d7177',
    preregistrationSourceRevision: 'eaa0f5d9b1a9ba72d1c4eda705187013c290a40a',
    preregistrationPath: 'services/bayn/candidates/ordinal-22-low-dispersion-momentum-tilt-preregistration.json',
    preregistrationBlobOid: 'b5833a1ef8ccb27a20c8b434881f90c75cc953fb',
    sourceManifestBlobOid: '19f1104b1bb508027175409a3dbedab77fcc0a32',
    sourceManifestSha256: '7ec1c6b5dd9147f4a810cfa2353e5607ddc39d6b4ffb0bdb3354af1af1ddb11c',
    sourceRevision: '85677b0f4b8396bceba7bf33d6d2fca4e81c6d0c',
    moduleBlobOid: '98f632c5b6ac5022221089a8646387008456c316',
    terminalReportHash: '56d845e58845106a54569278eb5c265437dbe288ac93a1d97de2dc886169af24',
    bindingHash: '82326feb8cbb26a854b6ea0cb922ec5e199713562057079fdbf2bdcc3e851654',
    evaluationHash: 'bd98ee2294dd48caecf682419e0b094f92cac1972be7af7aff8363a60188fa00',
    targetHash: 'e9e46ab3cecfaa95cd88cb65a83a571edfbc05909b9940057e2bea5277f78acf',
    qualificationAnalysisHash: 'fdb003763930de38e74d0c3ab00d9fa6480ad35a973b8ca884fd8987750e7533',
  }),
  ...rejectedTrialEntries({
    candidateOrdinal: 23,
    strategyName: 'candidate-23-long-horizon-trend-consensus',
    strategyProtocolHash: '4c872d202736df67a1884165ff7dcff5d4c0786661acbb1c52f1da4d954e7c71',
    candidateDevelopmentProtocolHash: '67df3759bf447907a8252563e3b6e4b5cfec1b6b75d34e235857581377b81099',
    priorTrialsHash: '3f274a01dfc943d6648044eb9530dce3a0dc5d31b9b55ff5271c671f5639821e',
    moduleSha256: '94f3a5d098cbfab2cf6dd2cc5282be352a9b283d1117c674817921019a708197',
    preregistrationSourceRevision: '3aeb2b6567c7d09cc4b79deffcac952e4b020357',
    preregistrationPath: 'services/bayn/candidates/ordinal-23-long-horizon-trend-consensus-preregistration.json',
    preregistrationBlobOid: '6288eaa3ce74daff10ec5a7374c54666f02b163d',
    sourceManifestBlobOid: '918abb4e5d66bc069267de999f103c280d11d321',
    sourceManifestSha256: '571cef9990c7e28ba24327b428df0f4c98af71bb882d10281b1a624cdf5aeb7b',
    sourceRevision: '8c57049a24f59e694c2633754f0ccaa90a3d0d7f',
    moduleBlobOid: '7cc023405cd9995713418e8413ac82bbf8adaad8',
    terminalReportHash: '232a7554bbc4b46c0db4c5045900220379abeb74cb1f376ced6ae526d838f739',
    bindingHash: 'c14806eca01e02645d18a98b5ffb1668ac7839f8049f702ad0ae23fcb7e57c8f',
    evaluationHash: 'c407ff956f50dac3a6dfc015d1038d7cae43314c05c14daf8759ac3b3a6a97a1',
    targetHash: 'd31e47331c02e93ae4f36aec8958ec1b3337116c2ac9669343c139935f3c71d5',
    qualificationAnalysisHash: '9bc11fc3026a938f4109c96298050a713b7ad14379c76181f12835cccda65784',
  }),
  ...rejectedTrialEntries({
    candidateOrdinal: 24,
    strategyName: 'candidate-24-twelve-month-time-series-momentum',
    strategyProtocolHash: 'e5984cde401715e654a61b268bf3c70ebf600b9e303efb348c0e6c3d9eacd7c1',
    candidateDevelopmentProtocolHash: '3336e3e5dcd0251bf3bbdc468ed7a9179d4890c055f3e636ec2b16bc4ad87829',
    priorTrialsHash: '1e34949870418ab15c4120e9a45de1d41d0ed4a07fdbcc31d4a22cd22e5f42b3',
    moduleSha256: 'dc9132bc2332f1878dd7f698f426f875d6370c354da38d38055c5ea32849d24c',
    preregistrationSourceRevision: 'f7529b676225bcdd8f084feed81efffd99a745ef',
    preregistrationPath: 'services/bayn/candidates/ordinal-24-twelve-month-time-series-momentum-preregistration.json',
    preregistrationBlobOid: '3ad2152e4cebc48c85c82c4ecaeed45458460f63',
    sourceManifestBlobOid: '877de3583c2e8998ad265a5e6a11b540b37895f5',
    sourceManifestSha256: 'af366df1ec0633232ab4ca798ec68cfbe4485368a6624cb4a7379eca18e34ec0',
    sourceRevision: '6360d43da2038ed5f8697b1a64b92d9078f9691b',
    moduleBlobOid: '49ed4c71d1c9f92fe1789f69d056cee8d0f8c296',
    terminalReportHash: '79ebe94383b18aa7a896b724b3c8f29247fc23d73c32e90b780bb2e37da95d41',
    bindingHash: '87f0bde9788d426f53ccbcb777d0c46b5b75cea6cf3037d7b1e0444dcbbc8d49',
    evaluationHash: '354a9b9b7c5bbf2f9b4178c932ab47c36d22d5b78b28af6ed483333181ef5ef5',
    targetHash: '2ff28a5b3772d6861995de738f4800f03458e78edc6c15dfa9e00721b88763ae',
    qualificationAnalysisHash: 'eb73fe8520833eac7b06a138d4d496ea07a36fb4ae6140399709d047dee69d6d',
  }),
  ...rejectedTrialEntries({
    candidateOrdinal: 25,
    strategyName: 'candidate-25-top-two-momentum-consensus',
    strategyProtocolHash: 'b38c8a135a34e571470e28f16e2f0f75a8dbaefee25d276c7afae39f2793b136',
    candidateDevelopmentProtocolHash: 'f0a34cd42a6d4657890a7164d9ffc2242822333539eb80465f570ba82766c9ad',
    priorTrialsHash: '8f9082e34c6d48d8496e79e53d0209f24112bdb950b6ebb11d3d39063b47ff14',
    moduleSha256: 'bb70b8e8851a3fb390dd5c0b51876122d05a08401b4ad42ac831d5c616e39835',
    preregistrationSourceRevision: '9dff32d40405c9149ca0e5e72cc918011765f09d',
    preregistrationPath: 'services/bayn/candidates/ordinal-25-top-two-momentum-consensus-preregistration.json',
    preregistrationBlobOid: '83667dda9a986510a33ac9508dce0da386be5620',
    sourceManifestBlobOid: '5cb836429e8a019317ecb7302969b23aaec4587c',
    sourceManifestSha256: '39bc07487cea9a00190a133ff5faa3b240b04c1a7083041eaa791006106dd79b',
    sourceRevision: 'aad1803306ddb6b8ee61fbbcd0e40a25b4143c8b',
    moduleBlobOid: '4953248b045f9f85fb0441dbe0b0d5b14da3558a',
    terminalReportHash: 'c26b1ed91e9467f7dc3c2018f9a96f7b3672c291cf427ceaaf8da4a18050eaee',
    bindingHash: 'dc8e691bf2cd9efbf6e64b57dc385f4fe6a69c909d84d91d29ef02da06f1a564',
    evaluationHash: 'ac07f6d7f55f2fd6258e99d30b00aee679513a4e2b59afcbd5e3a37920a8c4a7',
    targetHash: 'abdb35449efae707768c9a010cf0e62f5e9ade9572b4ec0151a982a10005596a',
    qualificationAnalysisHash: '9019a1dfd764518f9b4543c2920511cb91398c45d7109f5bccaae4b18e43804c',
  }),
] as const

/** One append-only source-controlled ledger. Candidate 20 is represented once as the terminal tombstone entry. */
export const candidateDevelopmentTrialLedger: readonly CandidateDevelopmentTrialLedgerEntry[] = Object.freeze(
  Schema.decodeUnknownSync(TrialLedgerSchema, strictParseOptions)(historicalLedger),
)

export interface ActiveCandidateDevelopmentRegistration {
  readonly preregistration: CandidateDevelopmentNextPreregistration
  readonly strategyName?: string
  /** The exact reviewed source-manifest object consumed by both local development and qualification. */
  readonly sourceManifest: typeof CandidateDevelopmentLocalSourceManifestBindingSchema.Type
  /** Compatibility projection for archived fixtures; production adapters load the registered module export. */
  readonly application?: StrategyApplication<any, any, any>
}

const activeRegistrationFromLedger = (
  entries: readonly CandidateDevelopmentTrialLedgerEntry[],
): ActiveCandidateDevelopmentRegistration | null => {
  const pending = [...entries].reverse().find((entry) => entry._tag === 'DEVELOPMENT_PENDING')
  if (pending === undefined) return null
  const latest = entries.at(-1)
  if (
    latest !== undefined &&
    latest.candidateOrdinal === pending.candidateOrdinal &&
    (latest._tag === 'DEVELOPMENT_REJECTED' || latest._tag === 'QUALIFICATION_TERMINAL')
  ) {
    return null
  }
  return Object.freeze({
    preregistration: pending.preregistration,
    strategyName: pending.strategyName,
    sourceManifest: pending.sourceManifest,
  })
}

/** The active registration is derived from one append-only pending entry; its application is the module export. */
export const activeCandidateDevelopmentRegistration = activeRegistrationFromLedger(candidateDevelopmentTrialLedger)

export interface CandidateDevelopmentTrialLedgerState {
  readonly entries: readonly CandidateDevelopmentTrialLedgerEntry[]
  readonly completedCandidateOrdinals: readonly number[]
  readonly developmentCandidateOrdinals: readonly number[]
  readonly latestInvalidPrecommit: CandidateDevelopmentInvalidPrecommit | null
  readonly activeCandidate: ActiveCandidateDevelopmentRegistration | null
}

export const deriveCandidateDevelopmentTrialLedgerState = (): CandidateDevelopmentTrialLedgerState => ({
  entries: candidateDevelopmentTrialLedger,
  completedCandidateOrdinals: candidateDevelopmentTrialLedger
    .filter((entry) => entry._tag === 'QUALIFICATION_TERMINAL')
    .map((entry) => entry.candidateOrdinal),
  developmentCandidateOrdinals: candidateDevelopmentTrialLedger
    .filter((entry) => entry._tag === 'DEVELOPMENT_REJECTED' || entry._tag === 'DEVELOPMENT_APPROVED')
    .map((entry) => entry.candidateOrdinal),
  latestInvalidPrecommit: candidateDevelopmentTrialLedger.some((entry) => entry._tag === 'PRECOMMIT_INVALID')
    ? candidate20PrecommitInvalidation
    : null,
  activeCandidate: activeCandidateDevelopmentRegistration,
})

export const candidateDevelopmentTrialLedgerState = deriveCandidateDevelopmentTrialLedgerState()
