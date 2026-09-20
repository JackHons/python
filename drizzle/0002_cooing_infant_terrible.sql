ALTER TABLE `code_runs` ADD `actor_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `code_runs` ADD `student_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `code_runs` ADD `runner_version` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `code_runs` ADD `runner_image` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `code_runs` ADD `limits_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `code_runs` ADD `code_sha256` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `code_snapshots` ADD `sha256` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `test_results` ADD `test_case_snapshot_json` text DEFAULT '{}' NOT NULL;