CREATE TABLE `ai_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`course_id` text NOT NULL,
	`assignment_id` text,
	`question_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_message_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`,`student_id`) REFERENCES `course_enrollments`(`course_id`,`student_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignment_id`,`course_id`) REFERENCES `assignments`(`id`,`course_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`,`course_id`) REFERENCES `questions`(`id`,`course_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ai_conversations_student_recent` ON `ai_conversations` (`student_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_conversations_course_recent` ON `ai_conversations` (`course_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_conversations_assignment_student` ON `ai_conversations` (`assignment_id`,`student_id`);--> statement-breakpoint
CREATE TABLE `ai_daily_quotas` (
	`user_id` text NOT NULL,
	`usage_date` text NOT NULL,
	`reserved_requests` integer DEFAULT 0 NOT NULL,
	`completed_requests` integer DEFAULT 0 NOT NULL,
	`reserved_tokens` integer DEFAULT 0 NOT NULL,
	`used_tokens` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`user_id`, `usage_date`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_ai_daily_quotas_nonnegative" CHECK("ai_daily_quotas"."reserved_requests" >= 0 AND "ai_daily_quotas"."completed_requests" >= 0 AND "ai_daily_quotas"."reserved_tokens" >= 0 AND "ai_daily_quotas"."used_tokens" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_ai_daily_quotas_date` ON `ai_daily_quotas` (`usage_date`);--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`prompt_version` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_messages_conversation_sequence` ON `ai_messages` (`conversation_id`,`sequence_number`);--> statement-breakpoint
CREATE INDEX `idx_ai_messages_conversation_created` ON `ai_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_provider_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_key` text NOT NULL,
	`display_name` text NOT NULL,
	`api_base_url` text,
	`default_model` text NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`api_key_hint` text,
	`enabled` integer DEFAULT false NOT NULL,
	`created_by_id` text NOT NULL,
	`updated_by_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_provider_configs_provider_key` ON `ai_provider_configs` (`provider_key`);--> statement-breakpoint
CREATE TABLE `ai_settings` (
	`id` text PRIMARY KEY DEFAULT 'global' NOT NULL,
	`provider_config_id` text,
	`enabled` integer DEFAULT false NOT NULL,
	`assistant_mode` text DEFAULT 'hints_only' NOT NULL,
	`full_answer_after_attempts` integer,
	`school_daily_token_limit` integer,
	`student_daily_token_limit` integer,
	`student_daily_request_limit` integer,
	`save_conversations` integer DEFAULT true NOT NULL,
	`conversation_retention_days` integer,
	`updated_by_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`provider_config_id`) REFERENCES `ai_provider_configs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_ai_settings_singleton" CHECK("ai_settings"."id" = 'global'),
	CONSTRAINT "chk_ai_settings_attempts_positive" CHECK("ai_settings"."full_answer_after_attempts" IS NULL OR "ai_settings"."full_answer_after_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_config_id` text,
	`conversation_id` text,
	`purpose` text NOT NULL,
	`usage_date` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`status` text NOT NULL,
	`error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_config_id`) REFERENCES `ai_provider_configs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_ai_usage_tokens_nonnegative" CHECK("ai_usage"."input_tokens" >= 0 AND "ai_usage"."output_tokens" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_ai_usage_date` ON `ai_usage` (`usage_date`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_user_date` ON `ai_usage` (`user_id`,`usage_date`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_provider_date` ON `ai_usage` (`provider_config_id`,`usage_date`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_conversation_created` ON `ai_usage` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`course_id` text,
	`class_id` text,
	`title_zh` text NOT NULL,
	`title_en` text,
	`body_zh` text NOT NULL,
	`body_en` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`publish_at` text,
	`expires_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_announcements_has_audience" CHECK("announcements"."course_id" IS NOT NULL OR "announcements"."class_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `idx_announcements_course_publish` ON `announcements` (`course_id`,`status`,`publish_at`);--> statement-breakpoint
CREATE INDEX `idx_announcements_class_publish` ON `announcements` (`class_id`,`status`,`publish_at`);--> statement-breakpoint
CREATE TABLE `assignment_items` (
	`assignment_id` text NOT NULL,
	`question_id` text NOT NULL,
	`course_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`score_override` real,
	PRIMARY KEY(`assignment_id`, `question_id`),
	FOREIGN KEY (`assignment_id`,`course_id`) REFERENCES `assignments`(`id`,`course_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`,`course_id`) REFERENCES `questions`(`id`,`course_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_assignment_items_position_nonnegative" CHECK("assignment_items"."position" >= 0),
	CONSTRAINT "chk_assignment_items_score_override_nonnegative" CHECK("assignment_items"."score_override" IS NULL OR "assignment_items"."score_override" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_assignment_items_assignment_position` ON `assignment_items` (`assignment_id`,`position`);--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`unit_id` text,
	`created_by_id` text NOT NULL,
	`kind` text DEFAULT 'homework' NOT NULL,
	`title_zh` text NOT NULL,
	`title_en` text,
	`instructions_zh` text,
	`instructions_en` text,
	`publish_at` text,
	`due_at` text,
	`answer_release_at` text,
	`max_attempts` integer DEFAULT 1 NOT NULL,
	`allow_late` integer DEFAULT false NOT NULL,
	`allow_resubmit` integer DEFAULT false NOT NULL,
	`randomize_order` integer DEFAULT false NOT NULL,
	`question_selection_count` integer,
	`show_score_immediately` integer DEFAULT true NOT NULL,
	`show_test_results_immediately` integer DEFAULT true NOT NULL,
	`ai_assistant_enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_assignments_max_attempts_positive" CHECK("assignments"."max_attempts" > 0),
	CONSTRAINT "chk_assignments_selection_count_positive" CHECK("assignments"."question_selection_count" IS NULL OR "assignments"."question_selection_count" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_assignments_id_course` ON `assignments` (`id`,`course_id`);--> statement-breakpoint
CREATE INDEX `idx_assignments_course_status_publish` ON `assignments` (`course_id`,`status`,`publish_at`);--> statement-breakpoint
CREATE INDEX `idx_assignments_course_due` ON `assignments` (`course_id`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_assignments_unit` ON `assignments` (`unit_id`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`result` text NOT NULL,
	`metadata_json` text,
	`request_id` text,
	`ip_hash` text,
	`expires_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_actor_created` ON `audit_logs` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_entity_created` ON `audit_logs` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_action_created` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_auth_sessions_token_hash` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_user_active` ON `auth_sessions` (`user_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_expires_at` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `backup_records` (
	`id` text PRIMARY KEY NOT NULL,
	`triggered_by_id` text,
	`trigger` text NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`storage_key` text,
	`checksum` text,
	`byte_size` integer,
	`error_code` text,
	`error_message` text,
	`expires_at` text,
	`deleted_at` text,
	`started_at` text,
	`finished_at` text,
	`verified_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`triggered_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_backup_records_status_created` ON `backup_records` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_backup_records_created` ON `backup_records` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_backup_records_expires` ON `backup_records` (`expires_at`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `class_memberships` (
	`class_id` text NOT NULL,
	`user_id` text NOT NULL,
	`member_role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`joined_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`left_at` text,
	PRIMARY KEY(`class_id`, `user_id`),
	FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_class_memberships_member_role" CHECK("class_memberships"."member_role" IN ('teacher', 'student'))
);
--> statement-breakpoint
CREATE INDEX `idx_class_memberships_user_status` ON `class_memberships` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_class_memberships_class_role_status` ON `class_memberships` (`class_id`,`member_role`,`status`);--> statement-breakpoint
CREATE TABLE `classes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`academic_year` text NOT NULL,
	`grade_level` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_classes_year_name` ON `classes` (`academic_year`,`name`);--> statement-breakpoint
CREATE INDEX `idx_classes_status_year` ON `classes` (`status`,`academic_year`);--> statement-breakpoint
CREATE TABLE `code_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_answer_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`question_id` text NOT NULL,
	`run_type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stdout` text,
	`stderr` text,
	`exit_code` integer,
	`duration_ms` integer,
	`peak_memory_kb` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`submission_answer_id`,`question_id`) REFERENCES `submission_answers`(`id`,`question_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`,`submission_answer_id`) REFERENCES `code_snapshots`(`id`,`submission_answer_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_code_runs_id_question` ON `code_runs` (`id`,`question_id`);--> statement-breakpoint
CREATE INDEX `idx_code_runs_answer_created` ON `code_runs` (`submission_answer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_code_runs_snapshot` ON `code_runs` (`snapshot_id`);--> statement-breakpoint
CREATE INDEX `idx_code_runs_status_created` ON `code_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `code_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_answer_id` text NOT NULL,
	`student_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`source` text NOT NULL,
	`code` text NOT NULL,
	`pasted_character_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`submission_answer_id`,`student_id`) REFERENCES `submission_answers`(`id`,`student_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_code_snapshots_pasted_characters_nonnegative" CHECK("code_snapshots"."pasted_character_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_code_snapshots_id_answer` ON `code_snapshots` (`id`,`submission_answer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_code_snapshots_answer_sequence` ON `code_snapshots` (`submission_answer_id`,`sequence_number`);--> statement-breakpoint
CREATE INDEX `idx_code_snapshots_answer_created` ON `code_snapshots` (`submission_answer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_code_snapshots_student_created` ON `code_snapshots` (`student_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `course_class_assignments` (
	`course_id` text NOT NULL,
	`class_id` text NOT NULL,
	`assigned_by_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`course_id`, `class_id`),
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_course_class_assignments_class` ON `course_class_assignments` (`class_id`);--> statement-breakpoint
CREATE TABLE `course_enrollments` (
	`course_id` text NOT NULL,
	`student_id` text NOT NULL,
	`source` text NOT NULL,
	`source_class_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`enrolled_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`left_at` text,
	PRIMARY KEY(`course_id`, `student_id`),
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`student_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_class_id`) REFERENCES `classes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_course_enrollments_student_status` ON `course_enrollments` (`student_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_course_enrollments_course_status` ON `course_enrollments` (`course_id`,`status`);--> statement-breakpoint
CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_teacher_id` text NOT NULL,
	`title_zh` text NOT NULL,
	`title_en` text,
	`description_zh` text,
	`description_en` text,
	`join_code` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_teacher_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_courses_join_code` ON `courses` (`join_code`);--> statement-breakpoint
CREATE INDEX `idx_courses_owner_status` ON `courses` (`owner_teacher_id`,`status`);--> statement-breakpoint
CREATE TABLE `email_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`recipient_email` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider_message_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_email_deliveries_notification` ON `email_deliveries` (`notification_id`);--> statement-breakpoint
CREATE INDEX `idx_email_deliveries_status_next_attempt` ON `email_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `feature_flags` (
	`key` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`config_json` text,
	`updated_by_id` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `file_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`uploaded_by_id` text,
	`storage_key` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`uploaded_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_file_assets_byte_size_nonnegative" CHECK("file_assets"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_file_assets_storage_key` ON `file_assets` (`storage_key`);--> statement-breakpoint
CREATE INDEX `idx_file_assets_uploader_created` ON `file_assets` (`uploaded_by_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_file_assets_status_created` ON `file_assets` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `grades` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`auto_score` real,
	`ai_suggested_score` real,
	`teacher_adjusted_score` real,
	`final_score` real,
	`max_score` real NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`graded_by_id` text,
	`teacher_comment` text,
	`graded_at` text,
	`released_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`graded_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_grades_max_score_nonnegative" CHECK("grades"."max_score" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_grades_submission` ON `grades` (`submission_id`);--> statement-breakpoint
CREATE INDEX `idx_grades_status_released` ON `grades` (`status`,`released_at`);--> statement-breakpoint
CREATE TABLE `learning_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`course_id` text NOT NULL,
	`assignment_id` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`active_seconds` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_learning_sessions_active_nonnegative" CHECK("learning_sessions"."active_seconds" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_learning_sessions_student_started` ON `learning_sessions` (`student_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_learning_sessions_course_started` ON `learning_sessions` (`course_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`created_by_id` text NOT NULL,
	`file_asset_id` text,
	`kind` text NOT NULL,
	`title_zh` text NOT NULL,
	`title_en` text,
	`body_zh` text,
	`body_en` text,
	`source_url` text,
	`position` integer DEFAULT 0 NOT NULL,
	`allow_download` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`ai_review_status` text DEFAULT 'not_applicable' NOT NULL,
	`reviewed_by_id` text,
	`published_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`file_asset_id`) REFERENCES `file_assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_materials_unit_position` ON `materials` (`unit_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_materials_unit_status` ON `materials` (`unit_id`,`status`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`recipient_id` text NOT NULL,
	`announcement_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link_path` text,
	`read_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`announcement_id`) REFERENCES `announcements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_recipient_created` ON `notifications` (`recipient_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notifications_recipient_unread` ON `notifications` (`recipient_id`,`created_at`) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_teacher_id` text NOT NULL,
	`course_id` text NOT NULL,
	`unit_id` text,
	`rubric_id` text,
	`type` text NOT NULL,
	`title_zh` text NOT NULL,
	`title_en` text,
	`prompt_zh` text NOT NULL,
	`prompt_en` text,
	`options_json` text,
	`answer_key_json` text,
	`explanation_zh` text,
	`explanation_en` text,
	`starter_code` text,
	`solution_code` text,
	`required_concepts_json` text,
	`max_score` real DEFAULT 1 NOT NULL,
	`sharing_scope` text DEFAULT 'private' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`ai_review_status` text DEFAULT 'not_applicable' NOT NULL,
	`reviewed_by_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_teacher_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`rubric_id`) REFERENCES `rubrics`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_questions_max_score_nonnegative" CHECK("questions"."max_score" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_questions_id_course` ON `questions` (`id`,`course_id`);--> statement-breakpoint
CREATE INDEX `idx_questions_course_status` ON `questions` (`course_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_questions_owner_status` ON `questions` (`owner_teacher_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_questions_unit_status` ON `questions` (`unit_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_questions_scope_status` ON `questions` (`sharing_scope`,`status`);--> statement-breakpoint
CREATE TABLE `rubric_criteria` (
	`id` text PRIMARY KEY NOT NULL,
	`rubric_id` text NOT NULL,
	`label_zh` text NOT NULL,
	`label_en` text,
	`description_zh` text,
	`description_en` text,
	`weight_percent` real NOT NULL,
	`max_score` real NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`rubric_id`) REFERENCES `rubrics`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_rubric_criteria_weight_range" CHECK("rubric_criteria"."weight_percent" >= 0 AND "rubric_criteria"."weight_percent" <= 100),
	CONSTRAINT "chk_rubric_criteria_max_score_nonnegative" CHECK("rubric_criteria"."max_score" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_rubric_criteria_rubric_position` ON `rubric_criteria` (`rubric_id`,`position`);--> statement-breakpoint
CREATE TABLE `rubrics` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_teacher_id` text NOT NULL,
	`course_id` text,
	`title_zh` text NOT NULL,
	`title_en` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`owner_teacher_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_rubrics_owner_status` ON `rubrics` (`owner_teacher_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_rubrics_course_status` ON `rubrics` (`course_id`,`status`);--> statement-breakpoint
CREATE TABLE `submission_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`assignment_id` text NOT NULL,
	`student_id` text NOT NULL,
	`question_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`answer_text` text,
	`answer_json` text,
	`file_asset_id` text,
	`auto_score` real,
	`ai_suggested_score` real,
	`teacher_score` real,
	`final_score` real,
	`teacher_feedback` text,
	`ai_feedback` text,
	`review_status` text DEFAULT 'not_required' NOT NULL,
	`reviewed_by_id` text,
	`reviewed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`file_asset_id`) REFERENCES `file_assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`submission_id`,`assignment_id`,`student_id`) REFERENCES `submissions`(`id`,`assignment_id`,`student_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignment_id`,`question_id`) REFERENCES `assignment_items`(`assignment_id`,`question_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_submission_answers_submission_question` ON `submission_answers` (`submission_id`,`question_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_submission_answers_id_student` ON `submission_answers` (`id`,`student_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_submission_answers_id_question` ON `submission_answers` (`id`,`question_id`);--> statement-breakpoint
CREATE INDEX `idx_submission_answers_submission_position` ON `submission_answers` (`submission_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_submission_answers_question_review` ON `submission_answers` (`question_id`,`review_status`);--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`student_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`submitted_at` text,
	`is_late` integer DEFAULT false NOT NULL,
	`last_activity_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`student_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "chk_submissions_attempt_positive" CHECK("submissions"."attempt_number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_submissions_id_assignment_student` ON `submissions` (`id`,`assignment_id`,`student_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_submissions_assignment_student_attempt` ON `submissions` (`assignment_id`,`student_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `idx_submissions_assignment_status` ON `submissions` (`assignment_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_submissions_student_status_activity` ON `submissions` (`student_id`,`status`,`last_activity_at`);--> statement-breakpoint
CREATE TABLE `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`sensitivity` text DEFAULT 'admin_only' NOT NULL,
	`updated_by_id` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `test_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`visibility` text NOT NULL,
	`label` text,
	`input_json` text,
	`expected_output` text NOT NULL,
	`comparison_mode` text DEFAULT 'trimmed' NOT NULL,
	`tolerance` real,
	`weight` real DEFAULT 1 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`time_limit_ms` integer,
	`memory_limit_mb` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_test_cases_visibility" CHECK("test_cases"."visibility" IN ('public', 'hidden')),
	CONSTRAINT "chk_test_cases_weight_nonnegative" CHECK("test_cases"."weight" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_test_cases_id_question` ON `test_cases` (`id`,`question_id`);--> statement-breakpoint
CREATE INDEX `idx_test_cases_question_visibility_position` ON `test_cases` (`question_id`,`visibility`,`position`);--> statement-breakpoint
CREATE TABLE `test_results` (
	`id` text PRIMARY KEY NOT NULL,
	`code_run_id` text NOT NULL,
	`test_case_id` text NOT NULL,
	`question_id` text NOT NULL,
	`status` text NOT NULL,
	`actual_output` text,
	`error_message` text,
	`duration_ms` integer,
	`peak_memory_kb` integer,
	`score_awarded` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`code_run_id`,`question_id`) REFERENCES `code_runs`(`id`,`question_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_case_id`,`question_id`) REFERENCES `test_cases`(`id`,`question_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_test_results_run_case` ON `test_results` (`code_run_id`,`test_case_id`);--> statement-breakpoint
CREATE INDEX `idx_test_results_run_status` ON `test_results` (`code_run_id`,`status`);--> statement-breakpoint
CREATE TABLE `units` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`title_zh` text NOT NULL,
	`title_en` text,
	`description_zh` text,
	`description_en` text,
	`position` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_units_course_position` ON `units` (`course_id`,`position`);--> statement-breakpoint
CREATE INDEX `idx_units_course_status` ON `units` (`course_id`,`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`username` text NOT NULL,
	`student_number` text,
	`chinese_name` text NOT NULL,
	`english_name` text,
	`email` text,
	`password_hash` text NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`preferred_locale` text DEFAULT 'zh-Hant' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`last_login_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "chk_users_role" CHECK("users"."role" IN ('admin', 'teacher', 'student')),
	CONSTRAINT "chk_users_failed_login_nonnegative" CHECK("users"."failed_login_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_username` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_student_number` ON `users` (`student_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_role_status` ON `users` (`role`,`status`);