CREATE TABLE `lesson_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lesson_id` integer NOT NULL,
	`user_id` integer,
	`parent_id` integer,
	`body` text NOT NULL,
	`deleted_at` text,
	`removed_by_moderator` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `lesson_comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lesson_comments_lesson_idx` ON `lesson_comments` (`lesson_id`);--> statement-breakpoint
CREATE INDEX `lesson_comments_parent_idx` ON `lesson_comments` (`parent_id`);