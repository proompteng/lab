CREATE TABLE "links" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"target_url" text NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "links_slug_idx" ON "links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "links_created_idx" ON "links" USING btree ("created_at");