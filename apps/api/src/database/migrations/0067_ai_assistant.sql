-- NeWay AI, Phase 1 (owner, 2026-10-20). New tables only.
CREATE TABLE IF NOT EXISTS "ai_conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL REFERENCES "companies"("id") ON DELETE restrict,
  "user_id" text NOT NULL,
  "title" text DEFAULT 'New chat' NOT NULL,
  "model" text NOT NULL,
  "dry_run" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "ai_conversations_owner_idx" ON "ai_conversations" ("company_id", "user_id", "updated_at");
CREATE TABLE IF NOT EXISTS "ai_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "ai_conversations"("id") ON DELETE restrict,
  "role" text NOT NULL,
  "text" text DEFAULT '' NOT NULL,
  "cards" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "api" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "model" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "ai_messages_conversation_idx" ON "ai_messages" ("conversation_id", "created_at");
CREATE TABLE IF NOT EXISTS "ai_proposals" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "user_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "action" text NOT NULL,
  "params" jsonb NOT NULL,
  "card" jsonb NOT NULL,
  "status" text DEFAULT 'awaiting' NOT NULL,
  "fingerprint" text NOT NULL,
  "result" jsonb,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "decided_by" text
);
CREATE INDEX IF NOT EXISTS "ai_proposals_conversation_idx" ON "ai_proposals" ("conversation_id");
CREATE TABLE IF NOT EXISTS "ai_usage" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "user_id" text NOT NULL,
  "conversation_id" text,
  "model" text NOT NULL,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "cost_micros" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "ai_usage_company_idx" ON "ai_usage" ("company_id", "created_at");
