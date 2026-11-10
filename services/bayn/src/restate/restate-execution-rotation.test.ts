import { expect, test } from 'bun:test'
import type { ObjectContext } from '@restatedev/restate-sdk'
import { Result } from 'effect'

import {
  decideExecutionControllerRotation,
  type ExecutionControllerRotation,
  type ExecutionControllerState,
} from '../execution/controller'
import { executionActivationAuthorizationHash, makeBaynExecutionController } from './restate-execution-controller'

const controllerKey = 'a'.repeat(64)
const planHash = 'b'.repeat(64)
const previousSource = 'c'.repeat(40)
const sourceRevision = 'd'.repeat(40)
const original: ExecutionControllerState = {
  schemaVersion: 1,
  active: true,
  epoch: 4,
  planHash,
  sourceRevision: previousSource,
  initialSequence: 7,
  nextSequence: 12,
}
const rotation: ExecutionControllerRotation = {
  schemaVersion: 'bayn.execution-controller-rotation.v1',
  deployment: {
    schemaVersion: 'bayn.execution-deployment-activation.v2',
    controllerKey,
    planHash,
    sourceRevision,
  },
  predecessor: {
    schemaVersion: 'bayn.execution-controller-deactivation.v1',
    controllerKey,
    epoch: 4,
    planHash,
    sourceRevision: previousSource,
  },
}

test('rotation uses the latest sequence after an already-running exclusive predecessor tick completes', () => {
  const afterTick = { ...original, nextSequence: 13 }
  const rotated = Result.getOrThrow(decideExecutionControllerRotation(afterTick, rotation))
  expect(rotated).toMatchObject({
    _tag: 'Activated',
    state: { active: true, epoch: 5, sourceRevision, initialSequence: 13, nextSequence: 13 },
  })
  expect(afterTick).toEqual({ ...original, nextSequence: 13 })
})

test('serialized concurrent rotations replay the one successor and reject a competing binding', () => {
  const first = Result.getOrThrow(decideExecutionControllerRotation(original, rotation))
  expect(Result.getOrThrow(decideExecutionControllerRotation(first.state, rotation))).toEqual({
    _tag: 'Replayed',
    state: first.state,
  })
  expect(
    Result.isFailure(
      decideExecutionControllerRotation(first.state, {
        ...rotation,
        deployment: { ...rotation.deployment, sourceRevision: 'e'.repeat(40) },
      }),
    ),
  ).toBe(true)
})

test.each([
  { ...original, active: false, epoch: 5 },
  { ...original, active: false, epoch: 6 },
  { ...original, epoch: 6 },
  { ...original, sourceRevision: 'f'.repeat(40) },
])('rotation refuses an administrative deactivation or changed predecessor: %j', (state) => {
  expect(Result.isFailure(decideExecutionControllerRotation(state, rotation))).toBe(true)
})

test('rotation rejects mismatched account bindings and exhausted epochs', () => {
  expect(
    Result.isFailure(
      decideExecutionControllerRotation(original, {
        ...rotation,
        predecessor: { ...rotation.predecessor, controllerKey: 'f'.repeat(64) },
      }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      decideExecutionControllerRotation(
        { ...original, epoch: Number.MAX_SAFE_INTEGER - 1 },
        { ...rotation, predecessor: { ...rotation.predecessor, epoch: Number.MAX_SAFE_INTEGER - 1 } },
      ),
    ),
  ).toBe(true)
})

test.each(['before-projection', 'after-projection', 'before-state', 'before-schedule'] as const)(
  'rotation reconciles an uncertain %s failure without persisting inactive state',
  async (failure) => {
    let state = original
    let projected: ExecutionControllerState | undefined
    let failOnce = true
    let stateWrites = 0
    let projectionWrites = 0
    const deliveries: unknown[] = []
    const injected = () => {
      failOnce = false
      throw new Error('injected handoff interruption')
    }
    const object = makeBaynExecutionController(
      {
        controllerKey,
        planHash,
        sourceRevision,
        operationTimeoutMs: 30_000,
        activationAuthorizationHash: Result.getOrThrow(
          executionActivationAuthorizationHash(Buffer.alloc(32, 7).toString('base64url')),
        ),
      },
      {
        prepareActivation: async () => undefined,
        advance: async () => {
          throw new Error('rotation cannot execute a pass inline')
        },
        log: async () => undefined,
        projectState: async (_key, next) => {
          expect(next.active).toBe(true)
          if (failOnce && failure === 'before-projection') injected()
          if (projected === undefined) {
            projected = structuredClone(next)
            projectionWrites += 1
          } else expect(next).toEqual(projected)
          if (failOnce && failure === 'after-projection') injected()
        },
      },
    ) as unknown as {
      object: { rotate: (ctx: ObjectContext, input: unknown) => Promise<ExecutionControllerState> }
    }
    const ctx = {
      key: controllerKey,
      get: async () => state,
      set: (_key: string, next: ExecutionControllerState) => {
        if (failOnce && failure === 'before-state') injected()
        expect(next.active).toBe(true)
        state = next
        stateWrites += 1
      },
      run: async <A>(_name: string, action: () => Promise<A>) => action(),
      request: () => ({ id: 'durable-rotation', attemptCompletedSignal: new AbortController().signal }),
      genericSend: (delivery: unknown) => {
        if (failOnce && failure === 'before-schedule') injected()
        deliveries.push(delivery)
      },
    } as unknown as ObjectContext

    await expect(object.object.rotate(ctx, rotation)).rejects.toThrow('injected handoff interruption')
    expect(state.active).toBe(true)
    if (failure !== 'before-schedule') expect(state).toBe(original)
    expect(deliveries).toHaveLength(0)

    expect(await object.object.rotate(ctx, rotation)).toMatchObject({
      active: true,
      epoch: 5,
      sourceRevision,
      initialSequence: 12,
      nextSequence: 12,
    })
    expect(projectionWrites).toBe(1)
    expect(stateWrites).toBe(1)
    expect(deliveries).toHaveLength(1)
  },
)
