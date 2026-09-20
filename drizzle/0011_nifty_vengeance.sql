CREATE TABLE `question_hints` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`level` integer NOT NULL,
	`content_zh` text NOT NULL,
	`content_en` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by_id` text NOT NULL,
	`reviewed_by_id` text,
	`reviewed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reviewed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_question_hints_level_positive" CHECK("question_hints"."level" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_question_hints_question_level` ON `question_hints` (`question_id`,`level`);--> statement-breakpoint
CREATE INDEX `idx_question_hints_question_status` ON `question_hints` (`question_id`,`status`);--> statement-breakpoint
CREATE TABLE `student_hint_unlocks` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`question_id` text NOT NULL,
	`hint_id` text NOT NULL,
	`level` integer NOT NULL,
	`source` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`unlocked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`hint_id`) REFERENCES `question_hints`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_student_hint_unlock_level` ON `student_hint_unlocks` (`student_id`,`submission_id`,`question_id`,`level`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_student_hint_unlock_idempotency` ON `student_hint_unlocks` (`student_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_student_hint_unlock_question_time` ON `student_hint_unlocks` (`question_id`,`unlocked_at`);--> statement-breakpoint
ALTER TABLE `ai_settings` ADD `max_hint_layers` integer DEFAULT 3 NOT NULL;
