CREATE TABLE `code_similarity_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`assignment_id` text NOT NULL,
	`answer_a_id` text NOT NULL,
	`answer_b_id` text NOT NULL,
	`student_a_id` text NOT NULL,
	`student_b_id` text NOT NULL,
	`similarity` real NOT NULL,
	`algorithm_version` text DEFAULT 'token-jaccard-v1' NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`reviewed_by_id` text,
	`review_comment` text,
	`reviewed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`answer_a_id`) REFERENCES `submission_answers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`answer_b_id`) REFERENCES `submission_answers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`student_a_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`student_b_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_code_similarity_status" CHECK(`status` IN ('pending_review', 'confirmed', 'dismissed')),
	CONSTRAINT "chk_code_similarity_score" CHECK(`similarity` >= 0 AND `similarity` <= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_code_similarity_pair` ON `code_similarity_reports` (`assignment_id`,`answer_a_id`,`answer_b_id`);
--> statement-breakpoint
CREATE INDEX `idx_code_similarity_course_status` ON `code_similarity_reports` (`course_id`,`status`);
