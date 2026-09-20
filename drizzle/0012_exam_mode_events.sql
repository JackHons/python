ALTER TABLE `assignments` ADD `exam_mode` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `exam_events` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`student_id` text NOT NULL,
	`event_type` text NOT NULL,
	`page_path` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`student_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_exam_events_type" CHECK(`event_type` IN ('tab_hidden', 'tab_visible', 'route_blocked', 'focus_lost'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_exam_events_student_submission_key` ON `exam_events` (`student_id`,`submission_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_exam_events_submission_created` ON `exam_events` (`submission_id`,`created_at`);
