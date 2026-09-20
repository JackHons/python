CREATE TABLE `material_conversion_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`source_asset_id` text NOT NULL,
	`output_asset_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`material_id`) REFERENCES `materials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_asset_id`) REFERENCES `file_assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`output_asset_id`) REFERENCES `file_assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_material_conversion_jobs_material_created` ON `material_conversion_jobs` (`material_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_material_conversion_jobs_status_created` ON `material_conversion_jobs` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `submission_answers` ADD `question_snapshot_json` text DEFAULT '{}' NOT NULL;