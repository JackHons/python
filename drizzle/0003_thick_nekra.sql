CREATE TABLE `ai_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_type` text NOT NULL,
	`course_id` text NOT NULL,
	`student_id` text,
	`material_id` text,
	`question_id` text,
	`submission_answer_id` text,
	`content_json` text NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`created_by_id` text NOT NULL,
	`reviewed_by_id` text,
	`review_comment` text,
	`reviewed_at` text,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`student_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`submission_answer_id`) REFERENCES `submission_answers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_ai_artifacts_course_status` ON `ai_artifacts` (`course_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_ai_artifacts_target_status` ON `ai_artifacts` (`student_id`,`status`);--> statement-breakpoint
CREATE TABLE `ai_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_key` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_config_id` text,
	`usage_date` text NOT NULL,
	`reserved_requests` integer DEFAULT 1 NOT NULL,
	`reserved_tokens` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text NOT NULL,
	`settled_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_config_id`) REFERENCES `ai_provider_configs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_reservations_key` ON `ai_reservations` (`reservation_key`);--> statement-breakpoint
CREATE INDEX `idx_ai_reservations_user_date` ON `ai_reservations` (`user_id`,`usage_date`);--> statement-breakpoint
CREATE TABLE `ai_school_daily_quotas` (
	`usage_date` text PRIMARY KEY NOT NULL,
	`reserved_requests` integer DEFAULT 0 NOT NULL,
	`completed_requests` integer DEFAULT 0 NOT NULL,
	`reserved_tokens` integer DEFAULT 0 NOT NULL,
	`used_tokens` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ai_school_daily_quotas_date` ON `ai_school_daily_quotas` (`usage_date`);--> statement-breakpoint
ALTER TABLE `ai_provider_configs` ADD `encryption_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_provider_configs` ADD `key_rotated_at` text;--> statement-breakpoint
ALTER TABLE `ai_settings` ADD `school_daily_request_limit` integer;--> statement-breakpoint
ALTER TABLE `ai_settings` ADD `timezone` text DEFAULT 'Asia/Macau' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `reservation_id` text;