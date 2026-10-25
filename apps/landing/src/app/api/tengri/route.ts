import { isTengriAuthConfigured } from '@/lib/tengri/auth'
import { observeRequest } from '@/lib/observability/server'
import {
  answerCodexQuestions,
  createAgent,
  createCodexThread,
  createDirectory,
  createTerminal,
  deleteAgent,
  deleteFile,
  getCodexAccount,
  getCodexLogin,
  getCodexRun,
  getActiveCodexRun,
  interruptCodexTurn,
  isTengriControlPlaneConfigured,
  issuePreviewSession,
  issueEditorSession,
  issueBrowserSession,
  issueTerminalTicket,
  listAgents,
  listCodexModels,
  listCodexThreads,
  listFiles,
  listTerminals,
  moveFile,
  readFile,
  resolveCodexApproval,
  revokeDesktopPreviews,
  revokePreviewSession,
  resumeAgent,
  resumeCodexThread,
  searchFiles,
  sendCodexTurn,
  setCodexThreadArchived,
  sleepAgent,
  statFile,
  startCodexLogin,
  steerCodexTurn,
  terminateTerminal,
  updatePowerSettings,
  writeFile,
} from '@/lib/tengri/grpc'
import {
  getRateLimitedTengriIdentity,
  noStoreHeaders,
  readTengriJsonBody,
  requireSameOrigin,
  requireSameOriginGet,
  requireTengriIdentity,
  tengriRouteError,
} from '@/lib/tengri/http'
import { normalizePreviewGatewayOrigin } from '@/lib/tengri/preview-origin'
import { tengriActionSchema } from '@/lib/tengri/schemas'
import type { TengriDesktopSnapshot } from '@/lib/tengri/types'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return observeRequest(request, 'tengri.snapshot', () => getSnapshot(request))
}

async function getSnapshot(request: Request) {
  try {
    requireSameOriginGet(request)
    const authConfigured = isTengriAuthConfigured()
    const previewGatewayOrigin = normalizePreviewGatewayOrigin(process.env.TENGRI_PUBLIC_URL || '')
    const controlPlaneConfigured = isTengriControlPlaneConfigured() && Boolean(previewGatewayOrigin)
    if (!authConfigured) return snapshot({ authConfigured, controlPlaneConfigured, previewGatewayOrigin })
    const identity = await getRateLimitedTengriIdentity(request)
    if (!identity) return snapshot({ authConfigured, controlPlaneConfigured, previewGatewayOrigin })
    const agents = controlPlaneConfigured ? await listAgents(identity) : []
    return Response.json(
      {
        authConfigured,
        controlPlaneConfigured,
        previewGatewayOrigin,
        authenticated: true,
        user: identity.user,
        agents,
      } satisfies TengriDesktopSnapshot,
      { headers: noStoreHeaders() },
    )
  } catch (error) {
    return tengriRouteError(error)
  }
}

export async function POST(request: Request) {
  return observeRequest(request, 'tengri.action', () => runAction(request))
}

