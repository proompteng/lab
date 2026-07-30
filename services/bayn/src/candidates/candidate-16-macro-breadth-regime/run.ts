import { NodeRuntime } from '@effect/platform-node'

import { runCandidateDevelopmentCommand } from '../../candidate-development-command'
import { candidateDevelopmentProgram } from './program'

NodeRuntime.runMain(runCandidateDevelopmentCommand(candidateDevelopmentProgram))
