CREATE TABLE `managed_speaker_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`normalized_email` text NOT NULL,
	`speaker_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`speaker_id`) REFERENCES `speakers`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "managed_speaker_emails_normalized" CHECK(length("managed_speaker_emails"."normalized_email") > 0 and "managed_speaker_emails"."normalized_email" = lower(trim("managed_speaker_emails"."normalized_email")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_speaker_emails_event_email_unique` ON `managed_speaker_emails` (`event_id`,`normalized_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `managed_speaker_emails_event_speaker_unique` ON `managed_speaker_emails` (`event_id`,`speaker_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_current_lineage_unique` ON `assets` (`event_id`,`speaker_id`,`purpose`) WHERE "assets"."current" = 1 and "assets"."speaker_id" is not null and "assets"."purpose" is not null;