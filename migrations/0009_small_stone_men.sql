CREATE TABLE `mail_calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`event_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`talk_id` text NOT NULL,
	`calendar_uid` text NOT NULL,
	`sequence` integer NOT NULL,
	`publication_revision` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `mail_delivery_snapshots`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`snapshot_id`) REFERENCES `mail_delivery_snapshots`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "mail_calendar_events_sequence_positive" CHECK("mail_calendar_events"."sequence" > 0),
	CONSTRAINT "mail_calendar_events_publication_revision_positive" CHECK("mail_calendar_events"."publication_revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_calendar_events_snapshot_talk_unique` ON `mail_calendar_events` (`snapshot_id`,`talk_id`);--> statement-breakpoint
CREATE INDEX `mail_calendar_events_event_recipient` ON `mail_calendar_events` (`event_id`,`speaker_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `mail_calendar_events_event_talk` ON `mail_calendar_events` (`event_id`,`talk_id`,`sequence`);--> statement-breakpoint
ALTER TABLE `mail_deliveries` ADD `superseded_at` integer;