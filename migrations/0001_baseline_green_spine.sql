CREATE TABLE `__baseline_preflight` (
	`orphan_count` integer NOT NULL CONSTRAINT `baseline_preflight_orphans` CHECK (`orphan_count` = 0),
	`duplicate_count` integer NOT NULL CONSTRAINT `baseline_preflight_duplicates` CHECK (`duplicate_count` = 0),
	`invalid_count` integer NOT NULL CONSTRAINT `baseline_preflight_invalid_values` CHECK (`invalid_count` = 0)
);--> statement-breakpoint
INSERT INTO `__baseline_preflight`
SELECT
	(SELECT count(*) FROM `assets` a LEFT JOIN `users` u ON u.id = a.uploader_user_id LEFT JOIN `events` e ON e.id = a.event_id WHERE u.id IS NULL OR (a.event_id IS NOT NULL AND e.id IS NULL))
	+ (SELECT count(*) FROM `event_members` m LEFT JOIN `events` e ON e.id = m.event_id LEFT JOIN `users` u ON u.id = m.user_id WHERE e.id IS NULL OR u.id IS NULL)
	+ (SELECT count(*) FROM `forms` f LEFT JOIN `events` e ON e.id = f.event_id WHERE e.id IS NULL)
	+ (SELECT count(*) FROM `form_fields` ff LEFT JOIN `forms` f ON f.id = ff.form_id WHERE f.id IS NULL)
	+ (SELECT count(*) FROM `integrations` i LEFT JOIN `events` e ON e.id = i.event_id WHERE e.id IS NULL)
	+ (SELECT count(*) FROM `review_rounds` r LEFT JOIN `events` e ON e.id = r.event_id WHERE e.id IS NULL)
	+ (SELECT count(*) FROM `review_assignments` a LEFT JOIN `review_rounds` r ON r.id = a.round_id LEFT JOIN `submissions` s ON s.id = a.submission_id LEFT JOIN `event_members` m ON m.event_id = r.event_id AND m.user_id = a.reviewer_user_id WHERE r.id IS NULL OR s.id IS NULL OR s.event_id <> r.event_id OR m.id IS NULL)
	+ (SELECT count(*) FROM `reviews` v LEFT JOIN `review_rounds` r ON r.id = v.round_id LEFT JOIN `submissions` s ON s.id = v.submission_id LEFT JOIN `event_members` m ON m.event_id = r.event_id AND m.user_id = v.reviewer_user_id WHERE r.id IS NULL OR s.id IS NULL OR s.event_id <> r.event_id OR (v.ai = 0 AND m.id IS NULL))
	+ (SELECT count(*) FROM `speakers` p LEFT JOIN `events` e ON e.id = p.event_id LEFT JOIN `users` u ON u.id = p.user_id WHERE e.id IS NULL OR u.id IS NULL)
	+ (SELECT count(*) FROM `submissions` s LEFT JOIN `events` e ON e.id = s.event_id LEFT JOIN `forms` f ON f.id = s.form_id AND f.event_id = s.event_id WHERE e.id IS NULL OR f.id IS NULL)
	+ (SELECT count(*) FROM `submission_answers` a LEFT JOIN `submissions` s ON s.id = a.submission_id LEFT JOIN `form_fields` f ON f.id = a.field_id WHERE s.id IS NULL OR f.id IS NULL OR f.form_id <> s.form_id)
	+ (SELECT count(*) FROM `submission_speakers` x LEFT JOIN `submissions` s ON s.id = x.submission_id LEFT JOIN `speakers` p ON p.id = x.speaker_id WHERE s.id IS NULL OR p.id IS NULL OR s.event_id <> p.event_id)
	+ (SELECT count(*) FROM `talks` t LEFT JOIN `events` e ON e.id = t.event_id LEFT JOIN `submissions` s ON s.id = t.submission_id LEFT JOIN `tracks` tr ON tr.id = t.track_id LEFT JOIN `rooms` r ON r.id = t.room_id WHERE e.id IS NULL OR (t.submission_id IS NOT NULL AND (s.id IS NULL OR s.event_id <> t.event_id)) OR (t.track_id IS NOT NULL AND (tr.id IS NULL OR tr.event_id <> t.event_id)) OR (t.room_id IS NOT NULL AND (r.id IS NULL OR r.event_id <> t.event_id)))
	+ (SELECT count(*) FROM `talk_speakers` x LEFT JOIN `talks` t ON t.id = x.talk_id LEFT JOIN `speakers` p ON p.id = x.speaker_id WHERE t.id IS NULL OR p.id IS NULL OR t.event_id <> p.event_id)
	+ (SELECT count(*) FROM `task_completions` c LEFT JOIN `tasks` t ON t.id = c.task_id LEFT JOIN `speakers` p ON p.id = c.speaker_id WHERE t.id IS NULL OR p.id IS NULL OR t.event_id <> p.event_id)
	+ (SELECT count(*) FROM `email_sends` s LEFT JOIN `events` e ON e.id = s.event_id LEFT JOIN `users` u ON u.id = s.to_user_id LEFT JOIN `email_templates` t ON t.id = s.template_id WHERE e.id IS NULL OR u.id IS NULL OR (s.template_id IS NOT NULL AND (t.id IS NULL OR t.event_id <> s.event_id)))
	+ (SELECT count(*) FROM `api_keys` k LEFT JOIN `events` e ON e.id = k.event_id WHERE e.id IS NULL OR NOT EXISTS (SELECT 1 FROM `event_members` m WHERE m.event_id = k.event_id)),
	(SELECT count(*) FROM (SELECT 1 FROM `rooms` GROUP BY event_id, name HAVING count(*) > 1))
	+ (SELECT count(*) FROM (SELECT 1 FROM `tracks` GROUP BY event_id, name HAVING count(*) > 1))
	+ (SELECT count(*) FROM (SELECT 1 FROM `pages` GROUP BY event_id, slug HAVING count(*) > 1))
	+ (SELECT count(*) FROM (SELECT 1 FROM `email_templates` GROUP BY event_id, name HAVING count(*) > 1))
	+ (SELECT count(*) FROM (SELECT 1 FROM `review_rounds` GROUP BY event_id, `order` HAVING count(*) > 1))
	+ (SELECT count(*) FROM (SELECT 1 FROM `form_fields` GROUP BY form_id, `order` HAVING count(*) > 1))
	+ (SELECT count(*) FROM (SELECT 1 FROM `submission_speakers` WHERE is_primary = 1 GROUP BY submission_id HAVING count(*) > 1))
	+ (SELECT count(*) FROM (SELECT 1 FROM `reviews` WHERE ai = 0 GROUP BY round_id, submission_id, reviewer_user_id HAVING count(*) > 1)),
	(SELECT count(*) FROM `events` WHERE starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at < starts_at)
	+ (SELECT count(*) FROM `forms` WHERE kind NOT IN ('cfp', 'task') OR status NOT IN ('draft', 'open', 'closed') OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND closes_at < opens_at))
	+ (SELECT count(*) FROM `auth_tokens` WHERE kind NOT IN ('magic_link', 'session'))
	+ (SELECT count(*) FROM `reviews` WHERE score < 0 OR score > 10 OR (ai = 1 AND reviewer_user_id IS NOT NULL) OR (ai = 0 AND reviewer_user_id IS NULL))
	+ (SELECT count(*) FROM `rooms` WHERE capacity IS NOT NULL AND capacity <= 0)
	+ (SELECT count(*) FROM `talks` WHERE duration_min <= 0)
	+ (SELECT count(*) FROM `tasks` WHERE (kind = 'form' AND form_id IS NULL) OR (kind <> 'form' AND form_id IS NOT NULL))
	+ (SELECT count(*) FROM `email_sends` WHERE status NOT IN ('scheduled', 'pending', 'sent', 'failed', 'cancelled'));--> statement-breakpoint
