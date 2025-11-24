CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."orchestration_status" AS ENUM('pending', 'running', 'completed', 'failed', 'aborted');--> statement-breakpoint
CREATE TABLE "orchestrations" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"repo_url" text,
	"status" "orchestration_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orchestration_id" text NOT NULL,
	"index" integer NOT NULL,
	"thread_id" text,
	"final_response" text NOT NULL,
	"items" jsonb NOT NULL,
	"usage" jsonb DEFAULT null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_prs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orchestration_id" text NOT NULL,
	"pr_url" text,
	"branch" text,
	"commit_sha" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_orchestration_id_orchestrations_id_fk" FOREIGN KEY ("orchestration_id") REFERENCES "public"."orchestrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_prs" ADD CONSTRAINT "worker_prs_orchestration_id_orchestrations_id_fk" FOREIGN KEY ("orchestration_id") REFERENCES "public"."orchestrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turns_orchestration_id_idx" ON "turns" USING btree ("orchestration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_orchestration_index_unique" ON "turns" USING btree ("orchestration_id","index");--> statement-breakpoint
CREATE INDEX "worker_prs_orchestration_id_idx" ON "worker_prs" USING btree ("orchestration_id");
