export {
  PaperCandidateIneligibility,
  type PaperCandidateDiscoveryBinding,
  type PaperCandidateDiscoveryIdentity,
  type PaperCandidateDiscoveryReceipt,
  type PaperCandidateDiscoverySnapshot,
  type PaperCandidateFactsMaterial,
} from './paper-candidate-discovery/model'
export {
  renderPaperCandidateDiscoveryError,
  type PaperCandidateDiscoveryError,
} from './paper-candidate-discovery/failure'
export { validatePaperCandidateDiscoverySnapshot } from './paper-candidate-discovery/snapshot-validation'
export { validatePaperCandidateDiscoveryObservations } from './paper-candidate-discovery/broker-observation-validation'
export { discoverPaperCandidates } from './paper-candidate-discovery/program'
export {
  makeCandidateDiscovery,
  type CandidateDiscovery,
  type CandidateDiscoveryDependencies,
} from './paper-candidate-discovery/interpreter'
