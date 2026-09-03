-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('free', 'pro');

-- CreateEnum
CREATE TYPE "ChatType" AS ENUM ('user', 'group', 'room');

-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('once', 'recurring');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('active', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "ReminderSource" AS ENUM ('text', 'image');

-- CreateEnum
CREATE TYPE "OccurrenceStatus" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "VaultKind" AS ENUM ('text', 'link', 'image', 'file');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('pending', 'confirmed', 'discarded');

-- CreateTable
CREATE TABLE "users" (
    "line_user_id" TEXT NOT NULL,
    "display_name" TEXT,
    "tz" TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    "plan" "Plan" NOT NULL DEFAULT 'free',
    "quiet_hours_start" INTEGER,
    "quiet_hours_end" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("line_user_id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" UUID NOT NULL,
    "line_id" TEXT NOT NULL,
    "type" "ChatType" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(3),
    "title" TEXT,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "chat_id" UUID NOT NULL,
    "line_user_id" TEXT NOT NULL,
    "display_name" TEXT,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("chat_id","line_user_id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "created_by" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "kind" "ReminderKind" NOT NULL,
    "due_at_utc" TIMESTAMPTZ(3),
    "rrule" TEXT,
    "every_minutes" INTEGER,
    "fire_at_minute_local" INTEGER,
    "mention_user_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "ReminderSource" NOT NULL DEFAULT 'text',
    "status" "ReminderStatus" NOT NULL DEFAULT 'active',
    "next_fire_at_utc" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_occurrences" (
    "id" UUID NOT NULL,
    "reminder_id" UUID NOT NULL,
    "fire_at_utc" TIMESTAMPTZ(3) NOT NULL,
    "status" "OccurrenceStatus" NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMPTZ(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "snoozed_from_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_drafts" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "created_by" TEXT NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "source" "ReminderSource" NOT NULL DEFAULT 'image',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_items" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "created_by" TEXT NOT NULL,
    "kind" "VaultKind" NOT NULL,
    "title" TEXT,
    "content_text" TEXT,
    "storage_key" TEXT,
    "mime" TEXT,
    "size_bytes" INTEGER,
    "original_file_name" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "search_tsv" tsvector,
    "embedding" vector(1024),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vault_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "scope_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "push_count" INTEGER NOT NULL DEFAULT 0,
    "llm_tokens" INTEGER NOT NULL DEFAULT 0,
    "storage_bytes" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("scope_id","month")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "webhook_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("webhook_event_id")
);

-- CreateTable
CREATE TABLE "external_accounts" (
    "id" UUID NOT NULL,
    "line_user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "todos" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "created_by" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "is_done" BOOLEAN NOT NULL DEFAULT false,
    "due_at_utc" TIMESTAMPTZ(3),
    "assignee_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "todos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "line_user_id" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'free',
    "provider" TEXT,
    "external_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "period_end" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chats_line_id_key" ON "chats"("line_id");

-- CreateIndex
CREATE INDEX "chats_is_active_idx" ON "chats"("is_active");

-- CreateIndex
CREATE INDEX "group_members_chat_id_display_name_idx" ON "group_members"("chat_id", "display_name");

-- CreateIndex
CREATE INDEX "reminders_status_next_fire_at_utc_idx" ON "reminders"("status", "next_fire_at_utc");

-- CreateIndex
CREATE INDEX "reminders_chat_id_status_idx" ON "reminders"("chat_id", "status");

-- CreateIndex
CREATE INDEX "reminder_occurrences_status_fire_at_utc_idx" ON "reminder_occurrences"("status", "fire_at_utc");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_occurrences_reminder_id_fire_at_utc_key" ON "reminder_occurrences"("reminder_id", "fire_at_utc");

-- CreateIndex
CREATE INDEX "reminder_drafts_status_expires_at_idx" ON "reminder_drafts"("status", "expires_at");

-- CreateIndex
CREATE INDEX "vault_items_chat_id_created_at_idx" ON "vault_items"("chat_id", "created_at");

-- CreateIndex
CREATE INDEX "vault_items_chat_id_kind_idx" ON "vault_items"("chat_id", "kind");

-- CreateIndex
CREATE INDEX "processed_events_created_at_idx" ON "processed_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "external_accounts_line_user_id_provider_key" ON "external_accounts"("line_user_id", "provider");

-- CreateIndex
CREATE INDEX "todos_chat_id_is_done_idx" ON "todos"("chat_id", "is_done");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_line_user_id_key" ON "subscriptions"("line_user_id");

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_line_user_id_fkey" FOREIGN KEY ("line_user_id") REFERENCES "users"("line_user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("line_user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_occurrences" ADD CONSTRAINT "reminder_occurrences_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_drafts" ADD CONSTRAINT "reminder_drafts_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("line_user_id") ON DELETE SET NULL ON UPDATE CASCADE;
