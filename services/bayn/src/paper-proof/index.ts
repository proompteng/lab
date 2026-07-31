export { validatePaperProofEntry } from './gates'
export {
  decodePaperProofCliEnvelopeResult,
  decodePaperProofCommandResult,
  PaperProofCliEnvelopeSchema,
  PaperProofCommandSchema,
  PaperProofError,
  PaperProofOperationSchema,
  paperProofCommandSchemaVersion,
  paperProofReceiptSchemaVersion,
  protectedEntryToken,
  proofBinding,
  type PaperProofCliEnvelope,
  type PaperProofCommand,
  type PaperProofOperation,
  type PaperProofReceipt,
  type PaperProofReconciliation,
  type PaperProofRuntimeBinding,
  type PaperProofSourcePlan,
  type PreparedPaperProofIntent,
} from './model'
export { runPaperProof, type PaperProofDependencies } from './program'
export {
  makePaperProofRecoveryStore,
  PaperProofRecoveryStore,
  PaperProofRecoveryStoreError,
  PaperProofRecoveryStoreLive,
  type PaperProofRecoveryRequired,
  type PaperProofRecoveryResolution,
  type PaperProofRecoveryStoreService,
} from './recovery-store'
