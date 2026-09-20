CREATE TABLE `classroom_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`course_id` text NOT NULL,
	`assignment_id` text,
	`created_by_id` text NOT NULL,
	`title` text NOT NULL,
	`prompt_json` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`anonymous_answers` integer DEFAULT true NOT NULL,
	`started_at` text,
	`ended_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `classroom_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_classroom_activities_session_status` ON `classroom_activities` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_classroom_activities_assignment_status` ON `classroom_activities` (`assignment_id`,`status`);--> statement-breakpoint
CREATE TABLE `classroom_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`activity_id` text,
	`version` integer NOT NULL,
	`event_type` text NOT NULL,
	`actor_id` text,
	`idempotency_key` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `classroom_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`activity_id`) REFERENCES `classroom_activities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_classroom_events_session_idempotency` ON `classroom_events` (`session_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_classroom_events_session_version` ON `classroom_events` (`session_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_classroom_events_session_version` ON `classroom_events` (`session_id`,`version`);--> statement-breakpoint
CREATE TABLE `classroom_participants` (
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`participant_role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` text,
	`joined_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`session_id`, `user_id`),
	FOREIGN KEY (`session_id`) REFERENCES `classroom_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_classroom_participants_session_status` ON `classroom_participants` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_classroom_participants_user_status` ON `classroom_participants` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `classroom_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`created_by_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`ended_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_classroom_sessions_course_status` ON `classroom_sessions` (`course_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_classroom_sessions_created` ON `classroom_sessions` (`created_by_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `email_deliveries` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `email_deliveries` ADD `body` text;--> statement-breakpoint
ALTER TABLE `email_deliveries` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `email_deliveries` ADD `bounced_at` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `source_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notifications_recipient_source` ON `notifications` (`recipient_id`,`source_key`);