import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkflowIsolateManager } from '../src/worker/task-loops.js'

const TEST_WORKFLOWS_DIR = join(process.cwd(), 'packages/temporal-bun-sdk/.test-workflows')

describe('Worker Runtime Mock Tests (zig-worker-01)', () => {
  beforeAll(async () => {
    // Create test workflows directory
    if (!existsSync(TEST_WORKFLOWS_DIR)) {
      mkdirSync(TEST_WORKFLOWS_DIR, { recursive: true })
    }

    // Create a test workflow file with proper export
    const testWorkflow = `
export async function testWorkflow(input: string): Promise<string> {
  return \`Hello, \${input}!\`
}

export default testWorkflow
`
    writeFileSync(join(TEST_WORKFLOWS_DIR, 'test-workflow.ts'), testWorkflow)

    // Create another workflow file
    const anotherWorkflow = `
export async function anotherWorkflow(data: { name: string; count: number }): Promise<string> {
  return \`\${data.name} has \${data.count} items\`
}

export default anotherWorkflow
`
    writeFileSync(join(TEST_WORKFLOWS_DIR, 'another-workflow.ts'), anotherWorkflow)
  })

  afterAll(async () => {
    // Clean up test directory
    if (existsSync(TEST_WORKFLOWS_DIR)) {
      rmSync(TEST_WORKFLOWS_DIR, { recursive: true })
    }
  })

  test('should create WorkflowIsolateManager with valid path', () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)
    expect(manager).toBeDefined()
    expect(manager.workflowsPath).toBe(TEST_WORKFLOWS_DIR)
    expect(manager.isolates.size).toBe(0)
  })

  test('should load workflow from file', async () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    const workflow = await manager.loadWorkflow('test-workflow.ts')

    expect(workflow).toBeDefined()
    expect(typeof workflow).toBe('function') // The workflow function itself
  })

  test('should execute workflow function', async () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Mock activation data
    const activation = {
      workflowType: 'test-workflow',
      input: 'World',
    }

    const result = await manager.executeWorkflow('test-workflow.ts', activation)

    expect(result).toBe('Hello, World!')
  })

  test('should execute workflow with complex input', async () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Mock activation data
    const activation = {
      workflowType: 'another-workflow',
      input: { name: 'Alice', count: 42 },
    }

    const result = await manager.executeWorkflow('another-workflow.ts', activation)

    expect(result).toBe('Alice has 42 items')
  })

  test('should handle missing workflow file', async () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    await expect(manager.loadWorkflow('nonexistent-workflow.ts')).rejects.toThrow(
      'Failed to load workflow nonexistent-workflow.ts',
    )
  })

  test('should cache loaded workflows', async () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Load workflow twice
    const workflow1 = await manager.loadWorkflow('test-workflow.ts')
    const workflow2 = await manager.loadWorkflow('test-workflow.ts')

    // Should return the same instance (cached)
    expect(workflow1).toBe(workflow2)
    expect(manager.isolates.size).toBe(1)
  })

  test('should clear workflow cache', async () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Load workflow
    await manager.loadWorkflow('test-workflow.ts')
    expect(manager.isolates.size).toBe(1)

    // Clear cache
    manager.clearCache()
    expect(manager.isolates.size).toBe(0)

    // Load again - should be a new instance
    const workflow = await manager.loadWorkflow('test-workflow.ts')
    expect(workflow).toBeDefined()
    expect(manager.isolates.size).toBe(1)
  })

  test('should handle multiple different workflows', async () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Load different workflows
    const workflow1 = await manager.loadWorkflow('test-workflow.ts')
    const workflow2 = await manager.loadWorkflow('another-workflow.ts')

    expect(workflow1).not.toBe(workflow2)
    expect(manager.isolates.size).toBe(2)

    // Execute both
    const result1 = await manager.executeWorkflow('test-workflow.ts', { input: 'Test' })
    const result2 = await manager.executeWorkflow('another-workflow.ts', { input: { name: 'Bob', count: 10 } })

    expect(result1).toBe('Hello, Test!')
    expect(result2).toBe('Bob has 10 items')
  })

  test('should handle workflow execution errors', async () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Create a workflow that throws an error
    const errorWorkflow = `
export default async function errorWorkflow(input: string): Promise<string> {
  throw new Error('Intentional error for testing')
}
`
    writeFileSync(join(TEST_WORKFLOWS_DIR, 'error-workflow.ts'), errorWorkflow)

    const activation = {
      workflowType: 'error-workflow',
      input: 'test',
    }

    await expect(manager.executeWorkflow('error-workflow.ts', activation)).rejects.toThrow('Workflow execution failed')

    // Clean up
    rmSync(join(TEST_WORKFLOWS_DIR, 'error-workflow.ts'))
  })

  test('should handle invalid workflow path', () => {
    expect(() => {
      new WorkflowIsolateManager('/nonexistent/path')
    }).toThrow('Workflows path does not exist: /nonexistent/path')
  })

  test('should handle empty workflows directory', async () => {
    const emptyDir = join(TEST_WORKFLOWS_DIR, 'empty')
    mkdirSync(emptyDir, { recursive: true })

    const manager = new WorkflowIsolateManager(emptyDir)

    await expect(manager.loadWorkflow('any-workflow.ts')).rejects.toThrow('Failed to load workflow any-workflow.ts')

    // Clean up
    rmSync(emptyDir, { recursive: true })
  })

  test('should handle malformed workflow files', async () => {
    // Create a malformed workflow file
    const malformedWorkflow = `
// This is not valid TypeScript
export async function malformedWorkflow(input: string): Promise<string> {
  return \`Hello, \${input}!
  // Missing closing quote and parenthesis
`
    writeFileSync(join(TEST_WORKFLOWS_DIR, 'malformed-workflow.ts'), malformedWorkflow)

    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    await expect(manager.loadWorkflow('malformed-workflow.ts')).rejects.toThrow(
      'Failed to load workflow malformed-workflow.ts',
    )

    // Clean up
    rmSync(join(TEST_WORKFLOWS_DIR, 'malformed-workflow.ts'))
  })

  test('should handle workflow files without default export', async () => {
    // Create a workflow file without default export
    const noDefaultWorkflow = `
export async function namedWorkflow(input: string): Promise<string> {
  return \`Hello, \${input}!\`
}
// No default export
`
    writeFileSync(join(TEST_WORKFLOWS_DIR, 'no-default-workflow.ts'), noDefaultWorkflow)

    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Should fail to load since we expect a default export
    await expect(manager.loadWorkflow('no-default-workflow.ts')).rejects.toThrow(
      'Failed to load workflow no-default-workflow.ts',
    )

    // Clean up
    rmSync(join(TEST_WORKFLOWS_DIR, 'no-default-workflow.ts'))
  })
})