DROP TABLE `__baseline_preflight`;--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `submissions` ADD COLUMN `form_version_id` text;--> statement-breakpoint
UPDATE `submissions` SET `form_version_id` = 'legacy-v1:' || `form_id`;--> statement-breakpoint
ALTER TABLE `submission_speakers` ADD COLUMN `event_id` text;--> statement-breakpoint
UPDATE `submission_speakers`
SET `event_id` = (SELECT s.event_id FROM submissions s WHERE s.id = submission_speakers.submission_id);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_forms_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_forms_event_id` ON `forms` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_integrations_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_integrations_event_id` ON `integrations` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_review_rounds_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_review_rounds_event_id` ON `review_rounds` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_speakers_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_speakers_event_id` ON `speakers` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_submissions_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_submissions_event_id` ON `submissions` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_submissions_version`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_submissions_version` ON `submissions` (`event_id`,`id`,`form_version_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_submission_speakers_tuple`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_submission_speakers_tuple` ON `submission_speakers` (`event_id`,`submission_id`,`id`,`speaker_id`,`is_primary`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_talks_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_talks_event_id` ON `talks` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_tasks_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_tasks_event_id` ON `tasks` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_tracks_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_tracks_event_id` ON `tracks` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_rooms_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_rooms_event_id` ON `rooms` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_email_templates_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_email_templates_event_id` ON `email_templates` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_assets_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_assets_event_id` ON `assets` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_event_members_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_event_members_event_id` ON `event_members` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `__baseline_api_keys_event_id`;--> statement-breakpoint
CREATE UNIQUE INDEX `__baseline_api_keys_event_id` ON `api_keys` (`event_id`,`id`);--> statement-breakpoint
CREATE TABLE `__new_events` (
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
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "events_version_positive" CHECK("version" > 0),
	CONSTRAINT "events_date_order" CHECK("starts_at" is null or "ends_at" is null or "ends_at" >= "starts_at")
);--> statement-breakpoint
INSERT INTO `__new_events`("id", "slug", "name", "description", "location", "timezone", "starts_at", "ends_at", "banner_asset_id", "accent_color", "version", "created_at", "updated_at")
SELECT id, slug, name, description, location, timezone, starts_at, ends_at, banner_asset_id, accent_color, 1, created_at, updated_at FROM `events`;--> statement-breakpoint
ALTER TABLE `events` RENAME TO `__old_events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
DROP INDEX IF EXISTS `events_slug_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`avatar_asset_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "users_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_users`("id", "email", "name", "avatar_asset_id", "version", "created_at", "updated_at")
SELECT id, email, name, avatar_asset_id, 1, created_at, updated_at FROM `users`;--> statement-breakpoint
ALTER TABLE `users` RENAME TO `__old_users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
DROP INDEX IF EXISTS `users_email_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL,
	`response_status` integer,
	`response_body` text,
	`expires_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "idempotency_key_hash_length" CHECK(length("idempotency_records"."key_hash") = 64),
	CONSTRAINT "idempotency_request_hash_length" CHECK(length("idempotency_records"."request_hash") = 64),
	CONSTRAINT "idempotency_completion_state" CHECK(("idempotency_records"."status" = 'in_progress' and "idempotency_records"."completed_at" is null) or ("idempotency_records"."status" <> 'in_progress' and "idempotency_records"."completed_at" is not null))
);--> statement-breakpoint
DROP INDEX IF EXISTS `idempotency_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_event_id_unique` ON `idempotency_records` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `idempotency_key_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_key_unique` ON `idempotency_records` (`event_id`,`operation_id`,`principal_id`,`key_hash`);--> statement-breakpoint
DROP INDEX IF EXISTS `idempotency_cleanup`;--> statement-breakpoint
CREATE INDEX `idempotency_cleanup` ON `idempotency_records` (`expires_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `idempotency_in_progress`;--> statement-breakpoint
CREATE INDEX `idempotency_in_progress` ON `idempotency_records` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_auth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "auth_tokens_hash_format" CHECK(length("token_hash") = 64 and "token_hash" = lower("token_hash") and "token_hash" not glob '*[^0-9a-f]*')
);--> statement-breakpoint
INSERT INTO `__new_auth_tokens`("id", "token_hash", "user_id", "kind", "expires_at", "consumed_at", "created_at")
SELECT id, printf('%064x', rowid), user_id, kind, expires_at, coalesce(consumed_at, created_at), created_at
FROM `auth_tokens`;--> statement-breakpoint
ALTER TABLE `auth_tokens` RENAME TO `__old_auth_tokens`;--> statement-breakpoint
ALTER TABLE `__new_auth_tokens` RENAME TO `auth_tokens`;--> statement-breakpoint
DROP INDEX IF EXISTS `auth_tokens_hash_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_hash_unique` ON `auth_tokens` (`token_hash`);--> statement-breakpoint
DROP INDEX IF EXISTS `auth_tokens_one_pending_magic_link`;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_tokens_one_pending_magic_link` ON `auth_tokens` (`user_id`) WHERE `kind` = 'magic_link' and `consumed_at` is null;--> statement-breakpoint
DROP INDEX IF EXISTS `auth_tokens_user_kind`;--> statement-breakpoint
CREATE INDEX `auth_tokens_user_kind` ON `auth_tokens` (`user_id`,`kind`);--> statement-breakpoint
DROP INDEX IF EXISTS `auth_tokens_expiry_cleanup`;--> statement-breakpoint
CREATE INDEX `auth_tokens_expiry_cleanup` ON `auth_tokens` (`expires_at`,`consumed_at`);--> statement-breakpoint
CREATE TABLE `__new_event_members` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "event_members_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_event_members`("id", "event_id", "user_id", "role", "version", "created_at", "updated_at")
SELECT id, event_id, user_id, role, 1, created_at, updated_at FROM `event_members`;--> statement-breakpoint
ALTER TABLE `event_members` RENAME TO `__old_event_members`;--> statement-breakpoint
ALTER TABLE `__new_event_members` RENAME TO `event_members`;--> statement-breakpoint
DROP INDEX IF EXISTS `event_members_event_user_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `event_members_event_user_unique` ON `event_members` (`event_id`,`user_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `event_members_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `event_members_event_id_unique` ON `event_members` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `event_members_user`;--> statement-breakpoint
CREATE INDEX `event_members_user` ON `event_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`secret_ref` text NOT NULL,
	`config` text NOT NULL,
	`cursor` text,
	`last_sync_at` integer,
	`last_error` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "integrations_secret_ref_nonempty" CHECK(length("secret_ref") > 0),
	CONSTRAINT "integrations_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_integrations`("id", "event_id", "kind", "secret_ref", "config", "cursor", "last_sync_at", "last_error", "version", "created_at", "updated_at")
SELECT id, event_id, kind, 'legacy-disabled:' || id, config, cursor, last_sync_at, last_error, 1, created_at, updated_at FROM `integrations`;--> statement-breakpoint
ALTER TABLE `integrations` RENAME TO `__old_integrations`;--> statement-breakpoint
ALTER TABLE `__new_integrations` RENAME TO `integrations`;--> statement-breakpoint
DROP INDEX IF EXISTS `integrations_event_kind_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_event_kind_unique` ON `integrations` (`event_id`,`kind`);--> statement-breakpoint
DROP INDEX IF EXISTS `integrations_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_event_id_unique` ON `integrations` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `integrations_secret_ref`;--> statement-breakpoint
CREATE INDEX `integrations_secret_ref` ON `integrations` (`secret_ref`);--> statement-breakpoint
CREATE TABLE `__new_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "api_keys_hash_format" CHECK(length("key_hash") = 64 and "key_hash" = lower("key_hash") and "key_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "api_keys_scopes_json" CHECK(json_valid("scopes") and json_type("scopes") = 'array' and json_array_length("scopes") > 0),
	CONSTRAINT "api_keys_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
ALTER TABLE `api_keys` RENAME TO `__old_api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
DROP INDEX IF EXISTS `api_keys_hash_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
DROP INDEX IF EXISTS `api_keys_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_event_id_unique` ON `api_keys` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `api_keys_event_active`;--> statement-breakpoint
CREATE INDEX `api_keys_event_active` ON `api_keys` (`event_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `api_keys_creator`;--> statement-breakpoint
CREATE INDEX `api_keys_creator` ON `api_keys` (`created_by`);--> statement-breakpoint
CREATE TRIGGER `api_keys_scopes_insert`
BEFORE INSERT ON `api_keys`
WHEN CASE
	WHEN json_valid(NEW.scopes) = 0 THEN 1
	WHEN json_type(NEW.scopes) <> 'array' THEN 1
	WHEN json_array_length(NEW.scopes) = 0 THEN 1
	ELSE EXISTS (
		SELECT 1
		FROM json_each(NEW.scopes)
		WHERE type <> 'text'
			OR value NOT IN (
				'event:read', 'event:write',
				'forms:read', 'forms:write',
				'submissions:read', 'submissions:write',
				'speakers:read', 'speakers:write',
				'reviews:read', 'reviews:write',
				'agenda:read', 'agenda:write',
				'communications:read', 'communications:write',
				'content:read', 'content:write',
				'integrations:read', 'integrations:write',
				'audit:read'
			)
	)
