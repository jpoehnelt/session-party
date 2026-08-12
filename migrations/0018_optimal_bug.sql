CREATE TABLE `installation_brands` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`logo_asset_id` text,
	`favicon_asset_id` text,
	`primary_color` text NOT NULL,
	`font` text NOT NULL,
	`appearance` text NOT NULL,
	`radius` text NOT NULL,
	`sender_name` text NOT NULL,
	`sender_email` text,
	`reply_to_email` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`logo_asset_id`) REFERENCES `assets`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`favicon_asset_id`) REFERENCES `assets`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "installation_brands_singleton" CHECK("installation_brands"."id" = 'default'),
	CONSTRAINT "installation_brands_version_positive" CHECK("installation_brands"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `brand_kind` text;--> statement-breakpoint
ALTER TABLE `events` ADD `public_name` text;--> statement-breakpoint
ALTER TABLE `events` ADD `inherit_installation_brand` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `logo_asset_id` text;