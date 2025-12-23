export type ReadRepoFileInput = {
  repoRoot: string
  filePath: string
}

export type AstGrepInput = {
  repoRoot: string
  filePath: string
}

export type EnrichInput = {
  filename: string
  content: string
  astSummary: string
  context: string
}

export type EmbeddingInput = {
  text: string
}

export type PersistInput = {
  filename: string
  summary: string
  content: string
  astSummary: string
  embedding: number[]
  metadata: Record<string, unknown>
}

export type BumbaActivities = typeof activities

const notImplemented = (name: string) => {
  throw new Error(`activity not implemented: ${name}`)
}

export const activities = {
  async readRepoFile(_input: ReadRepoFileInput): Promise<{ content: string }> {
    return notImplemented('readRepoFile')
  },

  async extractAstSummary(_input: AstGrepInput): Promise<{ astSummary: string; metadata: Record<string, unknown> }> {
    return notImplemented('extractAstSummary')
  },

  async enrichWithModel(_input: EnrichInput): Promise<{ summary: string; enriched: string }> {
    return notImplemented('enrichWithModel')
  },

  async createEmbedding(_input: EmbeddingInput): Promise<{ embedding: number[] }> {
    return notImplemented('createEmbedding')
  },

  async persistEnrichment(_input: PersistInput): Promise<{ id: string }> {
    return notImplemented('persistEnrichment')
  },
}

export default activities
