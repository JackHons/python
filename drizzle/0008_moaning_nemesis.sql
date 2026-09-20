ALTER TABLE `ai_provider_configs` ADD `api_path` text DEFAULT '/chat/completions' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_provider_configs` ADD `timeout_ms` integer DEFAULT 15000 NOT NULL;
