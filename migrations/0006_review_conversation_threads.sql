CREATE TABLE `review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`) REFERENCES `submissions`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`author_user_id`) REFERENCES `event_members`(`event_id`,`user_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "review_comments_body_nonempty" CHECK(length(trim("review_comments"."body")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_comments_event_id_unique` ON `review_comments` (`event_id`,`id`);--> statement-breakpoint
CREATE INDEX `review_comments_submission_time` ON `review_comments` (`event_id`,`submission_id`,`created_at`);