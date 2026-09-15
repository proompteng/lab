import { expect, test } from 'bun:test'

import {
  BunWorker,
  createDefaultDataConverter,
  createWorker,
  defineWorkflow,
  runWorker,
  WorkflowRegistry,
} from '../src'

test('package root preserves worker, workflow, and common exports', () => {
  expect(typeof BunWorker).toBe('function')
  expect(typeof createWorker).toBe('function')
  expect(typeof runWorker).toBe('function')
  expect(typeof createDefaultDataConverter).toBe('function')
  expect(typeof defineWorkflow).toBe('function')
  expect(typeof WorkflowRegistry).toBe('function')
})
