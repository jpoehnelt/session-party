CREATE TABLE `reviewer_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`email` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`accepted_by_user_id` text,
	`delivery_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`accepted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`delivery_id`) REFERENCES `mail_deliveries`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "reviewer_invitations_token_hash_format" CHECK(length("reviewer_invitations"."token_hash") = 64 and "reviewer_invitations"."token_hash" = lower("reviewer_invitations"."token_hash") and "reviewer_invitations"."token_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "reviewer_invitations_version_positive" CHECK("reviewer_invitations"."version" > 0),
	CONSTRAINT "reviewer_invitations_acceptance_state" CHECK(("reviewer_invitations"."status" = 'accepted' and "reviewer_invitations"."accepted_at" is not null and "reviewer_invitations"."accepted_by_user_id" is not null) or ("reviewer_invitations"."status" <> 'accepted' and "reviewer_invitations"."accepted_at" is null and "reviewer_invitations"."accepted_by_user_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviewer_invitations_event_id_unique` ON `reviewer_invitations` (`event_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviewer_invitations_token_hash_unique` ON `reviewer_invitations` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviewer_invitations_pending_email_unique` ON `reviewer_invitations` (`event_id`,`email`) WHERE "reviewer_invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `reviewer_invitations_event_status` ON `reviewer_invitations` (`event_id`,`status`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_review_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`round_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`status` text DEFAULT 'assigned' NOT NULL,
	`recusal_reason` text,
	`recused_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`round_id`) REFERENCES `review_rounds`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`) REFERENCES `submissions`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`reviewer_user_id`) REFERENCES `event_members`(`event_id`,`user_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "review_assignments_version_positive" CHECK("__new_review_assignments"."version" > 0),
	CONSTRAINT "review_assignments_recusal_state" CHECK(("__new_review_assignments"."status" = 'assigned' and "__new_review_assignments"."recusal_reason" is null and "__new_review_assignments"."recused_at" is null) or ("__new_review_assignments"."status" = 'recused' and "__new_review_assignments"."recused_at" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_review_assignments`("id", "event_id", "round_id", "submission_id", "reviewer_user_id", "status", "recusal_reason", "recused_at", "version", "created_at", "updated_at") SELECT "id", "event_id", "round_id", "submission_id", "reviewer_user_id", 'assigned', NULL, NULL, "version", "created_at", "updated_at" FROM `review_assignments`;--> statement-breakpoint
DROP TABLE `review_assignments`;--> statement-breakpoint
ALTER TABLE `__new_review_assignments` RENAME TO `review_assignments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `review_assignments_event_id_unique` ON `review_assignments` (`event_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_assignments_active_pair_unique` ON `review_assignments` (`event_id`,`round_id`,`submission_id`,`reviewer_user_id`) WHERE "review_assignments"."status" = 'assigned';--> statement-breakpoint
CREATE INDEX `review_assignments_reviewer` ON `review_assignments` (`event_id`,`reviewer_user_id`,`round_id`);--> statement-breakpoint
CREATE INDEX `review_assignments_submission` ON `review_assignments` (`event_id`,`submission_id`);--> statement-breakpoint
CREATE INDEX `review_assignments_recusals` ON `review_assignments` (`event_id`,`round_id`,`status`,`recused_at`);
