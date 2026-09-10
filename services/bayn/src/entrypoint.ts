import { Effect } from 'effect'

import { loadApplicationPlan } from './application-plan'
import { runApplicationPlan } from './composition'

export { loadApplicationPlan }
export { runApplicationPlan } from './composition'
export const program = loadApplicationPlan.pipe(Effect.flatMap(runApplicationPlan), Effect.scoped)
