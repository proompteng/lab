import type { ApprovalMode } from '@proompteng/codex'
import { Codex } from '@proompteng/codex'

export type CodexDraftInput = {
  topic: string
  audience?: string
  tone?: string
  approvalPolicy?: ApprovalMode
  workingDirectory?: string
}

const codex = new Codex({
  codexPathOverride: Bun.env.CODEX_PATH ?? undefined,
})

const defaultThreadOptions = {
  workingDirectory: Bun.env.CODEX_WORKDIR ?? process.cwd(),
  approvalPolicy: 'never' as ApprovalMode,
  modelReasoningEffort: 'low' as const,
  networkAccessEnabled: true,
}

export const draftWithCodex = async (input: CodexDraftInput): Promise<string> => {
  const thread = codex.startThread({
    ...defaultThreadOptions,
    approvalPolicy: input.approvalPolicy ?? defaultThreadOptions.approvalPolicy,
    workingDirectory: input.workingDirectory ?? defaultThreadOptions.workingDirectory,
  })

  const { finalResponse } = await thread.run(
    `Create a short ${input.tone ?? 'concise'} update for ${
      input.audience ?? 'a teammate'
    } explaining the next steps for "${input.topic}". Keep it to 2-3 bullet points.`,
  )

  return finalResponse.trim()
}

export const recordProgressNote = async (note: string): Promise<string> => {
  const timestamp = new Date().toISOString()
  return `${timestamp} :: ${note}`
}
