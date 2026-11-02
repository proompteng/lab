import { z } from 'zod'
import { parseWorkspaceFileLink } from './workspace-file-link-model'

export const MAX_WORKSPACE_RESOURCES = 20

const fileTarget = z
  .strictObject({
    path: z.string().max(4096),
    line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    column: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine((file) => {
    const parsed = parseWorkspaceFileLink(file.path)
    return parsed?.path === file.path && parsed.line === undefined && (!file.column || Boolean(file.line))
  })

const fileTargets = z
  .array(fileTarget)
  .max(MAX_WORKSPACE_RESOURCES)
  .refine((files) => new Set(files.map((file) => file.path)).size === files.length)
const resources = z
  .strictObject({ tabs: fileTargets, activePath: z.string().nullable() })
  .refine((state) => state.activePath === null || state.tabs.some((file) => file.path === state.activePath))

export type WorkspaceResources = z.infer<typeof resources>
export const emptyWorkspaceResources: WorkspaceResources = { tabs: [], activePath: null }

export const workspaceResourcesKey = (agentId: string) => `tengri-resources:${agentId}`
export const workspacePinsKey = (agentId: string) => `tengri-resource-pins:${agentId}`

export function readWorkspaceResources(agentId: string, storage?: Pick<Storage, 'getItem'>): WorkspaceResources {
  try {
    const value = (storage ?? sessionStorage).getItem(workspaceResourcesKey(agentId))
    const parsed = resources.safeParse(value ? JSON.parse(value) : null)
    return parsed.success ? parsed.data : emptyWorkspaceResources
  } catch {
    return emptyWorkspaceResources
  }
}

export function readWorkspacePins(agentId: string, storage?: Pick<Storage, 'getItem'>): z.infer<typeof fileTargets> {
  try {
    const value = (storage ?? localStorage).getItem(workspacePinsKey(agentId))
    const parsed = fileTargets.safeParse(value ? JSON.parse(value) : null)
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function writeWorkspaceResources(
  agentId: string,
  state: WorkspaceResources,
  storage?: Pick<Storage, 'setItem'>,
) {
  try {
    const target = storage ?? sessionStorage
    target.setItem(workspaceResourcesKey(agentId), JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function writeWorkspacePins(
  agentId: string,
  pins: z.infer<typeof fileTargets>,
  storage?: Pick<Storage, 'setItem'>,
) {
  try {
    const target = storage ?? localStorage
    target.setItem(workspacePinsKey(agentId), JSON.stringify(pins))
    return true
  } catch {
    return false
  }
}