END
BEGIN
	SELECT raise(ABORT, 'api_keys scopes must be a nonempty array of known scopes');
END;--> statement-breakpoint
CREATE TRIGGER `api_keys_scopes_update`
BEFORE UPDATE OF `scopes` ON `api_keys`
WHEN CASE
	WHEN json_valid(NEW.scopes) = 0 THEN 1
	WHEN json_type(NEW.scopes) <> 'array' THEN 1
	WHEN json_array_length(NEW.scopes) = 0 THEN 1
	ELSE EXISTS (
		SELECT 1
		FROM json_each(NEW.scopes)
		WHERE type <> 'text'
			OR value NOT IN (
				'event:read', 'event:write',
				'forms:read', 'forms:write',
				'submissions:read', 'submissions:write',
				'speakers:read', 'speakers:write',
				'reviews:read', 'reviews:write',
				'agenda:read', 'agenda:write',
				'communications:read', 'communications:write',
				'content:read', 'content:write',
				'integrations:read', 'integrations:write',
				'audit:read'
			)
	)
END
BEGIN
	SELECT raise(ABORT, 'api_keys scopes must be a nonempty array of known scopes');
END;--> statement-breakpoint
CREATE TABLE `__new_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`uploader_user_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`uploader_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "assets_size_nonnegative" CHECK("size" >= 0),
	CONSTRAINT "assets_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_assets`("id", "event_id", "uploader_user_id", "filename", "content_type", "size", "version", "created_at", "updated_at")
SELECT id, event_id, uploader_user_id, filename, content_type, size, 1, created_at, updated_at FROM `assets`;--> statement-breakpoint
ALTER TABLE `assets` RENAME TO `__old_assets`;--> statement-breakpoint
ALTER TABLE `__new_assets` RENAME TO `assets`;--> statement-breakpoint
DROP INDEX IF EXISTS `assets_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `assets_event_id_unique` ON `assets` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `assets_event`;--> statement-breakpoint
CREATE INDEX `assets_event` ON `assets` (`event_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `assets_uploader`;--> statement-breakpoint
CREATE INDEX `assets_uploader` ON `assets` (`uploader_user_id`);--> statement-breakpoint
CREATE TABLE `__new_email_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`attach_ics` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "email_templates_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_email_templates`("id", "event_id", "name", "subject", "body", "attach_ics", "version", "created_at", "updated_at")
SELECT id, event_id, name, subject, body, attach_ics, 1, created_at, updated_at FROM `email_templates`;--> statement-breakpoint
ALTER TABLE `email_templates` RENAME TO `__old_email_templates`;--> statement-breakpoint
ALTER TABLE `__new_email_templates` RENAME TO `email_templates`;--> statement-breakpoint
DROP INDEX IF EXISTS `email_templates_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `email_templates_event_id_unique` ON `email_templates` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `email_templates_event_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `email_templates_event_name_unique` ON `email_templates` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `__new_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`opens_at` integer,
	`closes_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "forms_version_positive" CHECK("version" > 0),
	CONSTRAINT "forms_date_order" CHECK("opens_at" is null or "closes_at" is null or "closes_at" >= "opens_at")
);--> statement-breakpoint
INSERT INTO `__new_forms`("id", "event_id", "kind", "name", "description", "status", "opens_at", "closes_at", "version", "created_at", "updated_at")
SELECT id, event_id, kind, name, description, status, opens_at, closes_at, 1, created_at, updated_at FROM `forms`;--> statement-breakpoint
ALTER TABLE `forms` RENAME TO `__old_forms`;--> statement-breakpoint
ALTER TABLE `__new_forms` RENAME TO `forms`;--> statement-breakpoint
DROP INDEX IF EXISTS `forms_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `forms_event_id_unique` ON `forms` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `forms_event_status`;--> statement-breakpoint
CREATE INDEX `forms_event_status` ON `forms` (`event_id`,`status`);--> statement-breakpoint
CREATE TABLE `__new_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`html_embed` text,
	`audience` text DEFAULT 'speakers' NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "pages_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_pages`("id", "event_id", "slug", "title", "body", "html_embed", "audience", "order", "version", "created_at", "updated_at")
SELECT id, event_id, slug, title, body, html_embed, audience, `order`, 1, created_at, updated_at FROM `pages`;--> statement-breakpoint
ALTER TABLE `pages` RENAME TO `__old_pages`;--> statement-breakpoint
ALTER TABLE `__new_pages` RENAME TO `pages`;--> statement-breakpoint
DROP INDEX IF EXISTS `pages_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `pages_event_id_unique` ON `pages` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `pages_event_slug_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `pages_event_slug_unique` ON `pages` (`event_id`,`slug`);--> statement-breakpoint
CREATE TABLE `__new_review_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`order` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rubric` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "review_rounds_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_review_rounds`("id", "event_id", "name", "order", "status", "rubric", "version", "created_at", "updated_at")
SELECT id, event_id, name, `order`, status, rubric, 1, created_at, updated_at FROM `review_rounds`;--> statement-breakpoint
ALTER TABLE `review_rounds` RENAME TO `__old_review_rounds`;--> statement-breakpoint
ALTER TABLE `__new_review_rounds` RENAME TO `review_rounds`;--> statement-breakpoint
DROP INDEX IF EXISTS `review_rounds_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `review_rounds_event_id_unique` ON `review_rounds` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `review_rounds_event_order_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `review_rounds_event_order_unique` ON `review_rounds` (`event_id`,`order`);--> statement-breakpoint
CREATE TABLE `__new_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`capacity` integer,
	`order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "rooms_capacity_positive" CHECK("capacity" is null or "capacity" > 0),
	CONSTRAINT "rooms_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_rooms`("id", "event_id", "name", "capacity", "order", "version", "created_at", "updated_at")
