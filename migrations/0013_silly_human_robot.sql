CREATE TABLE `embeds` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`widget` text NOT NULL,
	`preset` text NOT NULL,
	`aesthetic` text DEFAULT 'bold' NOT NULL,
	`accent` text DEFAULT '#7857FF' NOT NULL,
	`track` text,
	`fields` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "embeds_name_nonempty" CHECK(length(trim("embeds"."name")) > 0),
	CONSTRAINT "embeds_accent_hex" CHECK("embeds"."accent" glob '#[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'),
	CONSTRAINT "embeds_version_positive" CHECK("embeds"."version" > 0),
	CONSTRAINT "embeds_widget_preset" CHECK(("embeds"."widget" = 'schedule' and "embeds"."preset" in ('sessions', 'agenda', 'itinerary')) or ("embeds"."widget" = 'speakerGallery' and "embeds"."preset" in ('speakerList', 'speakerGallery')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embeds_event_id_unique` ON `embeds` (`event_id`,`id`);--> statement-breakpoint
CREATE INDEX `embeds_event_updated` ON `embeds` (`event_id`,`updated_at`);