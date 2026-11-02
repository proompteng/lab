import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_landing_benefits_items_icon" AS ENUM('Layers', 'Cloud', 'Activity', 'Boxes', 'Eye', 'Server', 'Database', 'ShieldCheck', 'KeyRound', 'Lock', 'Network', 'Brain');
  CREATE TYPE "public"."enum_landing_showcase_sections_items_icon" AS ENUM('Layers', 'Cloud', 'Activity', 'Boxes', 'Eye', 'Server', 'Database', 'ShieldCheck', 'KeyRound', 'Lock', 'Network', 'Brain');
  CREATE TYPE "public"."enum_landing_use_cases_items_icon" AS ENUM('Layers', 'Cloud', 'Activity', 'Boxes', 'Eye', 'Server', 'Database', 'ShieldCheck', 'KeyRound', 'Lock', 'Network', 'Brain');
  CREATE TYPE "public"."enum_landing_model_catalog_items_icon" AS ENUM('Layers', 'Cloud', 'Activity', 'Boxes', 'Eye', 'Server', 'Database', 'ShieldCheck', 'KeyRound', 'Lock', 'Network', 'Brain');
  CREATE TABLE "users_sessions" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"created_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone NOT NULL
  );
  
  CREATE TABLE "users" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"email" varchar NOT NULL,
  	"reset_password_token" varchar,
  	"reset_password_expiration" timestamp(3) with time zone,
  	"salt" varchar,
  	"hash" varchar,
  	"login_attempts" numeric DEFAULT 0,
  	"lock_until" timestamp(3) with time zone
  );
  
  CREATE TABLE "media" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"alt" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric,
  	"focal_x" numeric,
  	"focal_y" numeric
  );
  
  CREATE TABLE "payload_kv" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"data" jsonb NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"global_slug" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer,
  	"media_id" integer
  );
  
  CREATE TABLE "payload_preferences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar,
  	"value" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_preferences_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"users_id" integer
  );
  
  CREATE TABLE "payload_migrations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"batch" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "landing_hero_highlights" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"description" varchar NOT NULL
  );
  
  CREATE TABLE "landing_benefits_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"icon" "enum_landing_benefits_items_icon",
  	"title" varchar NOT NULL,
  	"text" varchar NOT NULL
  );
  
  CREATE TABLE "landing_control_plane_points" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"capability" varchar NOT NULL,
  	"proompteng" varchar NOT NULL,
  	"salesforce_agentforce" varchar NOT NULL,
  	"google_gemini" varchar NOT NULL
  );
  
  CREATE TABLE "landing_social_proof_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"tagline" varchar NOT NULL
  );
  
  CREATE TABLE "landing_metrics_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"value" varchar NOT NULL,
  	"label" varchar NOT NULL,
  	"sublabel" varchar NOT NULL
  );
  
  CREATE TABLE "landing_showcase_sections_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"icon" "enum_landing_showcase_sections_items_icon",
  	"title" varchar NOT NULL,
  	"text" varchar NOT NULL
  );
  
  CREATE TABLE "landing_showcase_sections" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"kicker" varchar NOT NULL,
  	"heading" varchar NOT NULL,
  	"description" varchar NOT NULL
  );
  
  CREATE TABLE "landing_use_cases_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"icon" "enum_landing_use_cases_items_icon",
  	"title" varchar NOT NULL,
  	"text" varchar NOT NULL
  );
  
  CREATE TABLE "landing_model_catalog_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"icon" "enum_landing_model_catalog_items_icon",
  	"title" varchar NOT NULL,
  	"text" varchar NOT NULL
  );
  
  CREATE TABLE "landing_playbook_steps" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"description" varchar NOT NULL,
  	"timeframe" varchar NOT NULL,
  	"result" varchar NOT NULL
  );
  
  CREATE TABLE "landing_faq_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"question" varchar NOT NULL,
  	"answer" varchar NOT NULL
  );
  
  CREATE TABLE "landing" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"hero_announcement_label" varchar,
  	"hero_announcement_href" varchar,
  	"hero_headline" varchar NOT NULL,
  	"hero_subheadline" varchar NOT NULL,
  	"hero_cta_label" varchar NOT NULL,
  	"hero_cta_href" varchar NOT NULL,
  	"hero_secondary_cta_label" varchar NOT NULL,
  	"hero_secondary_cta_href" varchar NOT NULL,
  	"hero_de_risk" varchar NOT NULL,
  	"benefits_kicker" varchar NOT NULL,
  	"benefits_heading" varchar NOT NULL,
  	"benefits_description" varchar NOT NULL,
  	"control_plane_kicker" varchar NOT NULL,
  	"control_plane_heading" varchar NOT NULL,
  	"control_plane_description" varchar NOT NULL,
  	"control_plane_comparison_heading" varchar NOT NULL,
  	"control_plane_comparison_note" varchar NOT NULL,
  	"social_proof_kicker" varchar NOT NULL,
  	"social_proof_heading" varchar NOT NULL,
  	"social_proof_description" varchar NOT NULL,
  	"metrics_kicker" varchar NOT NULL,
  	"metrics_heading" varchar NOT NULL,
  	"metrics_description" varchar NOT NULL,
  	"use_cases_title" varchar NOT NULL,
  	"model_catalog_title" varchar NOT NULL,
  	"playbook_kicker" varchar NOT NULL,
  	"playbook_heading" varchar NOT NULL,
  	"playbook_description" varchar NOT NULL,
  	"testimonial_kicker" varchar NOT NULL,
  	"testimonial_quote" varchar NOT NULL,
  	"testimonial_author" varchar NOT NULL,
  	"testimonial_org" varchar NOT NULL,
  	"faq_kicker" varchar NOT NULL,
  	"faq_heading" varchar NOT NULL,
  	"faq_description" varchar NOT NULL,
  	"closing_cta_kicker" varchar NOT NULL,
  	"closing_cta_heading" varchar NOT NULL,
  	"closing_cta_description" varchar NOT NULL,
  	"closing_cta_primary_cta_label" varchar NOT NULL,
  	"closing_cta_primary_cta_href" varchar NOT NULL,
  	"closing_cta_secondary_cta_label" varchar NOT NULL,
  	"closing_cta_secondary_cta_href" varchar NOT NULL,
  	"closing_cta_de_risk" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "users_sessions" ADD CONSTRAINT "users_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_users_fk" FOREIGN KEY ("users_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_hero_highlights" ADD CONSTRAINT "landing_hero_highlights_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_benefits_items" ADD CONSTRAINT "landing_benefits_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_control_plane_points" ADD CONSTRAINT "landing_control_plane_points_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_social_proof_items" ADD CONSTRAINT "landing_social_proof_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_metrics_items" ADD CONSTRAINT "landing_metrics_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_showcase_sections_items" ADD CONSTRAINT "landing_showcase_sections_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing_showcase_sections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_showcase_sections" ADD CONSTRAINT "landing_showcase_sections_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_use_cases_items" ADD CONSTRAINT "landing_use_cases_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_model_catalog_items" ADD CONSTRAINT "landing_model_catalog_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_playbook_steps" ADD CONSTRAINT "landing_playbook_steps_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "landing_faq_items" ADD CONSTRAINT "landing_faq_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."landing"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "users_sessions_order_idx" ON "users_sessions" USING btree ("_order");
  CREATE INDEX "users_sessions_parent_id_idx" ON "users_sessions" USING btree ("_parent_id");
  CREATE INDEX "users_updated_at_idx" ON "users" USING btree ("updated_at");
  CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");
  CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");
  CREATE INDEX "media_updated_at_idx" ON "media" USING btree ("updated_at");
  CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");
  CREATE UNIQUE INDEX "media_filename_idx" ON "media" USING btree ("filename");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_users_id_idx" ON "payload_locked_documents_rels" USING btree ("users_id");
  CREATE INDEX "payload_locked_documents_rels_media_id_idx" ON "payload_locked_documents_rels" USING btree ("media_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_users_id_idx" ON "payload_preferences_rels" USING btree ("users_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");
  CREATE INDEX "landing_hero_highlights_order_idx" ON "landing_hero_highlights" USING btree ("_order");
  CREATE INDEX "landing_hero_highlights_parent_id_idx" ON "landing_hero_highlights" USING btree ("_parent_id");
  CREATE INDEX "landing_benefits_items_order_idx" ON "landing_benefits_items" USING btree ("_order");
  CREATE INDEX "landing_benefits_items_parent_id_idx" ON "landing_benefits_items" USING btree ("_parent_id");
  CREATE INDEX "landing_control_plane_points_order_idx" ON "landing_control_plane_points" USING btree ("_order");
  CREATE INDEX "landing_control_plane_points_parent_id_idx" ON "landing_control_plane_points" USING btree ("_parent_id");
  CREATE INDEX "landing_social_proof_items_order_idx" ON "landing_social_proof_items" USING btree ("_order");
  CREATE INDEX "landing_social_proof_items_parent_id_idx" ON "landing_social_proof_items" USING btree ("_parent_id");
  CREATE INDEX "landing_metrics_items_order_idx" ON "landing_metrics_items" USING btree ("_order");
  CREATE INDEX "landing_metrics_items_parent_id_idx" ON "landing_metrics_items" USING btree ("_parent_id");
  CREATE INDEX "landing_showcase_sections_items_order_idx" ON "landing_showcase_sections_items" USING btree ("_order");
  CREATE INDEX "landing_showcase_sections_items_parent_id_idx" ON "landing_showcase_sections_items" USING btree ("_parent_id");
  CREATE INDEX "landing_showcase_sections_order_idx" ON "landing_showcase_sections" USING btree ("_order");
  CREATE INDEX "landing_showcase_sections_parent_id_idx" ON "landing_showcase_sections" USING btree ("_parent_id");
  CREATE INDEX "landing_use_cases_items_order_idx" ON "landing_use_cases_items" USING btree ("_order");
  CREATE INDEX "landing_use_cases_items_parent_id_idx" ON "landing_use_cases_items" USING btree ("_parent_id");
  CREATE INDEX "landing_model_catalog_items_order_idx" ON "landing_model_catalog_items" USING btree ("_order");
  CREATE INDEX "landing_model_catalog_items_parent_id_idx" ON "landing_model_catalog_items" USING btree ("_parent_id");
  CREATE INDEX "landing_playbook_steps_order_idx" ON "landing_playbook_steps" USING btree ("_order");
  CREATE INDEX "landing_playbook_steps_parent_id_idx" ON "landing_playbook_steps" USING btree ("_parent_id");
  CREATE INDEX "landing_faq_items_order_idx" ON "landing_faq_items" USING btree ("_order");
  CREATE INDEX "landing_faq_items_parent_id_idx" ON "landing_faq_items" USING btree ("_parent_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "users_sessions" CASCADE;
  DROP TABLE "users" CASCADE;
  DROP TABLE "media" CASCADE;
  DROP TABLE "payload_kv" CASCADE;
  DROP TABLE "payload_locked_documents" CASCADE;
  DROP TABLE "payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload_preferences" CASCADE;
  DROP TABLE "payload_preferences_rels" CASCADE;
  DROP TABLE "payload_migrations" CASCADE;
  DROP TABLE "landing_hero_highlights" CASCADE;
  DROP TABLE "landing_benefits_items" CASCADE;
  DROP TABLE "landing_control_plane_points" CASCADE;
  DROP TABLE "landing_social_proof_items" CASCADE;
  DROP TABLE "landing_metrics_items" CASCADE;
  DROP TABLE "landing_showcase_sections_items" CASCADE;
  DROP TABLE "landing_showcase_sections" CASCADE;
  DROP TABLE "landing_use_cases_items" CASCADE;
  DROP TABLE "landing_model_catalog_items" CASCADE;
  DROP TABLE "landing_playbook_steps" CASCADE;
  DROP TABLE "landing_faq_items" CASCADE;
  DROP TABLE "landing" CASCADE;
  DROP TYPE "public"."enum_landing_benefits_items_icon";
  DROP TYPE "public"."enum_landing_showcase_sections_items_icon";
  DROP TYPE "public"."enum_landing_use_cases_items_icon";
  DROP TYPE "public"."enum_landing_model_catalog_items_icon";`)
}