SELECT id, event_id, name, capacity, `order`, 1, created_at, updated_at FROM `rooms`;--> statement-breakpoint
ALTER TABLE `rooms` RENAME TO `__old_rooms`;--> statement-breakpoint
ALTER TABLE `__new_rooms` RENAME TO `rooms`;--> statement-breakpoint
DROP INDEX IF EXISTS `rooms_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_event_id_unique` ON `rooms` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `rooms_event_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_event_name_unique` ON `rooms` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `__new_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "tracks_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_tracks`("id", "event_id", "name", "color", "order", "version", "created_at", "updated_at")
SELECT id, event_id, name, color, `order`, 1, created_at, updated_at FROM `tracks`;--> statement-breakpoint
ALTER TABLE `tracks` RENAME TO `__old_tracks`;--> statement-breakpoint
ALTER TABLE `__new_tracks` RENAME TO `tracks`;--> statement-breakpoint
DROP INDEX IF EXISTS `tracks_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_event_id_unique` ON `tracks` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `tracks_event_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_event_name_unique` ON `tracks` (`event_id`,`name`);--> statement-breakpoint
CREATE TABLE `airtable_dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`error_code` text NOT NULL,
	`error_message` text NOT NULL,
	`evidence` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by_user_id` text,
	`resolution` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`event_id`,`integration_id`) REFERENCES `integrations`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "airtable_dead_resolution_pair" CHECK(("airtable_dead_letters"."resolved_at" is null) = ("airtable_dead_letters"."resolution" is null))
);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_dead_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_dead_event_id_unique` ON `airtable_dead_letters` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_dead_source_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_dead_source_unique` ON `airtable_dead_letters` (`integration_id`,`source_type`,`source_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_dead_unresolved`;--> statement-breakpoint
CREATE INDEX `airtable_dead_unresolved` ON `airtable_dead_letters` (`event_id`,`resolved_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `airtable_refresh_state` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`requested_at` integer,
	`due_at` integer,
	`lease_owner` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`cursor` text,
	`last_success_at` integer,
	`last_error` text,
	`dead_lettered_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`integration_id`) REFERENCES `integrations`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "airtable_refresh_attempts_nonnegative" CHECK("airtable_refresh_state"."attempt_count" >= 0),
	CONSTRAINT "airtable_refresh_lease_pair" CHECK(("airtable_refresh_state"."lease_owner" is null) = ("airtable_refresh_state"."lease_expires_at" is null)),
	CONSTRAINT "airtable_refresh_dead_state" CHECK(("airtable_refresh_state"."status" = 'dead_letter' and "airtable_refresh_state"."dead_lettered_at" is not null) or "airtable_refresh_state"."status" <> 'dead_letter'),
	CONSTRAINT "airtable_refresh_version_positive" CHECK("airtable_refresh_state"."version" > 0)
);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_refresh_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_refresh_event_id_unique` ON `airtable_refresh_state` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_refresh_entity_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_refresh_entity_unique` ON `airtable_refresh_state` (`event_id`,`integration_id`,`entity_type`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_refresh_claim`;--> statement-breakpoint
CREATE INDEX `airtable_refresh_claim` ON `airtable_refresh_state` (`integration_id`,`status`,`due_at`,`lease_expires_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_refresh_staleness`;--> statement-breakpoint
CREATE INDEX `airtable_refresh_staleness` ON `airtable_refresh_state` (`integration_id`,`entity_type`,`last_success_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`request_id` text NOT NULL,
	`actor_user_id` text,
	`actor_api_key_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`before` text,
	`after` text,
	`metadata` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`actor_api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE cascade ON DELETE set null
);--> statement-breakpoint
DROP INDEX IF EXISTS `audit_log_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_event_id_unique` ON `audit_log` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `audit_log_event_time`;--> statement-breakpoint
CREATE INDEX `audit_log_event_time` ON `audit_log` (`event_id`,`occurred_at`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `audit_log_resource`;--> statement-breakpoint
CREATE INDEX `audit_log_resource` ON `audit_log` (`event_id`,`resource_type`,`resource_id`,`occurred_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `audit_log_request`;--> statement-breakpoint
CREATE INDEX `audit_log_request` ON `audit_log` (`request_id`);--> statement-breakpoint
CREATE TABLE `domain_changes` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`event_id` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`aggregate_version` integer NOT NULL,
	`event_type` text NOT NULL,
	`audiences` text NOT NULL,
	`payload` text NOT NULL,
	`actor_user_id` text,
	`actor_api_key_id` text,
	`request_id` text NOT NULL,
	`idempotency_record_id` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`actor_api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`event_id`,`idempotency_record_id`) REFERENCES `idempotency_records`(`event_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "domain_changes_version_positive" CHECK("domain_changes"."aggregate_version" > 0)
);--> statement-breakpoint
DROP INDEX IF EXISTS `domain_changes_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `domain_changes_id_unique` ON `domain_changes` (`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `domain_changes_aggregate_version_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `domain_changes_aggregate_version_unique` ON `domain_changes` (`event_id`,`aggregate_type`,`aggregate_id`,`aggregate_version`,`event_type`);--> statement-breakpoint
DROP INDEX IF EXISTS `domain_changes_event_cursor`;--> statement-breakpoint
CREATE INDEX `domain_changes_event_cursor` ON `domain_changes` (`event_id`,`sequence`);--> statement-breakpoint
DROP INDEX IF EXISTS `domain_changes_request`;--> statement-breakpoint
CREATE INDEX `domain_changes_request` ON `domain_changes` (`request_id`);--> statement-breakpoint
CREATE TABLE `form_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`form_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`published_at` integer NOT NULL,
	`retired_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`form_id`) REFERENCES `forms`(`event_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "form_versions_number_positive" CHECK("form_versions"."version_number" > 0),
	CONSTRAINT "form_versions_retired_after_publish" CHECK("form_versions"."retired_at" is null or "form_versions"."retired_at" >= "form_versions"."published_at")
);--> statement-breakpoint
DROP INDEX IF EXISTS `form_versions_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `form_versions_event_id_unique` ON `form_versions` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `form_versions_event_form_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `form_versions_event_form_id_unique` ON `form_versions` (`event_id`,`form_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `form_versions_number_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `form_versions_number_unique` ON `form_versions` (`event_id`,`form_id`,`version_number`);--> statement-breakpoint
DROP INDEX IF EXISTS `form_versions_current`;--> statement-breakpoint
CREATE INDEX `form_versions_current` ON `form_versions` (`event_id`,`form_id`,`retired_at`);--> statement-breakpoint
INSERT INTO `form_versions` (
	`id`, `event_id`, `form_id`, `version_number`, `name`, `description`, `published_at`, `retired_at`, `created_at`
)
SELECT 'legacy-v1:' || f.id, f.event_id, f.id, 1, f.name, f.description, f.created_at, NULL, f.created_at
FROM `forms` f;--> statement-breakpoint
CREATE TABLE `mail_delivery_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`template_id` text,
	`recipient_user_id` text,
	`recipient_email` text NOT NULL,
	`recipient_name` text,
	`from_email` text NOT NULL,
	`reply_to_email` text,
	`subject` text NOT NULL,
	`rendered_html` text,
	`rendered_text` text,
	`ics_filename` text,
	`ics_content` text,
	`redacted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`event_id`,`template_id`) REFERENCES `email_templates`(`event_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "mail_snapshots_template_event" CHECK("template_id" is null or "event_id" is not null),
	CONSTRAINT "mail_snapshots_ics_pair" CHECK(("mail_delivery_snapshots"."ics_filename" is null) = ("mail_delivery_snapshots"."ics_content" is null)),
	CONSTRAINT "mail_snapshots_content_state" CHECK(("redacted_at" is null and "rendered_html" is not null) or ("redacted_at" is not null and "rendered_html" is null and "rendered_text" is null and "ics_filename" is null and "ics_content" is null))
);--> statement-breakpoint
DROP INDEX IF EXISTS `mail_snapshots_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_snapshots_event_id_unique` ON `mail_delivery_snapshots` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `mail_snapshots_retention`;--> statement-breakpoint
CREATE INDEX `mail_snapshots_retention` ON `mail_delivery_snapshots` (`redacted_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_speakers` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text,
	`display_name` text NOT NULL,
	`title` text,
	`company` text,
	`bio` text,
	`headshot_asset_id` text,
	`links` text,
	`visible` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`event_id`,`headshot_asset_id`) REFERENCES `assets`(`event_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "speakers_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_speakers`("id", "event_id", "user_id", "display_name", "title", "company", "bio", "headshot_asset_id", "links", "visible", "version", "created_at", "updated_at")
SELECT id, event_id, user_id, display_name, title, company, bio, headshot_asset_id, links, visible, 1, created_at, updated_at FROM `speakers`;--> statement-breakpoint
ALTER TABLE `speakers` RENAME TO `__old_speakers`;--> statement-breakpoint
ALTER TABLE `__new_speakers` RENAME TO `speakers`;--> statement-breakpoint
DROP INDEX IF EXISTS `speakers_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `speakers_event_id_unique` ON `speakers` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `speakers_event_user_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `speakers_event_user_unique` ON `speakers` (`event_id`,`user_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `speakers_event_visible`;--> statement-breakpoint
CREATE INDEX `speakers_event_visible` ON `speakers` (`event_id`,`visible`);--> statement-breakpoint
DROP INDEX IF EXISTS `speakers_user`;--> statement-breakpoint
CREATE INDEX `speakers_user` ON `speakers` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_form_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`form_id` text NOT NULL,
	`order` integer NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`help_text` text,
	`semantic_key` text,
	`required` integer DEFAULT false NOT NULL,
	`options` text,
	`logic` text,
	`routing` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`form_id`) REFERENCES `forms`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "form_fields_semantic_key" CHECK(`semantic_key` is null or `semantic_key` in ('submissionTitle', 'submissionAbstract', 'speakerName', 'speakerEmail')),
	CONSTRAINT "form_fields_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_form_fields`("id", "event_id", "form_id", "order", "type", "label", "help_text", "semantic_key", "required", "options", "logic", "routing", "version", "created_at", "updated_at")
SELECT ff.id, f.event_id, ff.form_id, ff.`order`, ff.type, ff.label, ff.help_text, NULL, ff.required, ff.options, ff.logic, ff.routing, 1, ff.created_at, ff.updated_at
FROM `form_fields` ff JOIN `forms` f ON f.id = ff.form_id;--> statement-breakpoint
ALTER TABLE `form_fields` RENAME TO `__old_form_fields`;--> statement-breakpoint
ALTER TABLE `__new_form_fields` RENAME TO `form_fields`;--> statement-breakpoint
DROP INDEX IF EXISTS `form_fields_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `form_fields_event_id_unique` ON `form_fields` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `form_fields_form_order_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `form_fields_form_order_unique` ON `form_fields` (`event_id`,`form_id`,`order`);--> statement-breakpoint
DROP INDEX IF EXISTS `form_fields_semantic_key_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `form_fields_semantic_key_unique` ON `form_fields` (`event_id`,`form_id`,`semantic_key`) WHERE `semantic_key` is not null;--> statement-breakpoint
DROP INDEX IF EXISTS `form_fields_form`;--> statement-breakpoint
CREATE INDEX `form_fields_form` ON `form_fields` (`event_id`,`form_id`);--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`form_id` text,
	`due_at` integer,
	`order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`form_id`) REFERENCES `forms`(`event_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "tasks_form_kind" CHECK(("kind" = 'form' and "form_id" is not null) or ("kind" <> 'form' and "form_id" is null)),
	CONSTRAINT "tasks_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "event_id", "name", "description", "kind", "form_id", "due_at", "order", "version", "created_at", "updated_at")
SELECT id, event_id, name, description, kind, form_id, due_at, `order`, 1, created_at, updated_at FROM `tasks`;--> statement-breakpoint
ALTER TABLE `tasks` RENAME TO `__old_tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_event_id_unique` ON `tasks` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `tasks_event_order`;--> statement-breakpoint
CREATE INDEX `tasks_event_order` ON `tasks` (`event_id`,`order`);--> statement-breakpoint
CREATE TABLE `form_version_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`form_version_id` text NOT NULL,
	`source_field_id` text,
	`order` integer NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`help_text` text,
	`semantic_key` text,
	`required` integer NOT NULL,
	`options` text,
	`logic` text,
	`routing` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`form_version_id`) REFERENCES `form_versions`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "form_version_fields_semantic_key" CHECK(`semantic_key` is null or `semantic_key` in ('submissionTitle', 'submissionAbstract', 'speakerName', 'speakerEmail'))
);--> statement-breakpoint
DROP INDEX IF EXISTS `form_version_fields_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `form_version_fields_event_id_unique` ON `form_version_fields` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `form_version_fields_event_version_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `form_version_fields_event_version_id_unique` ON `form_version_fields` (`event_id`,`form_version_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `form_version_fields_order_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `form_version_fields_order_unique` ON `form_version_fields` (`event_id`,`form_version_id`,`order`);--> statement-breakpoint
DROP INDEX IF EXISTS `form_version_fields_semantic_key_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `form_version_fields_semantic_key_unique` ON `form_version_fields` (`event_id`,`form_version_id`,`semantic_key`) WHERE `semantic_key` is not null;--> statement-breakpoint
DROP INDEX IF EXISTS `form_version_fields_version`;--> statement-breakpoint
CREATE INDEX `form_version_fields_version` ON `form_version_fields` (`event_id`,`form_version_id`);--> statement-breakpoint
INSERT INTO `form_version_fields` (
	`id`, `event_id`, `form_version_id`, `source_field_id`, `order`, `type`, `label`, `help_text`, `semantic_key`, `required`, `options`, `logic`, `routing`, `created_at`
)
SELECT ff.id, f.event_id, 'legacy-v1:' || f.id, ff.id, ff.`order`, ff.type, ff.label, ff.help_text, NULL, ff.required, ff.options, ff.logic, ff.routing, ff.created_at
FROM `form_fields` ff
JOIN `forms` f ON f.id = ff.form_id;--> statement-breakpoint
CREATE TABLE `mail_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL REFERENCES `mail_delivery_snapshots`(`id`) ON UPDATE cascade ON DELETE cascade,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`scheduled_for` integer NOT NULL,
	`available_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`provider` text DEFAULT 'resend' NOT NULL,
	`provider_message_id` text,
	`provider_result` text,
	`last_error` text,
	`sent_at` integer,
	`dead_lettered_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "mail_deliveries_attempts" CHECK("mail_deliveries"."attempt_count" >= 0 and "mail_deliveries"."max_attempts" > 0 and "mail_deliveries"."attempt_count" <= "mail_deliveries"."max_attempts"),
	CONSTRAINT "mail_deliveries_lease_pair" CHECK(("mail_deliveries"."lease_owner" is null) = ("mail_deliveries"."lease_expires_at" is null)),
	CONSTRAINT "mail_deliveries_sent_state" CHECK(("mail_deliveries"."status" = 'sent' and "mail_deliveries"."sent_at" is not null and "mail_deliveries"."provider_message_id" is not null) or "mail_deliveries"."status" <> 'sent'),
	CONSTRAINT "mail_deliveries_dead_state" CHECK(("mail_deliveries"."status" = 'dead_letter' and "mail_deliveries"."dead_lettered_at" is not null) or "mail_deliveries"."status" <> 'dead_letter')
);--> statement-breakpoint
DROP INDEX IF EXISTS `mail_deliveries_snapshot_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_deliveries_snapshot_unique` ON `mail_deliveries` (`snapshot_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `mail_deliveries_idempotency_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_deliveries_idempotency_unique` ON `mail_deliveries` (`idempotency_key`);--> statement-breakpoint
DROP INDEX IF EXISTS `mail_deliveries_provider_message_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_deliveries_provider_message_unique` ON `mail_deliveries` (`provider`,`provider_message_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `mail_deliveries_claim`;--> statement-breakpoint
CREATE INDEX `mail_deliveries_claim` ON `mail_deliveries` (`status`,`available_at`,`lease_expires_at`,`created_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `mail_deliveries_status`;--> statement-breakpoint
CREATE INDEX `mail_deliveries_status` ON `mail_deliveries` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`form_id` text NOT NULL,
	`form_version_id` text NOT NULL,
	`title` text NOT NULL,
	`category` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`submitted_at` integer NOT NULL,
	`accepted_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`form_id`) REFERENCES `forms`(`event_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`event_id`,`form_id`,`form_version_id`) REFERENCES `form_versions`(`event_id`,`form_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "submissions_version_positive" CHECK("version" > 0),
	CONSTRAINT "submissions_acceptance_state" CHECK(("status" = 'accepted' and "accepted_at" is not null) or ("status" <> 'accepted'))
);--> statement-breakpoint
INSERT INTO `__new_submissions`("id", "event_id", "form_id", "form_version_id", "title", "category", "status", "submitted_at", "accepted_at", "version", "created_at", "updated_at")
SELECT id, event_id, form_id, 'legacy-v1:' || form_id, title, category, status, submitted_at, iif(status = 'accepted', submitted_at, NULL), 1, created_at, updated_at
FROM `submissions`;--> statement-breakpoint
ALTER TABLE `submissions` RENAME TO `__old_submissions`;--> statement-breakpoint
ALTER TABLE `__new_submissions` RENAME TO `submissions`;--> statement-breakpoint
DROP INDEX IF EXISTS `submissions_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_event_id_unique` ON `submissions` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `submissions_event_id_version_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `submissions_event_id_version_unique` ON `submissions` (`event_id`,`id`,`form_version_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `submissions_event_status`;--> statement-breakpoint
CREATE INDEX `submissions_event_status` ON `submissions` (`event_id`,`status`,`submitted_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `submissions_form`;--> statement-breakpoint
CREATE INDEX `submissions_form` ON `submissions` (`event_id`,`form_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `submissions_form_version`;--> statement-breakpoint
CREATE INDEX `submissions_form_version` ON `submissions` (`event_id`,`form_version_id`);--> statement-breakpoint
CREATE TABLE `__new_task_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`task_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`completed_at` integer NOT NULL,
	`data` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`task_id`) REFERENCES `tasks`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`speaker_id`) REFERENCES `speakers`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "task_completions_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_task_completions`("id", "event_id", "task_id", "speaker_id", "completed_at", "data", "version", "created_at", "updated_at")
SELECT c.id, t.event_id, c.task_id, c.speaker_id, c.completed_at, c.data, 1, c.completed_at, c.completed_at
FROM `task_completions` c JOIN `tasks` t ON t.id = c.task_id;--> statement-breakpoint
ALTER TABLE `task_completions` RENAME TO `__old_task_completions`;--> statement-breakpoint
ALTER TABLE `__new_task_completions` RENAME TO `task_completions`;--> statement-breakpoint
DROP INDEX IF EXISTS `task_completions_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `task_completions_event_id_unique` ON `task_completions` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `task_completions_pair_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `task_completions_pair_unique` ON `task_completions` (`event_id`,`task_id`,`speaker_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `task_completions_speaker`;--> statement-breakpoint
CREATE INDEX `task_completions_speaker` ON `task_completions` (`event_id`,`speaker_id`);--> statement-breakpoint
CREATE TABLE `mail_delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL REFERENCES `mail_deliveries`(`id`) ON UPDATE cascade ON DELETE cascade,
	`attempt_number` integer NOT NULL,
	`lease_owner` text NOT NULL,
	`status` text NOT NULL,
	`provider_message_id` text,
	`provider_result` text,
	`error` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "mail_attempts_number_positive" CHECK("mail_delivery_attempts"."attempt_number" > 0),
	CONSTRAINT "mail_attempts_completion" CHECK("mail_delivery_attempts"."status" = 'started' or "mail_delivery_attempts"."completed_at" is not null)
);--> statement-breakpoint
DROP INDEX IF EXISTS `mail_attempts_number_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_attempts_number_unique` ON `mail_delivery_attempts` (`delivery_id`,`attempt_number`);--> statement-breakpoint
DROP INDEX IF EXISTS `mail_attempts_delivery`;--> statement-breakpoint
CREATE INDEX `mail_attempts_delivery` ON `mail_delivery_attempts` (`delivery_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `__new_submission_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`form_version_id` text NOT NULL,
	`form_version_field_id` text NOT NULL,
	`value` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`,`form_version_id`) REFERENCES `submissions`(`event_id`,`id`,`form_version_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`form_version_id`,`form_version_field_id`) REFERENCES `form_version_fields`(`event_id`,`form_version_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "submission_answers_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_submission_answers`("id", "event_id", "submission_id", "form_version_id", "form_version_field_id", "value", "version", "created_at", "updated_at")
SELECT a.id, s.event_id, a.submission_id, 'legacy-v1:' || s.form_id, a.field_id, a.value, 1, s.created_at, s.updated_at
FROM `submission_answers` a
JOIN `submissions` s ON s.id = a.submission_id;--> statement-breakpoint
ALTER TABLE `submission_answers` RENAME TO `__old_submission_answers`;--> statement-breakpoint
ALTER TABLE `__new_submission_answers` RENAME TO `submission_answers`;--> statement-breakpoint
DROP INDEX IF EXISTS `submission_answers_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `submission_answers_event_id_unique` ON `submission_answers` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `submission_answers_field_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `submission_answers_field_unique` ON `submission_answers` (`event_id`,`submission_id`,`form_version_id`,`form_version_field_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `submission_answers_submission`;--> statement-breakpoint
CREATE INDEX `submission_answers_submission` ON `submission_answers` (`event_id`,`submission_id`);--> statement-breakpoint
CREATE TABLE `__new_review_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`round_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`round_id`) REFERENCES `review_rounds`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`) REFERENCES `submissions`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`reviewer_user_id`) REFERENCES `event_members`(`event_id`,`user_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "review_assignments_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_review_assignments`("id", "event_id", "round_id", "submission_id", "reviewer_user_id", "version", "created_at", "updated_at")
SELECT a.id, r.event_id, a.round_id, a.submission_id, a.reviewer_user_id, 1, a.created_at, a.updated_at
FROM `review_assignments` a JOIN `review_rounds` r ON r.id = a.round_id;--> statement-breakpoint
ALTER TABLE `review_assignments` RENAME TO `__old_review_assignments`;--> statement-breakpoint
ALTER TABLE `__new_review_assignments` RENAME TO `review_assignments`;--> statement-breakpoint
DROP INDEX IF EXISTS `review_assignments_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `review_assignments_event_id_unique` ON `review_assignments` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `review_assignments_pair_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `review_assignments_pair_unique` ON `review_assignments` (`event_id`,`round_id`,`submission_id`,`reviewer_user_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `review_assignments_reviewer`;--> statement-breakpoint
CREATE INDEX `review_assignments_reviewer` ON `review_assignments` (`event_id`,`reviewer_user_id`,`round_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `review_assignments_submission`;--> statement-breakpoint
CREATE INDEX `review_assignments_submission` ON `review_assignments` (`event_id`,`submission_id`);--> statement-breakpoint
CREATE TABLE `__new_submission_speakers` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`) REFERENCES `submissions`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`speaker_id`) REFERENCES `speakers`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_submission_speakers`("id", "event_id", "submission_id", "speaker_id", "is_primary", "created_at")
SELECT x.id, s.event_id, x.submission_id, x.speaker_id, x.is_primary, s.created_at
FROM `submission_speakers` x JOIN `submissions` s ON s.id = x.submission_id;--> statement-breakpoint
ALTER TABLE `submission_speakers` RENAME TO `__old_submission_speakers`;--> statement-breakpoint
ALTER TABLE `__new_submission_speakers` RENAME TO `submission_speakers`;--> statement-breakpoint
DROP INDEX IF EXISTS `submission_speakers_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `submission_speakers_event_id_unique` ON `submission_speakers` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `submission_speakers_primary_parent_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `submission_speakers_primary_parent_unique` ON `submission_speakers` (`event_id`,`submission_id`,`id`,`speaker_id`,`is_primary`);--> statement-breakpoint
DROP INDEX IF EXISTS `submission_speakers_pair_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `submission_speakers_pair_unique` ON `submission_speakers` (`event_id`,`submission_id`,`speaker_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `submission_speakers_one_primary`;--> statement-breakpoint
CREATE UNIQUE INDEX `submission_speakers_one_primary` ON `submission_speakers` (`event_id`,`submission_id`) WHERE "submission_speakers"."is_primary" = 1;--> statement-breakpoint
DROP INDEX IF EXISTS `submission_speakers_speaker`;--> statement-breakpoint
CREATE INDEX `submission_speakers_speaker` ON `submission_speakers` (`event_id`,`speaker_id`);--> statement-breakpoint
CREATE TABLE `__new_talks` (
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
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`) REFERENCES `submissions`(`event_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`event_id`,`track_id`) REFERENCES `tracks`(`event_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`event_id`,`room_id`) REFERENCES `rooms`(`event_id`,`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "talks_duration_positive" CHECK("duration_min" > 0),
	CONSTRAINT "talks_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_talks`("id", "event_id", "submission_id", "title", "description", "track_id", "room_id", "starts_at", "duration_min", "status", "version", "created_at", "updated_at")
SELECT id, event_id, submission_id, title, description, track_id, room_id, starts_at, duration_min, status, 1, created_at, updated_at FROM `talks`;--> statement-breakpoint
ALTER TABLE `talks` RENAME TO `__old_talks`;--> statement-breakpoint
ALTER TABLE `__new_talks` RENAME TO `talks`;--> statement-breakpoint
DROP INDEX IF EXISTS `talks_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `talks_event_id_unique` ON `talks` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `talks_event_schedule`;--> statement-breakpoint
CREATE INDEX `talks_event_schedule` ON `talks` (`event_id`,`starts_at`,`room_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `talks_submission`;--> statement-breakpoint
CREATE INDEX `talks_submission` ON `talks` (`event_id`,`submission_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `talks_track`;--> statement-breakpoint
CREATE INDEX `talks_track` ON `talks` (`event_id`,`track_id`);--> statement-breakpoint
CREATE TABLE `__new_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`round_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`reviewer_user_id` text,
	`ai` integer DEFAULT false NOT NULL,
	`score` real NOT NULL,
	`scores` text,
	`comment` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`round_id`) REFERENCES `review_rounds`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`) REFERENCES `submissions`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`reviewer_user_id`) REFERENCES `event_members`(`event_id`,`user_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "reviews_actor_kind" CHECK(("ai" = 1 and "reviewer_user_id" is null) or ("ai" = 0 and "reviewer_user_id" is not null)),
	CONSTRAINT "reviews_score_bounds" CHECK("score" between 0 and 10),
	CONSTRAINT "reviews_version_positive" CHECK("version" > 0)
);--> statement-breakpoint
INSERT INTO `__new_reviews`("id", "event_id", "round_id", "submission_id", "reviewer_user_id", "ai", "score", "scores", "comment", "version", "created_at", "updated_at")
SELECT v.id, r.event_id, v.round_id, v.submission_id, v.reviewer_user_id, v.ai, v.score, v.scores, v.comment, 1, v.created_at, v.updated_at
FROM `reviews` v JOIN `review_rounds` r ON r.id = v.round_id;--> statement-breakpoint
ALTER TABLE `reviews` RENAME TO `__old_reviews`;--> statement-breakpoint
ALTER TABLE `__new_reviews` RENAME TO `reviews`;--> statement-breakpoint
DROP INDEX IF EXISTS `reviews_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_event_id_unique` ON `reviews` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `reviews_human_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_human_unique` ON `reviews` (`event_id`,`round_id`,`submission_id`,`reviewer_user_id`) WHERE "reviews"."ai" = 0;--> statement-breakpoint
DROP INDEX IF EXISTS `reviews_submission`;--> statement-breakpoint
CREATE INDEX `reviews_submission` ON `reviews` (`event_id`,`submission_id`);--> statement-breakpoint
CREATE TABLE `acceptance_events` (
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
	CONSTRAINT "acceptance_events_version_positive" CHECK("acceptance_events"."submission_version" > 0),
	CONSTRAINT "acceptance_events_primary_association" CHECK("acceptance_events"."primary_association_is_primary" = 1)
);--> statement-breakpoint
DROP INDEX IF EXISTS `acceptance_events_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_events_event_id_unique` ON `acceptance_events` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `acceptance_events_provisioning_parent_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_events_provisioning_parent_unique` ON `acceptance_events` (`event_id`,`id`,`submission_id`,`primary_speaker_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `acceptance_events_submission_version_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `acceptance_events_submission_version_unique` ON `acceptance_events` (`event_id`,`submission_id`,`submission_version`);--> statement-breakpoint
DROP INDEX IF EXISTS `acceptance_events_event_cursor`;--> statement-breakpoint
CREATE INDEX `acceptance_events_event_cursor` ON `acceptance_events` (`event_id`,`occurred_at`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `acceptance_events_primary_speaker`;--> statement-breakpoint
CREATE INDEX `acceptance_events_primary_speaker` ON `acceptance_events` (`event_id`,`primary_speaker_id`);--> statement-breakpoint
CREATE TABLE `airtable_pending_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`speaker_id` text,
	`submission_id` text,
	`talk_id` text,
	`field_key` text NOT NULL,
	`intended_value` text NOT NULL,
	`base_inbound_revision` text,
	`base_inbound_hash` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_at` integer,
	`conflict_value` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`integration_id`) REFERENCES `integrations`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`speaker_id`) REFERENCES `speakers`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`) REFERENCES `submissions`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`talk_id`) REFERENCES `talks`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "airtable_pending_entity_owner" CHECK((
        "airtable_pending_edits"."entity_type" = 'speaker'
        and "airtable_pending_edits"."speaker_id" = "airtable_pending_edits"."entity_id"
        and "airtable_pending_edits"."submission_id" is null
        and "airtable_pending_edits"."talk_id" is null
      ) or (
        "airtable_pending_edits"."entity_type" = 'submission'
        and "airtable_pending_edits"."speaker_id" is null
        and "airtable_pending_edits"."submission_id" = "airtable_pending_edits"."entity_id"
        and "airtable_pending_edits"."talk_id" is null
      ) or (
        "airtable_pending_edits"."entity_type" = 'talk'
        and "airtable_pending_edits"."speaker_id" is null
        and "airtable_pending_edits"."submission_id" is null
        and "airtable_pending_edits"."talk_id" = "airtable_pending_edits"."entity_id"
      )),
	CONSTRAINT "airtable_pending_hash_length" CHECK("airtable_pending_edits"."base_inbound_hash" is null or length("airtable_pending_edits"."base_inbound_hash") = 64),
	CONSTRAINT "airtable_pending_resolution" CHECK(("airtable_pending_edits"."status" = 'pending' and "airtable_pending_edits"."resolved_at" is null) or ("airtable_pending_edits"."status" <> 'pending' and "airtable_pending_edits"."resolved_at" is not null)),
	CONSTRAINT "airtable_pending_version_positive" CHECK("airtable_pending_edits"."version" > 0)
);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_pending_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_pending_event_id_unique` ON `airtable_pending_edits` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_pending_outbox_parent_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_pending_outbox_parent_unique` ON `airtable_pending_edits` (`event_id`,`integration_id`,`id`,`entity_type`,`entity_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_pending_one_active`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_pending_one_active` ON `airtable_pending_edits` (`event_id`,`integration_id`,`entity_type`,`entity_id`,`field_key`) WHERE "airtable_pending_edits"."status" = 'pending';--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_pending_entity`;--> statement-breakpoint
CREATE INDEX `airtable_pending_entity` ON `airtable_pending_edits` (`event_id`,`entity_type`,`entity_id`,`status`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_pending_integration`;--> statement-breakpoint
CREATE INDEX `airtable_pending_integration` ON `airtable_pending_edits` (`integration_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `airtable_record_links` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`speaker_id` text,
	`submission_id` text,
	`talk_id` text,
	`session_party_id` text NOT NULL,
	`airtable_record_id` text NOT NULL,
	`outbound_revision` integer DEFAULT 0 NOT NULL,
	`outbound_hash` text,
	`inbound_revision` text,
	`inbound_hash` text,
	`origin` text,
	`last_refreshed_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`integration_id`) REFERENCES `integrations`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`speaker_id`) REFERENCES `speakers`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`) REFERENCES `submissions`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`talk_id`) REFERENCES `talks`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "airtable_links_entity_owner" CHECK((
        "airtable_record_links"."entity_type" = 'speaker'
        and "airtable_record_links"."speaker_id" = "airtable_record_links"."entity_id"
        and "airtable_record_links"."submission_id" is null
        and "airtable_record_links"."talk_id" is null
      ) or (
        "airtable_record_links"."entity_type" = 'submission'
        and "airtable_record_links"."speaker_id" is null
        and "airtable_record_links"."submission_id" = "airtable_record_links"."entity_id"
        and "airtable_record_links"."talk_id" is null
      ) or (
        "airtable_record_links"."entity_type" = 'talk'
        and "airtable_record_links"."speaker_id" is null
        and "airtable_record_links"."submission_id" is null
        and "airtable_record_links"."talk_id" = "airtable_record_links"."entity_id"
      )),
	CONSTRAINT "airtable_links_session_party_matches" CHECK("airtable_record_links"."session_party_id" = "airtable_record_links"."entity_id"),
	CONSTRAINT "airtable_links_revision_nonnegative" CHECK("airtable_record_links"."outbound_revision" >= 0),
	CONSTRAINT "airtable_links_outbound_hash_length" CHECK("airtable_record_links"."outbound_hash" is null or length("airtable_record_links"."outbound_hash") = 64),
	CONSTRAINT "airtable_links_inbound_hash_length" CHECK("airtable_record_links"."inbound_hash" is null or length("airtable_record_links"."inbound_hash") = 64),
	CONSTRAINT "airtable_links_version_positive" CHECK("airtable_record_links"."version" > 0)
);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_links_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_links_event_id_unique` ON `airtable_record_links` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_links_entity_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_links_entity_unique` ON `airtable_record_links` (`event_id`,`integration_id`,`entity_type`,`entity_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_links_session_party_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_links_session_party_unique` ON `airtable_record_links` (`integration_id`,`entity_type`,`session_party_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_links_record_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_links_record_unique` ON `airtable_record_links` (`integration_id`,`entity_type`,`airtable_record_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_links_refresh`;--> statement-breakpoint
CREATE INDEX `airtable_links_refresh` ON `airtable_record_links` (`integration_id`,`entity_type`,`last_refreshed_at`);--> statement-breakpoint
CREATE TABLE `__new_talk_speakers` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`talk_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`talk_id`) REFERENCES `talks`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`speaker_id`) REFERENCES `speakers`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_talk_speakers`("id", "event_id", "talk_id", "speaker_id", "created_at")
SELECT x.id, t.event_id, x.talk_id, x.speaker_id, t.created_at FROM `talk_speakers` x JOIN `talks` t ON t.id = x.talk_id;--> statement-breakpoint
ALTER TABLE `talk_speakers` RENAME TO `__old_talk_speakers`;--> statement-breakpoint
ALTER TABLE `__new_talk_speakers` RENAME TO `talk_speakers`;--> statement-breakpoint
DROP INDEX IF EXISTS `talk_speakers_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `talk_speakers_event_id_unique` ON `talk_speakers` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `talk_speakers_pair_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `talk_speakers_pair_unique` ON `talk_speakers` (`event_id`,`talk_id`,`speaker_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `talk_speakers_speaker`;--> statement-breakpoint
CREATE INDEX `talk_speakers_speaker` ON `talk_speakers` (`event_id`,`speaker_id`);--> statement-breakpoint
CREATE TABLE `airtable_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`pending_edit_id` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`speaker_id` text,
	`submission_id` text,
	`talk_id` text,
	`session_party_id` text NOT NULL,
	`operation` text NOT NULL,
	`changed_fields` text NOT NULL,
	`outbound_revision` integer NOT NULL,
	`outbound_hash` text NOT NULL,
	`origin` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`available_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`completed_at` integer,
	`dead_lettered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`integration_id`) REFERENCES `integrations`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`speaker_id`) REFERENCES `speakers`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`submission_id`) REFERENCES `submissions`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`talk_id`) REFERENCES `talks`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`integration_id`,`pending_edit_id`,`entity_type`,`entity_id`) REFERENCES `airtable_pending_edits`(`event_id`,`integration_id`,`id`,`entity_type`,`entity_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "airtable_outbox_entity_owner" CHECK((
        "airtable_outbox"."entity_type" = 'speaker'
        and "airtable_outbox"."speaker_id" = "airtable_outbox"."entity_id"
        and "airtable_outbox"."submission_id" is null
        and "airtable_outbox"."talk_id" is null
      ) or (
        "airtable_outbox"."entity_type" = 'submission'
        and "airtable_outbox"."speaker_id" is null
        and "airtable_outbox"."submission_id" = "airtable_outbox"."entity_id"
        and "airtable_outbox"."talk_id" is null
      ) or (
        "airtable_outbox"."entity_type" = 'talk'
        and "airtable_outbox"."speaker_id" is null
        and "airtable_outbox"."submission_id" is null
        and "airtable_outbox"."talk_id" = "airtable_outbox"."entity_id"
      )),
	CONSTRAINT "airtable_outbox_session_party_matches" CHECK("airtable_outbox"."session_party_id" = "airtable_outbox"."entity_id"),
	CONSTRAINT "airtable_outbox_revision_positive" CHECK("airtable_outbox"."outbound_revision" > 0),
	CONSTRAINT "airtable_outbox_hash_length" CHECK(length("airtable_outbox"."outbound_hash") = 64),
	CONSTRAINT "airtable_outbox_attempts_nonnegative" CHECK("airtable_outbox"."attempt_count" >= 0),
	CONSTRAINT "airtable_outbox_lease_pair" CHECK(("airtable_outbox"."lease_owner" is null) = ("airtable_outbox"."lease_expires_at" is null)),
	CONSTRAINT "airtable_outbox_dead_state" CHECK(("airtable_outbox"."status" = 'dead_letter' and "airtable_outbox"."dead_lettered_at" is not null) or "airtable_outbox"."status" <> 'dead_letter')
);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_outbox_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_outbox_event_id_unique` ON `airtable_outbox` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_outbox_revision_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_outbox_revision_unique` ON `airtable_outbox` (`integration_id`,`entity_type`,`entity_id`,`outbound_revision`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_outbox_idempotency_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `airtable_outbox_idempotency_unique` ON `airtable_outbox` (`integration_id`,`idempotency_key`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_outbox_claim`;--> statement-breakpoint
CREATE INDEX `airtable_outbox_claim` ON `airtable_outbox` (`integration_id`,`status`,`available_at`,`lease_expires_at`,`created_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `airtable_outbox_order`;--> statement-breakpoint
CREATE INDEX `airtable_outbox_order` ON `airtable_outbox` (`integration_id`,`entity_type`,`entity_id`,`outbound_revision`);--> statement-breakpoint
CREATE TABLE `speaker_provisioning` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`acceptance_event_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`primary_speaker_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`available_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`provisioned_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`acceptance_event_id`,`submission_id`,`primary_speaker_id`) REFERENCES `acceptance_events`(`event_id`,`id`,`submission_id`,`primary_speaker_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "speaker_provisioning_attempts_nonnegative" CHECK("speaker_provisioning"."attempt_count" >= 0),
	CONSTRAINT "speaker_provisioning_version_positive" CHECK("speaker_provisioning"."version" > 0),
	CONSTRAINT "speaker_provisioning_lease_pair" CHECK(("speaker_provisioning"."lease_owner" is null) = ("speaker_provisioning"."lease_expires_at" is null))
);--> statement-breakpoint
DROP INDEX IF EXISTS `speaker_provisioning_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_provisioning_event_id_unique` ON `speaker_provisioning` (`event_id`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `speaker_provisioning_acceptance_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_provisioning_acceptance_unique` ON `speaker_provisioning` (`event_id`,`acceptance_event_id`);--> statement-breakpoint
DROP INDEX IF EXISTS `speaker_provisioning_claim`;--> statement-breakpoint
CREATE INDEX `speaker_provisioning_claim` ON `speaker_provisioning` (`status`,`available_at`,`lease_expires_at`,`created_at`);--> statement-breakpoint
DROP INDEX IF EXISTS `speaker_provisioning_submission`;--> statement-breakpoint
CREATE INDEX `speaker_provisioning_submission` ON `speaker_provisioning` (`event_id`,`submission_id`);--> statement-breakpoint
INSERT INTO `mail_delivery_snapshots` (
	`id`, `event_id`, `template_id`, `recipient_user_id`, `recipient_email`, `recipient_name`, `from_email`, `reply_to_email`, `subject`, `rendered_html`, `rendered_text`, `ics_filename`, `ics_content`, `created_at`
)
SELECT
	'legacy-snapshot:' || s.id,
	s.event_id,
	s.template_id,
	s.to_user_id,
	u.email,
	u.name,
	'legacy-import@invalid',
	NULL,
	s.subject,
	coalesce(t.body, ''),
	coalesce(t.body, ''),
	NULL,
	NULL,
	s.created_at
FROM `email_sends` s
JOIN `users` u ON u.id = s.to_user_id
LEFT JOIN `email_templates` t ON t.id = s.template_id;--> statement-breakpoint
INSERT INTO `mail_deliveries` (
	`id`, `snapshot_id`, `idempotency_key`, `status`, `scheduled_for`, `available_at`, `lease_owner`, `lease_expires_at`, `attempt_count`, `max_attempts`, `provider`, `provider_message_id`, `provider_result`, `last_error`, `sent_at`, `dead_lettered_at`, `created_at`
)
SELECT
	s.id,
	'legacy-snapshot:' || s.id,
	'legacy-import:' || s.id,
	iif(s.status = 'sent', 'sent', iif(s.status = 'failed', 'dead_letter', 'cancelled')),
	coalesce(s.scheduled_for, s.created_at),
	coalesce(s.scheduled_for, s.created_at),
	NULL,
	NULL,
	iif(s.status IN ('sent', 'failed'), 1, 0),
	1,
	'legacy-import',
	iif(s.status = 'sent', 'legacy-unverified:' || s.id, NULL),
	'{"mode":"legacy-import","externalDeliveryUnverified":true}',
	s.error,
	s.sent_at,
	iif(s.status = 'failed', coalesce(s.updated_at, s.created_at), NULL),
	s.created_at
FROM `email_sends` s;--> statement-breakpoint
INSERT INTO `mail_delivery_attempts` (
	`id`, `delivery_id`, `attempt_number`, `lease_owner`, `status`, `provider_message_id`, `provider_result`, `error`, `started_at`, `completed_at`
)
SELECT
	'legacy-attempt:' || s.id,
	s.id,
	1,
	'legacy-import',
	iif(s.status = 'sent', 'sent', 'failed'),
	iif(s.status = 'sent', 'legacy-unverified:' || s.id, NULL),
	'{"mode":"legacy-import","externalDeliveryUnverified":true}',
	s.error,
	s.created_at,
	coalesce(s.sent_at, s.updated_at, s.created_at)
FROM `email_sends` s
WHERE s.status IN ('sent', 'failed');--> statement-breakpoint
DROP TABLE `email_sends`;--> statement-breakpoint
DROP TABLE `__old_talk_speakers`;--> statement-breakpoint
DROP TABLE `__old_reviews`;--> statement-breakpoint
DROP TABLE `__old_talks`;--> statement-breakpoint
DROP TABLE `__old_submission_speakers`;--> statement-breakpoint
DROP TABLE `__old_review_assignments`;--> statement-breakpoint
DROP TABLE `__old_submission_answers`;--> statement-breakpoint
DROP TABLE `__old_task_completions`;--> statement-breakpoint
DROP TABLE `__old_submissions`;--> statement-breakpoint
DROP TABLE `__old_tasks`;--> statement-breakpoint
DROP TABLE `__old_form_fields`;--> statement-breakpoint
DROP TABLE `__old_speakers`;--> statement-breakpoint
DROP TABLE `__old_tracks`;--> statement-breakpoint
DROP TABLE `__old_rooms`;--> statement-breakpoint
DROP TABLE `__old_review_rounds`;--> statement-breakpoint
DROP TABLE `__old_pages`;--> statement-breakpoint
DROP TABLE `__old_forms`;--> statement-breakpoint
DROP TABLE `__old_email_templates`;--> statement-breakpoint
DROP TABLE `__old_assets`;--> statement-breakpoint
DROP TABLE `__old_api_keys`;--> statement-breakpoint
DROP TABLE `__old_integrations`;--> statement-breakpoint
DROP TABLE `__old_event_members`;--> statement-breakpoint
DROP TABLE `__old_auth_tokens`;--> statement-breakpoint
DROP TABLE `__old_users`;--> statement-breakpoint
DROP TABLE `__old_events`;
