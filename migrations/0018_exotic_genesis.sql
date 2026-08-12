CREATE TABLE `install_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`granted_by_user_id` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revoked_by_user_id` text,
	`revoked_at` integer,
	`grant_key_hash` text,
	`grant_request_hash` text,
	`revoke_key_hash` text,
	`revoke_request_hash` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`granted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "install_grants_role_staff" CHECK("install_grants"."role" = 'staff'),
	CONSTRAINT "install_grants_version_positive" CHECK("install_grants"."version" > 0),
	CONSTRAINT "install_grants_revocation_pair" CHECK(("install_grants"."revoked_at" is null) = ("install_grants"."revoked_by_user_id" is null)),
	CONSTRAINT "install_grants_grant_replay_pair" CHECK(("install_grants"."grant_key_hash" is null) = ("install_grants"."grant_request_hash" is null)),
	CONSTRAINT "install_grants_revoke_replay_pair" CHECK(("install_grants"."revoke_key_hash" is null) = ("install_grants"."revoke_request_hash" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `install_grants_one_active_user_role` ON `install_grants` (`user_id`,`role`) WHERE "install_grants"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `install_grants_grant_idempotency_unique` ON `install_grants` (`granted_by_user_id`,`grant_key_hash`) WHERE "install_grants"."grant_key_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `install_grants_revoke_idempotency_unique` ON `install_grants` (`revoked_by_user_id`,`revoke_key_hash`) WHERE "install_grants"."revoke_key_hash" is not null;--> statement-breakpoint
CREATE INDEX `install_grants_active_role` ON `install_grants` (`role`,`revoked_at`,`user_id`);--> statement-breakpoint
CREATE INDEX `install_grants_history` ON `install_grants` (`user_id`,`granted_at`);