async function runAction(request: Request) {
  try {
    requireSameOrigin(request)
    const identity = await requireTengriIdentity(request)
    const parsed = tengriActionSchema.safeParse(await readTengriJsonBody(request, { subject: identity.subject }))
    if (!parsed.success) {
      return Response.json(
        {
          error: 'Tengri action is invalid',
          issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
        },
        { status: 400, headers: noStoreHeaders() },
      )
    }
    const action = parsed.data
    let result: unknown
    switch (action.action) {
      case 'create-agent':
        result = await createAgent(identity, action.displayName, action.operationId)
        break
      case 'delete-agent':
        await deleteAgent(identity, action.agentId, action.workspaceUid, action.operationId)
        result = null
        break
      case 'sleep-agent':
        result = await sleepAgent(identity, action.agentId, action.workspaceUid, action.operationId)
        break
      case 'resume-agent':
        result = await resumeAgent(identity, action.agentId, action.workspaceUid, action.operationId)
        break
      case 'update-power-settings':
        result = await updatePowerSettings(identity, action.agentId, action.power)
        break
      case 'stat-file':
        result = await statFile(identity, action.agentId, action.path, request.signal)
        break
      case 'list-files':
        result = await listFiles(identity, action.agentId, action.path)
        break
      case 'read-file':
        result = await readFile(identity, action.agentId, action.path)
        break
      case 'write-file':
        result = await writeFile(
          identity,
          action.agentId,
          action.path,
          action.content,
          action.expectedRevision,
          request.signal,
        )
        break
      case 'create-directory':
        result = await createDirectory(identity, action.agentId, action.path)
        break
      case 'move-file':
        result = await moveFile(identity, action.agentId, action.sourcePath, action.destinationPath)
        break
      case 'delete-file':
        await deleteFile(identity, action.agentId, action.path, action.recursive)
        result = null
        break
      case 'search-files':
        result = await searchFiles(identity, action.agentId, action.path, action.query)
        break
      case 'list-terminals':
        result = await listTerminals(identity, action.agentId)
        break
      case 'create-terminal':
        result = await createTerminal(
          identity,
          action.agentId,
          action.creationId,
          action.cwd,
          action.columns,
          action.rows,
          request.signal,
        )
        break
      case 'terminate-terminal':
        await terminateTerminal(identity, action.agentId, action.terminalId, request.signal)
        result = null
        break
      case 'terminal-ticket':
        result = await issueTerminalTicket(identity, action.agentId, action.terminalId, request.signal)
        break
      case 'codex-account':
        result = await getCodexAccount(identity, action.agentId, request.signal)
        break
      case 'codex-login-status':
        result = await getCodexLogin(identity, action.agentId, request.signal)
        break
      case 'codex-login':
        result = await startCodexLogin(identity, action.agentId)
        break
      case 'codex-models':
        result = await listCodexModels(identity, action.agentId, action.cursor, request.signal)
        break
      case 'active-codex-run':
        result = await getActiveCodexRun(identity, action.agentId)
        break
      case 'codex-run':
        result = await getCodexRun(identity, action.agentId, action.runId)
        break
      case 'create-thread':
        result = await createCodexThread(identity, action.agentId, {
          model: action.model,
          reasoningEffort: action.reasoningEffort,
        })
        break
      case 'list-threads':
        result = await listCodexThreads(identity, action.agentId, action.archived, action.cursor, request.signal)
        break
      case 'set-thread-archived':
        await setCodexThreadArchived(identity, action.agentId, action.threadId, action.archived)
        result = null
        break
      case 'resume-thread':
        return await resumeCodexThread(
          identity,
          action.agentId,
          action.threadId,
          {
            model: action.model,
            reasoningEffort: action.reasoningEffort,
          },
          request.signal,
        )
      case 'send-turn':
        result = await sendCodexTurn(
          identity,
          action.agentId,
          action.threadId,
          action.operationId,
          action.text,
          {
            model: action.model,
            reasoningEffort: action.reasoningEffort,
          },
          action.images,
        )
        break
      case 'steer-turn':
        result = await steerCodexTurn(
          identity,
          action.agentId,
          action.threadId,
          action.turnId,
          action.operationId,
          action.runId,
          action.text,
          action.images,
        )
        break
      case 'interrupt-turn':
        await interruptCodexTurn(identity, action.agentId, action.runId, action.operationId)
        result = null
        break
      case 'answer-questions':
        await answerCodexQuestions(
          identity,
          action.agentId,
          action.approvalId,
          action.runId,
          action.operationId,
          action.response,
        )
        result = null
        break
      case 'resolve-approval':
        await resolveCodexApproval(
          identity,
          action.agentId,
          action.approvalId,
          action.runId,
          action.operationId,
          action.decision,
        )
        result = null
        break
      case 'preview-session':
        result = await issuePreviewSession(identity, action.agentId, action.port, action.path, action.fragment)
        break
      case 'editor-session':
        result = await issueEditorSession(identity, action.agentId, action.windowId, action.renewal, request.signal)
        break
      case 'browser-session':
        result = await issueBrowserSession(identity, action.agentId, action.windowId, action.renewal, request.signal)
        break
      case 'revoke-editor-sessions':
        await revokeDesktopPreviews(identity)
        result = null
        break
      case 'revoke-preview-session':
        await revokePreviewSession(identity, action.agentId, action.sessionId, action.revocationToken)
        result = null
        break
    }
    return Response.json({ result }, { headers: noStoreHeaders() })
  } catch (error) {
    return tengriRouteError(error)
  }
}

function snapshot(input: { authConfigured: boolean; controlPlaneConfigured: boolean; previewGatewayOrigin: string }) {
  return Response.json(
    {
      ...input,
      authenticated: false,
      user: null,
      agents: [],
    } satisfies TengriDesktopSnapshot,
    { headers: noStoreHeaders() },
  )
}

export function HEAD() {
  return new Response(null, { status: 405, headers: { 'Cache-Control': 'no-store' } })
}
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
