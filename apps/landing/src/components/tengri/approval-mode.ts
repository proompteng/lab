import type { TengriCodexEvent } from '@/lib/tengri/types'
import { codexApprovalDecisions, type CodexApprovalDecision } from './codex-events'

export type ApprovalMode = 'ask' | 'auto'
export function approvalModeStorageKey(agentId: string) {
  return `tengri-approval-mode:${agentId}`
}
export function readApprovalMode(agentId: string): ApprovalMode {
  try {
    return localStorage.getItem(approvalModeStorageKey(agentId)) === 'auto' ? 'auto' : 'ask'
  } catch {
    return 'ask'
  }
}
export function writeApprovalMode(agentId: string, mode: ApprovalMode): boolean {
  try {
    localStorage.setItem(approvalModeStorageKey(agentId), mode)
    return true
  } catch {
    return false
  }
}

export function automaticApprovalDecision(event: TengriCodexEvent): CodexApprovalDecision | undefined {
  if (event.kind !== 'approval') return undefined
  const methods = [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
    'mcpServer/elicitation/request',
  ]
  if (!methods.includes(event.method)) return undefined
  // MCP questions/forms do not advertise tool decisions and can never be answered here.
  const decisions = codexApprovalDecisions(event)
  return decisions.includes('approve-once')
    ? 'approve-once'
    : decisions.includes('approve-session')
      ? 'approve-session'
      : undefined
}
