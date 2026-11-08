import { Schema } from 'effect'

export const approvalServiceName = 'FroussardApprovals'
export const ApprovalCommandSchema = Schema.Struct({
  repositoryFullName: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  pullNumber: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  deliveryId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
})
export type ApprovalCommand = typeof ApprovalCommandSchema.Type
export const SignedApprovalCommandSchema = Schema.Struct({
  ...ApprovalCommandSchema.fields,
  signature: Schema.String.check(Schema.isPattern(/^sha256=[a-f0-9]{64}$/)),
})
export type SignedApprovalCommand = typeof SignedApprovalCommandSchema.Type
export const ApprovalStateSchema = Schema.Struct({
  headSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  reviewId: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
})
export type ApprovalState = typeof ApprovalStateSchema.Type
export interface ReadyApproval {
  repositoryFullName: string
  pullNumber: number
  headSha: string
  body: string
}
export const approvalObjectKey = (command: Pick<ApprovalCommand, 'repositoryFullName' | 'pullNumber'>) =>
  `${command.repositoryFullName.toLowerCase()}#${command.pullNumber}`
export const approvalSignaturePayload = (command: ApprovalCommand) =>
  `froussard.approval-command.v1\n${JSON.stringify([command.repositoryFullName, command.pullNumber, command.deliveryId])}`
export const approvalBody = (headSha: string) =>
  `<!-- codex:ready -->\n:shipit:\n<!-- froussard:approval:v1 head=${headSha} -->`
