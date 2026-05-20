import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`
    DO $$
    BEGIN
      IF to_regclass('agents_comms.agent_messages') IS NULL THEN
        RETURN;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agents_comms' AND table_name = 'agent_messages' AND column_name = 'workflow_uid'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agents_comms' AND table_name = 'agent_messages' AND column_name = 'agent_run_uid'
      ) THEN
        ALTER TABLE agents_comms.agent_messages RENAME COLUMN workflow_uid TO agent_run_uid;
      ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agents_comms' AND table_name = 'agent_messages' AND column_name = 'workflow_uid'
      ) THEN
        UPDATE agents_comms.agent_messages SET agent_run_uid = COALESCE(agent_run_uid, workflow_uid);
        ALTER TABLE agents_comms.agent_messages DROP COLUMN workflow_uid;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agents_comms' AND table_name = 'agent_messages' AND column_name = 'workflow_name'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agents_comms' AND table_name = 'agent_messages' AND column_name = 'agent_run_name'
      ) THEN
        ALTER TABLE agents_comms.agent_messages RENAME COLUMN workflow_name TO agent_run_name;
      ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agents_comms' AND table_name = 'agent_messages' AND column_name = 'workflow_name'
      ) THEN
        UPDATE agents_comms.agent_messages SET agent_run_name = COALESCE(agent_run_name, workflow_name);
        ALTER TABLE agents_comms.agent_messages DROP COLUMN workflow_name;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agents_comms' AND table_name = 'agent_messages' AND column_name = 'workflow_namespace'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agents_comms' AND table_name = 'agent_messages' AND column_name = 'agent_run_namespace'
      ) THEN
        ALTER TABLE agents_comms.agent_messages RENAME COLUMN workflow_namespace TO agent_run_namespace;
      ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'agents_comms' AND table_name = 'agent_messages' AND column_name = 'workflow_namespace'
      ) THEN
        UPDATE agents_comms.agent_messages SET agent_run_namespace = COALESCE(agent_run_namespace, workflow_namespace);
        ALTER TABLE agents_comms.agent_messages DROP COLUMN workflow_namespace;
      END IF;
    END $$;
  `.execute(db)

  await sql`DROP INDEX IF EXISTS agents_comms.agents_agent_messages_workflow_time_idx;`.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_agent_messages_agent_run_time_idx
    ON agents_comms.agent_messages (agent_run_uid, timestamp);
  `.execute(db)
}

export const down = async (_db: Kysely<AgentsDatabase>) => {}
