import { Schema } from 'effect'
import { assign, createMachine } from 'xstate'

export const PlanningCommandSchema = Schema.Struct({
  stage: Schema.Literal('planning'),
  key: Schema.String,
  codexMessage: Schema.Unknown,
  structuredMessage: Schema.Unknown,
  topics: Schema.Struct({
    codex: Schema.String,
    codexStructured: Schema.String,
  }),
  jsonHeaders: Schema.Unknown,
  structuredHeaders: Schema.Unknown,
  ack: Schema.optional(
    Schema.Struct({
      repositoryFullName: Schema.String,
      issueNumber: Schema.Number,
      reaction: Schema.String,
    }),
  ),
})

export type PlanningCommand = Schema.Type<typeof PlanningCommandSchema>

export const ImplementationCommandSchema = Schema.Struct({
  stage: Schema.Literal('implementation'),
  key: Schema.String,
  codexMessage: Schema.Unknown,
  structuredMessage: Schema.Unknown,
  topics: Schema.Struct({
    codex: Schema.String,
    codexStructured: Schema.String,
  }),
  jsonHeaders: Schema.Unknown,
  structuredHeaders: Schema.Unknown,
})

export type ImplementationCommand = Schema.Type<typeof ImplementationCommandSchema>

export const ReviewCommandSchema = Schema.Struct({
  stage: Schema.Literal('review'),
  key: Schema.String,
  codexMessage: Schema.Unknown,
  structuredMessage: Schema.Unknown,
  topics: Schema.Struct({
    codex: Schema.String,
    codexStructured: Schema.String,
  }),
  jsonHeaders: Schema.Unknown,
  structuredHeaders: Schema.Unknown,
})

export type ReviewCommand = Schema.Type<typeof ReviewCommandSchema>

export const UndraftCommandSchema = Schema.Struct({
  repositoryFullName: Schema.String,
  pullNumber: Schema.Number,
  commentBody: Schema.String,
})

export type UndraftCommand = Schema.Type<typeof UndraftCommandSchema>

export const ReadyCommentCommandSchema = Schema.Struct({
  repositoryFullName: Schema.String,
  pullNumber: Schema.Number,
  issueNumber: Schema.Number,
  body: Schema.String,
  marker: Schema.String,
})

export type ReadyCommentCommand = Schema.Type<typeof ReadyCommentCommandSchema>

export const WorkflowCommandSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('publishPlanning'),
    data: PlanningCommandSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('publishImplementation'),
    data: ImplementationCommandSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('publishReview'),
    data: ReviewCommandSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('markReadyForReview'),
    data: UndraftCommandSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('postReadyComment'),
    data: ReadyCommentCommandSchema,
  }),
)

export type WorkflowCommand = Schema.Type<typeof WorkflowCommandSchema>

export interface WorkflowContext {
  commands: WorkflowCommand[]
}

export const ReviewEvaluationSchema = Schema.Struct({
  outstandingWork: Schema.Boolean,
  forceReview: Schema.Boolean,
  isDraft: Schema.Boolean,
  mergeStateRequiresAttention: Schema.Boolean,
  reviewCommand: Schema.optional(ReviewCommandSchema),
  undraftCommand: Schema.optional(UndraftCommandSchema),
  readyCommentCommand: Schema.optional(ReadyCommentCommandSchema),
})

export type ReviewEvaluation = Schema.Type<typeof ReviewEvaluationSchema>

export interface ReviewRequestEvent {
  reviewCommand: ReviewCommand
  outstandingWork: boolean
}

export type WorkflowEvent =
  | { type: 'ISSUE_OPENED'; data: PlanningCommand }
  | { type: 'PLAN_APPROVED'; data: ImplementationCommand }
  | { type: 'PR_ACTIVITY'; data: ReviewEvaluation }
  | { type: 'REVIEW_REQUESTED'; data: ReviewRequestEvent }
  | { type: 'IGNORE' }

export const shouldUndraftGuard = (_context: WorkflowContext, event: WorkflowEvent) =>
  event.type === 'PR_ACTIVITY' && !event.data.outstandingWork && event.data.isDraft && !!event.data.undraftCommand

export const shouldPostReadyCommentGuard = (_context: WorkflowContext, event: WorkflowEvent) =>
  event.type === 'PR_ACTIVITY' &&
  !event.data.outstandingWork &&
  !event.data.forceReview &&
  !event.data.isDraft &&
  !event.data.mergeStateRequiresAttention &&
  !!event.data.readyCommentCommand

