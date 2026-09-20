ALTER TABLE `file_assets` ADD `purpose` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `file_assets` ADD `library_scope` text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_file_assets_library_available` ON `file_assets` (`purpose`,`status`,`library_scope`);--> statement-breakpoint
CREATE INDEX `idx_file_assets_owner_sha` ON `file_assets` (`uploaded_by_id`,`sha256`,`purpose`);