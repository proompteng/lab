import { describe, expect, it } from 'vitest'

import * as agentsPrimitivesReconciler from '@proompteng/agents/server/primitives-reconciler'

import * as jangarPrimitivesReconciler from '../primitives-reconciler'

describe('Jangar primitives reconciler compatibility exports', () => {
  it('delegates runtime ownership to the Agents service package', () => {
    expect(jangarPrimitivesReconciler.startPrimitivesReconciler).toBe(
      agentsPrimitivesReconciler.startPrimitivesReconciler,
    )
    expect(jangarPrimitivesReconciler.stopPrimitivesReconciler).toBe(
      agentsPrimitivesReconciler.stopPrimitivesReconciler,
    )
    expect(jangarPrimitivesReconciler.getPrimitivesReconcilerHealth).toBe(
      agentsPrimitivesReconciler.getPrimitivesReconcilerHealth,
    )
  })
})
