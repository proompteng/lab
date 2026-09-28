import { Codex } from '@proompteng/codex'

export type CodexSpec = {
  summary: string
  text: string
  acceptanceCriteria: string[]
  labels?: string[]
}

const extractJson = (input: string) => {
  const fenced = /```json\s*([\s\S]*?)\s*```/i.exec(input)
  if (fenced?.[1]) return fenced[1]
  const start = input.indexOf('{')
  const end = input.lastIndexOf('}')
  if (start >= 0 && end > start) return input.slice(start, end + 1)
  return input
}

export const parseCodexResponse = (input: string): CodexSpec => {
  const raw = extractJson(input).trim()
  const parsed = JSON.parse(raw) as Partial<CodexSpec>
  if (!parsed.summary || !parsed.text) {
    throw new Error('Codex response missing required fields (summary, text).')
  }
  const acceptanceCriteria = Array.isArray(parsed.acceptanceCriteria)
    ? parsed.acceptanceCriteria.filter((item) => typeof item === 'string' && item.trim())
    : []
  return {
    summary: parsed.summary,
    text: parsed.text,
    acceptanceCriteria,
    labels: Array.isArray(parsed.labels)
      ? parsed.labels.filter((item) => typeof item === 'string' && item.trim())
      : undefined,
  }
}

export const runCodex = async (prompt: string): Promise<CodexSpec> => {
  const codex = new Codex()
  const thread = codex.startThread({
    workingDirectory: process.cwd(),
    approvalPolicy: 'never',
  })
  const instruction = `Return JSON only with keys: summary, text, acceptanceCriteria (array of strings), labels (array).`
  const { finalResponse } = await thread.run(`${instruction}\nTask: ${prompt}`)
  return parseCodexResponse(finalResponse)
}
