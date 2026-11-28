import { Schema } from 'effect'

export const strictKnowledge = { onExcessProperty: 'error' } as const

// Reject common credential and contact formats at the boundary. Review still has to exclude secrets and PII.
const safeText = (max: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(max),
    Schema.isPattern(/\S/u),
    Schema.isPattern(
      /^(?![\s\S]*(?:(?:auto_ontology_|gh[pousr]_|github_pat_|sk-|AKIA)[A-Za-z0-9_-]{8,}|-----BEGIN [^\r\n]*PRIVATE KEY|[A-Za-z][A-Za-z0-9+.-]*:\/\/|[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}))[\s\S]*$/u,
    ),
  )

const Sources = Schema.Array(
  Schema.String.check(
    Schema.isPattern(
      /^https:\/\/github\.com\/proompteng\/lab\/(?:pull\/[1-9][0-9]*|blob\/[a-f0-9]{40}\/[\w./-]+(?:#L[0-9]+(?:-L[0-9]+)?)?)$/u,
    ),
    Schema.isMaxLength(300),
  ),
).check(Schema.isMinLength(1), Schema.isMaxLength(5))
const TableName = Schema.String.check(Schema.isPattern(/^public\.[a-z][a-z0-9_]{0,62}$/u))
const Tables = Schema.Array(TableName).check(Schema.isMaxLength(24), Schema.isUnique())

const acronymFields = {
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9]{0,31}$/u)),
  description: safeText(1000),
  sources: Sources,
}
const ruleFields = {
  key: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,63}$/u)),
  description: safeText(500),
  searchTerm: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{1,62}$/u)),
  sources: Sources,
}
const analysisFields = {
  name: safeText(80).check(Schema.isPattern(/^Bayn: [A-Za-z0-9][A-Za-z0-9 /()-]*$/u)),
  description: safeText(1000),
  sql: safeText(12000),
  referencedTables: Tables.check(Schema.isMinLength(1)),
  sources: Sources,
}

const Analysis = Schema.Struct(analysisFields)
export type Analysis = typeof Analysis.Type

export const BaynKnowledge = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.ontology.knowledge.v1'),
  acronyms: Schema.NonEmptyArray(Schema.Struct(acronymFields)),
  rules: Schema.NonEmptyArray(Schema.Struct(ruleFields)),
  analyses: Schema.NonEmptyArray(Analysis),
})
export type BaynKnowledge = typeof BaynKnowledge.Type

enum KnowledgeKind {
  Acronym = 'acronym',
  Rule = 'rule',
  Analysis = 'analysis',
}
export const KnowledgeDelta = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.ontology.knowledge-delta.v1'),
  sourceCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  referencedTables: Tables,
  verificationNote: safeText(1000),
  changes: Schema.Array(
    Schema.Union([
      Schema.Struct({ kind: Schema.Enum({ Acronym: KnowledgeKind.Acronym }), ...acronymFields }),
      Schema.Struct({ kind: Schema.Enum({ Rule: KnowledgeKind.Rule }), ...ruleFields }),
      Schema.Struct({ kind: Schema.Enum({ Analysis: KnowledgeKind.Analysis }), ...analysisFields }),
    ]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
}).check(
  Schema.makeFilter(
    ({ changes, referencedTables }) =>
      changes.every(
        (change) =>
          change.kind !== KnowledgeKind.Analysis ||
          change.referencedTables.every((table) => referencedTables.includes(table)),
      ),
    { message: 'Every analysis relation must be listed in the delta referencedTables' },
  ),
)

export const knowledgeDeltaJsonSchema = () => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(KnowledgeDelta, strictKnowledge)
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Bayn ontology knowledge delta',
    ...schema,
    ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
  }
}
