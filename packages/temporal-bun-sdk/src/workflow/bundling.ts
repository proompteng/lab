// Workflow bundling for @proompteng/temporal-bun-sdk

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface WorkflowBundle {
  workflows: Record<string, string>
  activities?: Record<string, string>
  metadata: {
    version: string
    createdAt: string
    platform: string
  }
}

export interface BundleOptions {
  workflowsPath: string
  outputPath: string
  includeActivities?: boolean
  minify?: boolean
  sourceMap?: boolean
}

export class WorkflowBundler {
  private options: BundleOptions

  constructor(options: BundleOptions) {
    this.options = options
  }

  async bundle(): Promise<WorkflowBundle> {
    const workflows = await this.collectWorkflows()
    const activities = this.options.includeActivities ? await this.collectActivities() : undefined

    const bundle: WorkflowBundle = {
      workflows,
      activities,
      metadata: {
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        platform: 'bun',
      },
    }

    // Write bundle to output path
    mkdirSync(this.options.outputPath, { recursive: true })
    const bundlePath = join(this.options.outputPath, 'workflow-bundle.json')
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2))

    return bundle
  }

  private async collectWorkflows(): Promise<Record<string, string>> {
    const workflows: Record<string, string> = {}
    const workflowsPath = this.options.workflowsPath

    if (!statSync(workflowsPath).isDirectory()) {
      throw new Error(`Workflows path is not a directory: ${workflowsPath}`)
    }

    const files = readdirSync(workflowsPath)
    for (const file of files) {
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        const filePath = join(workflowsPath, file)
        const content = readFileSync(filePath, 'utf8')
        const workflowName = file.replace(/\.(ts|js)$/, '')
        workflows[workflowName] = content
      }
    }

    return workflows
  }

  private async collectActivities(): Promise<Record<string, string>> {
    const activities: Record<string, string> = {}
    const activitiesPath = join(this.options.workflowsPath, 'activities')

    if (!statSync(activitiesPath).isDirectory()) {
      return activities
    }

    const files = readdirSync(activitiesPath)
    for (const file of files) {
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        const filePath = join(activitiesPath, file)
        const content = readFileSync(filePath, 'utf8')
        const activityName = file.replace(/\.(ts|js)$/, '')
        activities[activityName] = content
      }
    }

    return activities
  }
}

export class WorkflowBundleLoader {
  private bundle: WorkflowBundle

  constructor(bundle: WorkflowBundle) {
    this.bundle = bundle
  }

  async loadWorkflow(workflowName: string): Promise<string> {
    const workflow = this.bundle.workflows[workflowName]
    if (!workflow) {
      throw new Error(`Workflow not found in bundle: ${workflowName}`)
    }
    return workflow
  }

  async loadActivity(activityName: string): Promise<string> {
    if (!this.bundle.activities) {
      throw new Error('Bundle does not contain activities')
    }
    const activity = this.bundle.activities[activityName]
    if (!activity) {
      throw new Error(`Activity not found in bundle: ${activityName}`)
    }
    return activity
  }

  getWorkflowNames(): string[] {
    return Object.keys(this.bundle.workflows)
  }

  getActivityNames(): string[] {
    return this.bundle.activities ? Object.keys(this.bundle.activities) : []
  }

  getMetadata(): WorkflowBundle['metadata'] {
    return this.bundle.metadata
  }
}

// Utility functions
export async function createWorkflowBundle(options: BundleOptions): Promise<WorkflowBundle> {
  const bundler = new WorkflowBundler(options)
  return await bundler.bundle()
}

export function loadWorkflowBundle(bundlePath: string): WorkflowBundleLoader {
  const bundleContent = readFileSync(bundlePath, 'utf8')
  const bundle: WorkflowBundle = JSON.parse(bundleContent)
  return new WorkflowBundleLoader(bundle)
}
