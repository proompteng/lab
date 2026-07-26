import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'

import { qualificationCandidateMain } from './qualification-candidate/program'

if (import.meta.main) {
  NodeRuntime.runMain(qualificationCandidateMain.pipe(Effect.provide(NodeServices.layer)))
}