export const codexWorkflowMachine = createMachine({
  id: 'codexWorkflow',
  types: {} as {
    context: WorkflowContext
    events: WorkflowEvent
  },
  context: () => ({ commands: [] }),
  initial: 'idle',
  states: {
    idle: {
      on: {
        ISSUE_OPENED: {
          target: 'planning',
          actions: ['queuePlanning'],
        },
        PLAN_APPROVED: {
          target: 'implementation',
          actions: ['queueImplementation'],
        },
        PR_ACTIVITY: 'reviewRouting',
        REVIEW_REQUESTED: {
          target: 'reviewRequested',
          actions: ['queueReview'],
        },
        IGNORE: 'ignored',
      },
    },
    planning: {
      type: 'final',
    },
    implementation: {
      type: 'final',
    },
    reviewRouting: {
      always: [
        {
          target: 'reviewUndraft',
          guard: 'shouldUndraft',
          actions: ['queueUndraft'],
        },
        {
          target: 'reviewReadyComment',
          guard: 'shouldPostReadyComment',
          actions: ['queueReadyComment'],
        },
        { target: 'ignored' },
      ],
    },
    reviewUndraft: {
      type: 'final',
    },
    reviewReadyComment: {
      type: 'final',
    },
    reviewRequested: {
      type: 'final',
    },
    ignored: {
      type: 'final',
    },
  },
}).provide({
  actions: {
    queuePlanning: assign({
      commands: ({ context }, event) =>
        event.type === 'ISSUE_OPENED'
          ? [...context.commands, { type: 'publishPlanning', data: event.data }]
          : context.commands,
    }),
    queueImplementation: assign({
      commands: ({ context }, event) =>
        event.type === 'PLAN_APPROVED'
          ? [...context.commands, { type: 'publishImplementation', data: event.data }]
          : context.commands,
    }),
    queueReview: assign({
      commands: ({ context }, event) =>
        event.type === 'REVIEW_REQUESTED'
          ? [...context.commands, { type: 'publishReview', data: event.data.reviewCommand }]
          : context.commands,
    }),
    queueUndraft: assign({
      commands: ({ context }, event) =>
        event.type === 'PR_ACTIVITY' && event.data.undraftCommand
          ? [...context.commands, { type: 'markReadyForReview', data: event.data.undraftCommand }]
          : context.commands,
    }),
    queueReadyComment: assign({
      commands: ({ context }, event) =>
        event.type === 'PR_ACTIVITY' && event.data.readyCommentCommand
          ? [...context.commands, { type: 'postReadyComment', data: event.data.readyCommentCommand }]
          : context.commands,
    }),
  },
  guards: {
    shouldUndraft: shouldUndraftGuard,
    shouldPostReadyComment: shouldPostReadyCommentGuard,
  },
})

export interface WorkflowResult {
  commands: WorkflowCommand[]
  state: unknown
}

export const evaluateCodexWorkflow = (event: WorkflowEvent): WorkflowResult => {
  switch (event.type) {
    case 'ISSUE_OPENED': {
      return {
        commands: [{ type: 'publishPlanning', data: event.data }],
        state: 'planning',
      }
    }
    case 'PLAN_APPROVED': {
      return {
        commands: [{ type: 'publishImplementation', data: event.data }],
        state: 'implementation',
      }
    }
    case 'PR_ACTIVITY': {
      const commands: WorkflowCommand[] = []
      let state: string = 'ignored'

      if (shouldUndraftGuard({ commands: [] }, event) && event.data.undraftCommand) {
        commands.push({ type: 'markReadyForReview', data: event.data.undraftCommand })
        if (state === 'ignored') {
          state = 'reviewUndraft'
        }
      }

      if (shouldPostReadyCommentGuard({ commands: [] }, event) && event.data.readyCommentCommand) {
        commands.push({ type: 'postReadyComment', data: event.data.readyCommentCommand })
        if (state === 'ignored') {
          state = 'reviewReadyComment'
        }
      }

      return { commands, state }
    }
    case 'REVIEW_REQUESTED': {
      return {
        commands: [{ type: 'publishReview', data: event.data.reviewCommand }],
        state: 'reviewRequested',
      }
    }
    default:
      return { commands: [], state: 'ignored' }
  }
}
