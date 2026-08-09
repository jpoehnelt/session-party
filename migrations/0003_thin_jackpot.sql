CREATE TABLE `accelevents_external_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`source_event_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`external_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`speaker_id` text,
	`talk_id` text,
	`source_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`integration_id`) REFERENCES `integrations`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`speaker_id`) REFERENCES `speakers`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`talk_id`) REFERENCES `talks`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "accelevents_identities_entity_type" CHECK("accelevents_external_identities"."entity_type" in ('speaker', 'talk')),
	CONSTRAINT "accelevents_identities_entity_owner" CHECK((
        "accelevents_external_identities"."entity_type" = 'speaker'
        and "accelevents_external_identities"."speaker_id" = "accelevents_external_identities"."entity_id"
        and "accelevents_external_identities"."talk_id" is null
      ) or (
        "accelevents_external_identities"."entity_type" = 'talk'
        and "accelevents_external_identities"."speaker_id" is null
        and "accelevents_external_identities"."talk_id" = "accelevents_external_identities"."entity_id"
      )),
	CONSTRAINT "accelevents_identities_source_event_nonempty" CHECK(length("accelevents_external_identities"."source_event_id") > 0),
	CONSTRAINT "accelevents_identities_external_nonempty" CHECK(length("accelevents_external_identities"."external_id") > 0),
	CONSTRAINT "accelevents_identities_hash_length" CHECK(length("accelevents_external_identities"."source_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accelevents_identities_event_id_unique` ON `accelevents_external_identities` (`event_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accelevents_identities_source_unique` ON `accelevents_external_identities` (`event_id`,`integration_id`,`source_event_id`,`entity_type`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accelevents_identities_local_unique` ON `accelevents_external_identities` (`event_id`,`integration_id`,`source_event_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `accelevents_identities_integration` ON `accelevents_external_identities` (`event_id`,`integration_id`,`source_event_id`,`entity_type`);--> statement-breakpoint
CREATE TABLE `accelevents_import_items` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`run_id` text NOT NULL,
	`item_order` integer NOT NULL,
	`entity_type` text NOT NULL,
	`external_id` text NOT NULL,
	`action` text NOT NULL,
	`local_id` text,
	`error_code` text,
	`error_detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`integration_id`,`run_id`) REFERENCES `accelevents_import_runs`(`event_id`,`integration_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "accelevents_items_entity_type" CHECK("accelevents_import_items"."entity_type" in ('speaker', 'talk')),
	CONSTRAINT "accelevents_items_action" CHECK("accelevents_import_items"."action" in ('created', 'updated', 'unchanged', 'failed')),
	CONSTRAINT "accelevents_items_order_nonnegative" CHECK("accelevents_import_items"."item_order" >= 0),
	CONSTRAINT "accelevents_items_external_nonempty" CHECK(length("accelevents_import_items"."external_id") > 0),
	CONSTRAINT "accelevents_items_result_shape" CHECK(("accelevents_import_items"."action" = 'failed'
        and "accelevents_import_items"."local_id" is null
        and "accelevents_import_items"."error_code" is not null
        and "accelevents_import_items"."error_detail" is not null)
        or ("accelevents_import_items"."action" <> 'failed'
        and "accelevents_import_items"."local_id" is not null
        and "accelevents_import_items"."error_code" is null
        and "accelevents_import_items"."error_detail" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accelevents_items_event_id_unique` ON `accelevents_import_items` (`event_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accelevents_items_order_unique` ON `accelevents_import_items` (`event_id`,`run_id`,`item_order`);--> statement-breakpoint
CREATE INDEX `accelevents_items_run` ON `accelevents_import_items` (`event_id`,`integration_id`,`run_id`,`item_order`);--> statement-breakpoint
CREATE TABLE `accelevents_import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`source_event_id` text NOT NULL,
	`event_url` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`total_count` integer DEFAULT 0 NOT NULL,
	`created_count` integer DEFAULT 0 NOT NULL,
	`updated_count` integer DEFAULT 0 NOT NULL,
	`unchanged_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_detail` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`event_id`,`integration_id`) REFERENCES `integrations`(`event_id`,`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "accelevents_runs_mode" CHECK("accelevents_import_runs"."mode" in ('fixture', 'live')),
	CONSTRAINT "accelevents_runs_status" CHECK("accelevents_import_runs"."status" in ('running', 'succeeded', 'partial', 'failed')),
	CONSTRAINT "accelevents_runs_source_event_nonempty" CHECK(length("accelevents_import_runs"."source_event_id") > 0),
	CONSTRAINT "accelevents_runs_event_url_nonempty" CHECK(length("accelevents_import_runs"."event_url") > 0),
	CONSTRAINT "accelevents_runs_counts" CHECK("accelevents_import_runs"."total_count" >= 0
        and "accelevents_import_runs"."created_count" >= 0
        and "accelevents_import_runs"."updated_count" >= 0
        and "accelevents_import_runs"."unchanged_count" >= 0
        and "accelevents_import_runs"."failed_count" >= 0
        and "accelevents_import_runs"."total_count" = "accelevents_import_runs"."created_count" + "accelevents_import_runs"."updated_count" + "accelevents_import_runs"."unchanged_count" + "accelevents_import_runs"."failed_count"),
	CONSTRAINT "accelevents_runs_completion" CHECK(("accelevents_import_runs"."status" = 'running' and "accelevents_import_runs"."completed_at" is null)
        or ("accelevents_import_runs"."status" <> 'running' and "accelevents_import_runs"."completed_at" is not null)),
	CONSTRAINT "accelevents_runs_error_shape" CHECK(("accelevents_import_runs"."status" = 'failed' and "accelevents_import_runs"."error_code" is not null and "accelevents_import_runs"."error_detail" is not null)
        or ("accelevents_import_runs"."status" <> 'failed' and "accelevents_import_runs"."error_code" is null and "accelevents_import_runs"."error_detail" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accelevents_runs_event_id_unique` ON `accelevents_import_runs` (`event_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accelevents_runs_parent_unique` ON `accelevents_import_runs` (`event_id`,`integration_id`,`id`);--> statement-breakpoint
CREATE INDEX `accelevents_runs_latest` ON `accelevents_import_runs` (`event_id`,`integration_id`,`started_at`,`id`);