import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`CREATE SCHEMA IF NOT EXISTS jangar_github`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS jangar_github.events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      delivery_id text NOT NULL UNIQUE,
      event_type text NOT NULL,
      action text,
      repository text NOT NULL,
      pr_number integer NOT NULL,
      commit_sha text,
      sender_login text,
      payload jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS jangar_github.pr_state (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository text NOT NULL,
      pr_number integer NOT NULL,
      commit_sha text,
      received_at timestamptz NOT NULL,
      title text,
      body text,
      state text,
      merged boolean,
      merged_at timestamptz,
      draft boolean,
      author_login text,
      author_avatar_url text,
      html_url text,
      head_ref text,
      head_sha text,
      base_ref text,
      base_sha text,
      mergeable boolean,
      mergeable_state text,
      labels text[] DEFAULT '{}',
      additions integer,
      deletions integer,
      changed_files integer,
      created_at timestamptz,
      updated_at timestamptz,
      UNIQUE (repository, pr_number)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS jangar_github.review_state (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository text NOT NULL,
      pr_number integer NOT NULL,
      commit_sha text,
      received_at timestamptz NOT NULL,
      review_decision text,
      requested_changes boolean,
      unresolved_threads_count integer,
      summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      latest_reviewed_at timestamptz,
      updated_at timestamptz,
      UNIQUE (repository, pr_number)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS jangar_github.check_state (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository text NOT NULL,
      pr_number integer NOT NULL,
      commit_sha text NOT NULL,
      received_at timestamptz NOT NULL,
      status text,
      details_url text,
      total_count integer,
      success_count integer,
      failure_count integer,
      pending_count integer,
      checks jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz,
      UNIQUE (repository, pr_number, commit_sha)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS jangar_github.review_threads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository text NOT NULL,
      pr_number integer NOT NULL,
      commit_sha text,
      received_at timestamptz NOT NULL,
      thread_key text NOT NULL,
      thread_id text,
      is_resolved boolean NOT NULL DEFAULT false,
      path text,
      line integer,
      side text,
      start_line integer,
      author_login text,
      resolved_at timestamptz,
      updated_at timestamptz,
      created_at timestamptz,
      UNIQUE (repository, pr_number, thread_key)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS jangar_github.comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository text NOT NULL,
      pr_number integer NOT NULL,
      commit_sha text,
      received_at timestamptz NOT NULL,
      comment_id text NOT NULL UNIQUE,
      comment_type text NOT NULL,
      thread_key text,
      author_login text,
      body text,
      path text,
      line integer,
      side text,
      start_line integer,
      diff_hunk text,
      url text,
      created_at timestamptz,
      updated_at timestamptz
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS jangar_github.pr_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository text NOT NULL,
      pr_number integer NOT NULL,
      commit_sha text NOT NULL,
      received_at timestamptz NOT NULL,
      path text NOT NULL,
      status text,
      additions integer,
      deletions integer,
      changes integer,
      patch text,
      blob_url text,
      raw_url text,
      sha text,
      previous_filename text,
      UNIQUE (repository, pr_number, commit_sha, path)
    )
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS jangar_github.write_actions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      repository text NOT NULL,
      pr_number integer NOT NULL,
      commit_sha text,
      received_at timestamptz NOT NULL,
      action text NOT NULL,
      actor text,
      request_id text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      response jsonb,
      success boolean NOT NULL DEFAULT false,
      error text
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS jangar_github_pr_state_updated_idx
    ON jangar_github.pr_state (repository, updated_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS jangar_github_check_state_updated_idx
    ON jangar_github.check_state (repository, pr_number, updated_at DESC)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS jangar_github_review_threads_repo_idx
    ON jangar_github.review_threads (repository, pr_number)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS jangar_github_comments_repo_idx
    ON jangar_github.comments (repository, pr_number)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS jangar_github_pr_files_repo_idx
    ON jangar_github.pr_files (repository, pr_number, commit_sha)
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
