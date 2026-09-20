ALTER TABLE `export_jobs` ADD `data_snapshot_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `export_jobs` ADD `missing_data_json` text DEFAULT '[]' NOT NULL;