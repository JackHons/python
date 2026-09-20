CREATE TABLE `gamification_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`xp_enabled` integer DEFAULT 1 NOT NULL,
	`badges_enabled` integer DEFAULT 1 NOT NULL,
	`streaks_enabled` integer DEFAULT 1 NOT NULL,
	`leaderboard_enabled` integer DEFAULT 1 NOT NULL,
	`updated_by_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `gamification_settings` (`id`) VALUES ('global');
--> statement-breakpoint
CREATE TABLE `gamification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text,
	`event_key` text NOT NULL,
	`event_type` text NOT NULL,
	`xp` integer DEFAULT 0 NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_gamification_events_key` ON `gamification_events` (`event_key`);
--> statement-breakpoint
CREATE INDEX `idx_gamification_events_user_course` ON `gamification_events` (`user_id`,`course_id`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `student_streaks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`current_streak` integer DEFAULT 0 NOT NULL,
	`longest_streak` integer DEFAULT 0 NOT NULL,
	`last_activity_date` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `badge_definitions` (
	`code` text PRIMARY KEY NOT NULL,
	`title_zh` text NOT NULL,
	`title_en` text NOT NULL,
	`description_zh` text NOT NULL,
	`description_en` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
INSERT INTO `badge_definitions` (`code`, `title_zh`, `title_en`, `description_zh`, `description_en`) VALUES
('first_submission', '第一步', 'First step', '完成第一次提交', 'Complete your first submission'),
('streak_3', '三日連續', 'Three-day streak', '連續三日有學習活動', 'Learn for three consecutive days'),
('course_finisher', '課程完成者', 'Course finisher', '在課程中完成一次提交', 'Complete a submission in a course');
--> statement-breakpoint
CREATE TABLE `student_badges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`course_id` text,
	`badge_code` text NOT NULL,
	`awarded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`badge_code`) REFERENCES `badge_definitions`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_student_badges_scope` ON `student_badges` (`user_id`,`course_id`,`badge_code`);
