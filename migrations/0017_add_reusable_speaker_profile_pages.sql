CREATE TABLE `speaker_profile_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`profile_version` integer NOT NULL,
	`actor_user_id` text NOT NULL,
	`before` text,
	`after` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `speaker_profiles`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "speaker_profile_changes_version_positive" CHECK("speaker_profile_changes"."profile_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_profile_changes_version_unique` ON `speaker_profile_changes` (`profile_id`,`profile_version`);--> statement-breakpoint
CREATE INDEX `speaker_profile_changes_actor` ON `speaker_profile_changes` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `speaker_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`title` text,
	`company` text,
	`bio` text,
	`headshot_url` text,
	`links` text,
	`visible` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "speaker_profiles_slug_format" CHECK(length("speaker_profiles"."slug") between 3 and 80 and "speaker_profiles"."slug" = lower("speaker_profiles"."slug") and "speaker_profiles"."slug" not glob '*[^a-z0-9-]*'),
	CONSTRAINT "speaker_profiles_version_positive" CHECK("speaker_profiles"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_profiles_user_unique` ON `speaker_profiles` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_profiles_slug_unique` ON `speaker_profiles` (`slug`);--> statement-breakpoint
CREATE INDEX `speaker_profiles_visible` ON `speaker_profiles` (`visible`,`slug`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_acceptance_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`primary_submission_speaker_id` text NOT NULL,
	`primary_speaker_id` text NOT NULL,
	`primary_association_is_primary` integer DEFAULT true NOT NULL,
	`type` text NOT NULL,
	`submission_version` integer NOT NULL,
	`actor_user_id` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`event_id`,`submission_id`,`primary_submission_speaker_id`,`primary_speaker_id`,`primary_association_is_primary`) REFERENCES `submission_speakers`(`event_id`,`submission_id`,`id`,`speaker_id`,`is_primary`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "acceptance_events_version_positive" CHECK("__new_acceptance_events"."submission_version" > 0),
	CONSTRAINT "acceptance_events_primary_association" CHECK("__new_acceptance_events"."primary_association_is_primary" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_acceptance_events`("id", "event_id", "submission_id", "primary_submission_speaker_id", "primary_speaker_id", "primary_association_is_primary", "type", "submission_version", "actor_user_id", "occurred_at") SELECT "id", "event_id", "submission_id", "primary_submission_speaker_id", "primary_speaker_id", "primary_association_is_primary", "type", "submission_version", "actor_user_id", "occurred_at" FROM `acceptance_events`;--> statement-breakpoint
DROP TABLE `acceptance_events`;--> statement-breakpoint
ALTER TABLE `__new_acceptance_events` RENAME TO `acceptance_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_events_event_id_unique` ON `acceptance_events` (`event_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_events_provisioning_parent_unique` ON `acceptance_events` (`event_id`,`id`,`submission_id`,`primary_speaker_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_events_submission_version_unique` ON `acceptance_events` (`event_id`,`submission_id`,`submission_version`);--> statement-breakpoint
CREATE INDEX `acceptance_events_event_cursor` ON `acceptance_events` (`event_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `acceptance_events_primary_speaker` ON `acceptance_events` (`event_id`,`primary_speaker_id`);--> statement-breakpoint
CREATE TABLE `__new_embeds` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`widget` text NOT NULL,
	`preset` text NOT NULL,
	`aesthetic` text DEFAULT 'bold' NOT NULL,
	`accent` text DEFAULT '#7857FF' NOT NULL,
	`track_id` text,
	`track` text,
	`fields` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`track_id`) REFERENCES `tracks`(`event_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "embeds_name_nonempty" CHECK(length(trim("__new_embeds"."name")) > 0),
	CONSTRAINT "embeds_accent_hex" CHECK("__new_embeds"."accent" glob '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'),
	CONSTRAINT "embeds_version_positive" CHECK("__new_embeds"."version" > 0),
	CONSTRAINT "embeds_widget_preset" CHECK(("__new_embeds"."widget" = 'schedule' and "__new_embeds"."preset" in ('sessions', 'agenda', 'itinerary')) or ("__new_embeds"."widget" = 'speakerGallery' and "__new_embeds"."preset" in ('speakerList', 'speakerGallery')))
);
--> statement-breakpoint
INSERT INTO `__new_embeds`("id", "event_id", "name", "widget", "preset", "aesthetic", "accent", "track_id", "track", "fields", "enabled", "version", "created_at", "updated_at") SELECT "id", "event_id", "name", "widget", "preset", "aesthetic", "accent", "track_id", "track", "fields", "enabled", "version", "created_at", "updated_at" FROM `embeds`;--> statement-breakpoint
DROP TABLE `embeds`;--> statement-breakpoint
ALTER TABLE `__new_embeds` RENAME TO `embeds`;--> statement-breakpoint
CREATE UNIQUE INDEX `embeds_event_id_unique` ON `embeds` (`event_id`,`id`);--> statement-breakpoint
CREATE INDEX `embeds_event_updated` ON `embeds` (`event_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `embeds_track` ON `embeds` (`event_id`,`track_id`);--> statement-breakpoint
ALTER TABLE `speakers` ADD `headshot_url` text;--> statement-breakpoint
ALTER TABLE `speakers` ADD `profile_source_id` text REFERENCES `speaker_profiles`(`id`) ON UPDATE cascade ON DELETE set null;--> statement-breakpoint
ALTER TABLE `speakers` ADD `profile_source_version` integer CHECK (`profile_source_version` is null or `profile_source_version` > 0);--> statement-breakpoint
ALTER TABLE `speakers` ADD `profile_review_status` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `speakers` ADD `profile_review_note` text;--> statement-breakpoint
ALTER TABLE `speakers` ADD `profile_submitted_at` integer;--> statement-breakpoint
ALTER TABLE `speakers` ADD `profile_reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `speakers` ADD `profile_reviewed_by` text REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null;--> statement-breakpoint
CREATE INDEX `speakers_profile_source` ON `speakers` (`profile_source_id`);--> statement-breakpoint
CREATE INDEX `speakers_profile_review` ON `speakers` (`event_id`,`profile_review_status`,`visible`);
