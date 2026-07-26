import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import { qualificationCandidateMain } from './qualification-candidate/program'

if (import.meta.main) {
  NodeRuntime.runMain(
    qualificationCandidateMain.pipe(Effect.provide(Layer.merge(NodeServices.layer, Reactivity.layer))),
  )
}
