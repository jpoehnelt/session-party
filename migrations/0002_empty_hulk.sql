PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_mail_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`scheduled_for` integer NOT NULL,
	`available_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`provider` text DEFAULT 'cloudflare-email' NOT NULL,
	`provider_message_id` text,
	`provider_result` text,
	`last_error` text,
	`sent_at` integer,
	`dead_lettered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `mail_delivery_snapshots`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "mail_deliveries_attempts" CHECK("__new_mail_deliveries"."attempt_count" >= 0 and "__new_mail_deliveries"."max_attempts" > 0 and "__new_mail_deliveries"."attempt_count" <= "__new_mail_deliveries"."max_attempts"),
	CONSTRAINT "mail_deliveries_lease_pair" CHECK(("__new_mail_deliveries"."lease_owner" is null) = ("__new_mail_deliveries"."lease_expires_at" is null)),
	CONSTRAINT "mail_deliveries_sent_state" CHECK(("__new_mail_deliveries"."status" = 'sent' and "__new_mail_deliveries"."sent_at" is not null and "__new_mail_deliveries"."provider_message_id" is not null) or "__new_mail_deliveries"."status" <> 'sent'),
	CONSTRAINT "mail_deliveries_dead_state" CHECK(("__new_mail_deliveries"."status" = 'dead_letter' and "__new_mail_deliveries"."dead_lettered_at" is not null) or "__new_mail_deliveries"."status" <> 'dead_letter')
);
--> statement-breakpoint
INSERT INTO `__new_mail_deliveries`("id", "snapshot_id", "idempotency_key", "status", "scheduled_for", "available_at", "lease_owner", "lease_expires_at", "attempt_count", "max_attempts", "provider", "provider_message_id", "provider_result", "last_error", "sent_at", "dead_lettered_at", "created_at") SELECT "id", "snapshot_id", "idempotency_key", "status", "scheduled_for", "available_at", "lease_owner", "lease_expires_at", "attempt_count", "max_attempts", "provider", "provider_message_id", "provider_result", "last_error", "sent_at", "dead_lettered_at", "created_at" FROM `mail_deliveries`;--> statement-breakpoint
DROP TABLE `mail_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_mail_deliveries` RENAME TO `mail_deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `mail_deliveries_snapshot_unique` ON `mail_deliveries` (`snapshot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mail_deliveries_idempotency_unique` ON `mail_deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `mail_deliveries_provider_message_unique` ON `mail_deliveries` (`provider`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `mail_deliveries_claim` ON `mail_deliveries` (`status`,`available_at`,`lease_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `mail_deliveries_status` ON `mail_deliveries` (`status`,`created_at`);