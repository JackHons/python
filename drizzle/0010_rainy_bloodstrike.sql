CREATE TABLE `material_asset_versions` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`root_asset_id` text NOT NULL,
	`previous_asset_id` text,
	`version_number` integer NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `file_assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`root_asset_id`) REFERENCES `file_assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`previous_asset_id`) REFERENCES `file_assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_material_asset_versions_root_number` ON `material_asset_versions` (`root_asset_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_material_asset_versions_root_created` ON `material_asset_versions` (`root_asset_id`,`created_at`);--> statement-breakpoint
INSERT INTO `material_asset_versions` (`asset_id`, `root_asset_id`, `previous_asset_id`, `version_number`, `created_by_id`, `created_at`)
SELECT `id`, `id`, NULL, 1, `uploaded_by_id`, `created_at`
FROM `file_assets`
WHERE `purpose` = 'material_library' AND `uploaded_by_id` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `materials` ADD `asset_binding_mode` text DEFAULT 'reference' NOT NULL;
