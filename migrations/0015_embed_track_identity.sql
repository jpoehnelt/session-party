PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
INSERT INTO `__new_embeds`("id", "event_id", "name", "widget", "preset", "aesthetic", "accent", "track_id", "track", "fields", "enabled", "version", "created_at", "updated_at") SELECT "id", "event_id", "name", "widget", "preset", "aesthetic", "accent", (SELECT "tracks"."id" FROM "tracks" WHERE "tracks"."event_id" = "embeds"."event_id" AND "tracks"."name" = "embeds"."track" LIMIT 1), "track", "fields", "enabled", "version", "created_at", "updated_at" FROM `embeds`;--> statement-breakpoint
DROP TABLE `embeds`;--> statement-breakpoint
ALTER TABLE `__new_embeds` RENAME TO `embeds`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `embeds_event_id_unique` ON `embeds` (`event_id`,`id`);--> statement-breakpoint
CREATE INDEX `embeds_event_updated` ON `embeds` (`event_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `embeds_track` ON `embeds` (`event_id`,`track_id`);
