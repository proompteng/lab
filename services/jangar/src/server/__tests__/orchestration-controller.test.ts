import { describe, expect, it } from 'vitest'

import * as agentsOrchestrationController from '@proompteng/agents/server/orchestration-controller'

import * as jangarOrchestrationController from '../orchestration-controller'

describe('Jangar orchestration controller compatibility exports', () => {
  it('delegates runtime ownership to the Agents service package', () => {
    expect(jangarOrchestrationController.startOrchestrationController).toBe(
      agentsOrchestrationController.startOrchestrationController,
    )
    expect(jangarOrchestrationController.stopOrchestrationController).toBe(
      agentsOrchestrationController.stopOrchestrationController,
    )
    expect(jangarOrchestrationController.getOrchestrationControllerHealth).toBe(
      agentsOrchestrationController.getOrchestrationControllerHealth,
    )
  })
})
