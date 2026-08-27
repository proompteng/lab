import { isTengriAuthConfigured } from '@/lib/tengri/auth'
import {
  createAgent,
  createCodexThread,
  createDirectory,
  createTerminal,
  deleteAgent,
  deleteFile,
  getCodexAccount,
  interruptCodexTurn,
  isTengriControlPlaneConfigured,
  issuePreviewSession,
  issueTerminalTicket,
  listAgents,
  listFiles,
  listTerminals,
  moveFile,
  readFile,
  resolveCodexApproval,
  resumeAgent,
  resumeCodexThread,
  searchFiles,
  sendCodexTurn,
  sleepAgent,
  startCodexLogin,
  steerCodexTurn,
  terminateTerminal,
  writeFile,
} from '@/lib/tengri/grpc'
import {
  getRateLimitedTengriIdentity,
  noStoreHeaders,
  readTengriJsonBody,
  requireSameOrigin,
  requireTengriIdentity,
  tengriRouteError,
} from '@/lib/tengri/http'
import { normalizePreviewGatewayOrigin } from '@/lib/tengri/preview-origin'
import { tengriActionSchema } from '@/lib/tengri/schemas'
import type { TengriDesktopSnapshot } from '@/lib/tengri/types'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const authConfigured = isTengriAuthConfigured()
    const previewGatewayOrigin = normalizePreviewGatewayOrigin(process.env.TENGRI_PUBLIC_URL || '')
    const controlPlaneConfigured = isTengriControlPlaneConfigured() && Boolean(previewGatewayOrigin)
    if (!authConfigured) return snapshot({ authConfigured, controlPlaneConfigured, previewGatewayOrigin })
    const identity = await getRateLimitedTengriIdentity(request)
    if (!identity) return snapshot({ authConfigured, controlPlaneConfigured, previewGatewayOrigin })
    const agents = controlPlaneConfigured ? await listAgents(identity.subject) : []
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
  try {
    requireSameOrigin(request)
    const identity = await requireTengriIdentity(request)
    const parsed = tengriActionSchema.safeParse(await readTengriJsonBody(request))
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
        result = await createAgent(identity.subject, action.displayName)
        break
      case 'delete-agent':
        await deleteAgent(identity.subject, action.agentId)
        result = null
        break
      case 'sleep-agent':
        result = await sleepAgent(identity.subject, action.agentId)
        break
      case 'resume-agent':
        result = await resumeAgent(identity.subject, action.agentId)
        break
      case 'list-files':
        result = await listFiles(identity.subject, action.agentId, action.path)
        break
      case 'read-file':
        result = await readFile(identity.subject, action.agentId, action.path)
        break
      case 'write-file':
        result = await writeFile(identity.subject, action.agentId, action.path, action.content)
        break
      case 'create-directory':
        result = await createDirectory(identity.subject, action.agentId, action.path)
        break
      case 'move-file':
        result = await moveFile(identity.subject, action.agentId, action.sourcePath, action.destinationPath)
        break
      case 'delete-file':
        await deleteFile(identity.subject, action.agentId, action.path, action.recursive)
        result = null
        break
      case 'search-files':
        result = await searchFiles(identity.subject, action.agentId, action.path, action.query)
        break
      case 'list-terminals':
        result = await listTerminals(identity.subject, action.agentId)
        break
      case 'create-terminal':
        result = await createTerminal(
          identity.subject,
          action.agentId,
          action.cwd,
          action.columns,
          action.rows,
          request.signal,
        )
        break
      case 'terminate-terminal':
        await terminateTerminal(identity.subject, action.agentId, action.terminalId)
        result = null
        break
      case 'terminal-ticket':
        result = await issueTerminalTicket(identity.subject, action.agentId, action.terminalId)
        break
      case 'codex-account':
        result = await getCodexAccount(identity.subject, action.agentId)
        break
      case 'codex-login':
        result = await startCodexLogin(identity.subject, action.agentId)
        break
      case 'create-thread':
        result = await createCodexThread(identity.subject, action.agentId)
        break
      case 'resume-thread':
        result = await resumeCodexThread(identity.subject, action.agentId, action.threadId)
        break
      case 'send-turn':
        result = await sendCodexTurn(identity.subject, action.agentId, action.threadId, action.text)
        break
      case 'steer-turn':
        result = await steerCodexTurn(identity.subject, action.agentId, action.threadId, action.turnId, action.text)
        break
      case 'interrupt-turn':
        await interruptCodexTurn(identity.subject, action.agentId, action.threadId, action.turnId)
        result = null
        break
      case 'resolve-approval':
        await resolveCodexApproval(identity.subject, action.agentId, action.approvalId, action.decision)
        result = null
        break
      case 'preview-session':
        result = await issuePreviewSession(identity.subject, action.agentId, action.port, action.path)
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
