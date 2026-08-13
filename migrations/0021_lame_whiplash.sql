CREATE TABLE `review_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`reason` text,
	`status` text DEFAULT 'active' NOT NULL,
	`withdrawn_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`) REFERENCES `submissions`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`reviewer_user_id`) REFERENCES `event_members`(`event_id`,`user_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "review_conflicts_version_positive" CHECK("review_conflicts"."version" > 0),
	CONSTRAINT "review_conflicts_withdrawal_state" CHECK(("review_conflicts"."status" = 'active' and "review_conflicts"."withdrawn_at" is null) or ("review_conflicts"."status" = 'withdrawn' and "review_conflicts"."withdrawn_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_conflicts_event_id_unique` ON `review_conflicts` (`event_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_conflicts_active_pair_unique` ON `review_conflicts` (`event_id`,`submission_id`,`reviewer_user_id`) WHERE "review_conflicts"."status" = 'active';--> statement-breakpoint
CREATE INDEX `review_conflicts_reviewer` ON `review_conflicts` (`event_id`,`reviewer_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `review_conflicts_submission` ON `review_conflicts` (`event_id`,`submission_id`,`status`);