CREATE TABLE `export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`requested_by_id` text NOT NULL,
	`report_type` text NOT NULL,
	`format` text NOT NULL,
	`scope_json` text NOT NULL,
	`filter_json` text DEFAULT '{}' NOT NULL,
	`snapshot_at` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Macau' NOT NULL,
	`report_version` text DEFAULT 'v1' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`storage_key` text,
	`sha256` text,
	`byte_size` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`correlation_id` text NOT NULL,
	`expires_at` text,
	`deleted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`requested_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_export_jobs_requester_created` ON `export_jobs` (`requested_by_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_export_jobs_status_created` ON `export_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_export_jobs_expires` ON `export_jobs` (`expires_at`,`status`);