CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`event_id` text NOT NULL,
	`change_sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`body` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`available_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`response_status` integer,
	`last_error` text,
	`delivered_at` integer,
	`dead_lettered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "webhook_deliveries_delivered_state" CHECK(("webhook_deliveries"."status" = 'delivered' and "webhook_deliveries"."delivered_at" is not null) or "webhook_deliveries"."status" <> 'delivered'),
	CONSTRAINT "webhook_deliveries_dead_state" CHECK(("webhook_deliveries"."status" = 'dead_letter' and "webhook_deliveries"."dead_lettered_at" is not null) or "webhook_deliveries"."status" <> 'dead_letter'),
	CONSTRAINT "webhook_deliveries_attempt_bounds" CHECK("webhook_deliveries"."attempt_count" >= 0 and "webhook_deliveries"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_idempotency_unique` ON `webhook_deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_dispatch` ON `webhook_deliveries` (`status`,`available_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_endpoint_history` ON `webhook_deliveries` (`endpoint_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`url` text NOT NULL,
	`description` text,
	`kinds` text NOT NULL,
	`signing_secret` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cursor_sequence` integer NOT NULL,
	`created_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "webhook_endpoints_url_https" CHECK("webhook_endpoints"."url" like 'https://%'),
	CONSTRAINT "webhook_endpoints_kinds_json" CHECK(json_valid("webhook_endpoints"."kinds") and json_type("webhook_endpoints"."kinds") = 'array' and json_array_length("webhook_endpoints"."kinds") > 0),
	CONSTRAINT "webhook_endpoints_secret_nonempty" CHECK(length("webhook_endpoints"."signing_secret") >= 32),
	CONSTRAINT "webhook_endpoints_cursor_nonnegative" CHECK("webhook_endpoints"."cursor_sequence" >= 0),
	CONSTRAINT "webhook_endpoints_version_positive" CHECK("webhook_endpoints"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_endpoints_event_url_unique` ON `webhook_endpoints` (`event_id`,`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_endpoints_event_id_unique` ON `webhook_endpoints` (`event_id`,`id`);--> statement-breakpoint
CREATE INDEX `webhook_endpoints_status_cursor` ON `webhook_endpoints` (`status`,`cursor_sequence`);