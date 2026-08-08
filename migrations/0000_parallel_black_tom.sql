CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`uploader_user_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_tokens_user` ON `auth_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `email_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`template_id` text,
	`to_user_id` text NOT NULL,
	`subject` text NOT NULL,
	`scheduled_for` integer,
	`sent_at` integer,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_sends_event` ON `email_sends` (`event_id`);--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`attach_ics` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_members` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_members_unique` ON `event_members` (`event_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`location` text,
	`timezone` text DEFAULT 'America/Los_Angeles' NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`banner_asset_id` text,
	`accent_color` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);--> statement-breakpoint
CREATE TABLE `form_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`order` integer NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`help_text` text,
	`required` integer DEFAULT false NOT NULL,
	`options` text,
	`logic` text,
	`routing` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `form_fields_form` ON `form_fields` (`form_id`);--> statement-breakpoint
CREATE TABLE `forms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`opens_at` integer,
	`closes_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`cursor` text,
	`last_sync_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_unique` ON `integrations` (`event_id`,`kind`);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`html_embed` text,
	`audience` text DEFAULT 'speakers' NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_assignments_unique` ON `review_assignments` (`round_id`,`submission_id`,`reviewer_user_id`);--> statement-breakpoint
CREATE TABLE `review_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`order` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rubric` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`round_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`reviewer_user_id` text,
	`ai` integer DEFAULT false NOT NULL,
	`score` real NOT NULL,
	`scores` text,
	`comment` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reviews_submission` ON `reviews` (`submission_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`capacity` integer,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `speakers` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`title` text,
	`company` text,
	`bio` text,
	`headshot_asset_id` text,
	`links` text,
	`visible` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speakers_event_user` ON `speakers` (`event_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `submission_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`field_id` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `submission_answers_submission` ON `submission_answers` (`submission_id`);--> statement-breakpoint
CREATE TABLE `submission_speakers` (
	`id` text PRIMARY KEY NOT NULL,
	`submission_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_speakers_unique` ON `submission_speakers` (`submission_id`,`speaker_id`);--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`form_id` text NOT NULL,
	`title` text NOT NULL,
	`category` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`submitted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `submissions_event` ON `submissions` (`event_id`);--> statement-breakpoint
CREATE INDEX `submissions_form` ON `submissions` (`form_id`);--> statement-breakpoint
CREATE TABLE `talk_speakers` (
	`id` text PRIMARY KEY NOT NULL,
	`talk_id` text NOT NULL,
	`speaker_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `talk_speakers_unique` ON `talk_speakers` (`talk_id`,`speaker_id`);--> statement-breakpoint
CREATE TABLE `talks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`submission_id` text,
	`title` text NOT NULL,
	`description` text,
	`track_id` text,
	`room_id` text,
	`starts_at` integer,
	`duration_min` integer DEFAULT 30 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `talks_event` ON `talks` (`event_id`);--> statement-breakpoint
CREATE TABLE `task_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`completed_at` integer NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_completions_unique` ON `task_completions` (`task_id`,`speaker_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`form_id` text,
	`due_at` integer,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`avatar_asset_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);