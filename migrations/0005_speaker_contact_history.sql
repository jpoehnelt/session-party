CREATE TABLE `speaker_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`speaker_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`medium` text NOT NULL,
	`note` text,
	`contacted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`event_id`,`speaker_id`) REFERENCES `speakers`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `speaker_contacts_event_id_unique` ON `speaker_contacts` (`event_id`,`id`);--> statement-breakpoint
CREATE INDEX `speaker_contacts_speaker_time` ON `speaker_contacts` (`event_id`,`speaker_id`,`contacted_at`);