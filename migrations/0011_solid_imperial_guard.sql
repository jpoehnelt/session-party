CREATE TABLE `asset_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`event_id`,`asset_id`) REFERENCES `assets`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_comments_event_id_unique` ON `asset_comments` (`event_id`,`id`);--> statement-breakpoint
CREATE INDEX `asset_comments_asset_time` ON `asset_comments` (`event_id`,`asset_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `task_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`task_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`task_id`) REFERENCES `tasks`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`speaker_id`) REFERENCES `speakers`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_assignments_event_id_unique` ON `task_assignments` (`event_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_assignments_pair_unique` ON `task_assignments` (`event_id`,`task_id`,`speaker_id`);--> statement-breakpoint
CREATE INDEX `task_assignments_speaker` ON `task_assignments` (`event_id`,`speaker_id`);--> statement-breakpoint
ALTER TABLE `assets` ADD `speaker_id` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `purpose` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `supersedes_asset_id` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `restored_from_asset_id` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `current` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `assets_speaker_purpose` ON `assets` (`event_id`,`speaker_id`,`purpose`,`current`);--> statement-breakpoint
CREATE TABLE `__new_review_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`order` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`blind` integer DEFAULT false NOT NULL,
	`rubric` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "review_rounds_date_order" CHECK("__new_review_rounds"."starts_at" is null or "__new_review_rounds"."ends_at" is null or "__new_review_rounds"."ends_at" > "__new_review_rounds"."starts_at"),
	CONSTRAINT "review_rounds_version_positive" CHECK("__new_review_rounds"."version" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_review_rounds`("id", "event_id", "name", "order", "status", "starts_at", "ends_at", "blind", "rubric", "version", "created_at", "updated_at") SELECT "id", "event_id", "name", "order", "status", NULL, NULL, 0, "rubric", "version", "created_at", "updated_at" FROM `review_rounds`;--> statement-breakpoint
DROP TABLE `review_rounds`;--> statement-breakpoint
ALTER TABLE `__new_review_rounds` RENAME TO `review_rounds`;--> statement-breakpoint
CREATE UNIQUE INDEX `review_rounds_event_id_unique` ON `review_rounds` (`event_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_rounds_event_order_unique` ON `review_rounds` (`event_id`,`order`);--> statement-breakpoint
ALTER TABLE `speakers` ADD `workflow_status` text DEFAULT 'Invited' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `target_mode` text DEFAULT 'all' NOT NULL;
