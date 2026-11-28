import { createHash } from 'node:crypto'

/** The orchestration protocol identity is independent of each physical worker revision. */
export const executionControllerPlanHash = createHash('sha256')
  .update('bayn.execution-controller-plan.v4.streaming')
  .digest('hex')
