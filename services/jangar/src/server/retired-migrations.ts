import type { Migration } from 'kysely'

// Kysely requires every already-applied migration name to stay present in the
// provider. These generic Agents/Codex names are historical Jangar DB rows only;
// their real schema ownership moved to services/agents.
const retiredMigration: Migration = {
  up: async () => {},
  down: async () => {},
}

export const RETIRED_MIGRATION_NAMES = [
  '20251229_codex_judge_run_metadata',
  '20251229_codex_judge_timeouts',
  '20251229_codex_rerun_submissions',
  '20251229_workflow_comms_agent_messages',
  '20251230_codex_judge_webhook_indexes',
  '20260105_codex_judge_iterations',
  '20260111_jangar_primitives',
  '20260111_jangar_primitives_indexes',
  '20260205_agents_control_plane_cache',
  '20260208_jangar_agentrun_idempotency',
  '20260220_remove_prompt_tuning',
  '20260308_agents_control_plane_component_heartbeats',
  '20260418_embedding_dimension_4096',
  '20260520_codex_judge_agentrun_columns',
  '20260520_drop_codex_rerun_submissions',
] as const

export const getRetiredMigrationEntries = (): Record<(typeof RETIRED_MIGRATION_NAMES)[number], Migration> =>
  Object.fromEntries(RETIRED_MIGRATION_NAMES.map((name) => [name, retiredMigration])) as Record<
    (typeof RETIRED_MIGRATION_NAMES)[number],
    Migration
  >
