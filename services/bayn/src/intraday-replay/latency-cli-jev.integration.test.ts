import { JevResearchPolicy } from '../jev/acceptance'
import { latencyCliAcceptance } from './latency-cli-acceptance.test-support'

latencyCliAcceptance(JevResearchPolicy.Candidate, false)
