CREATE TABLE `__repair_legacy_form_version_ids_preflight` (
	`invalid_count` integer NOT NULL CONSTRAINT `repair_legacy_form_version_ids_invalid` CHECK (`invalid_count` = 0),
	`collision_count` integer NOT NULL CONSTRAINT `repair_legacy_form_version_ids_collision` CHECK (`collision_count` = 0),
	`relationship_count` integer NOT NULL CONSTRAINT `repair_legacy_form_version_ids_relationship` CHECK (`relationship_count` = 0)
);--> statement-breakpoint
WITH `legacy_form_versions` AS (
	SELECT
		`id`,
		`event_id`,
		`form_id`,
		'legacy-v1_' || substr(`id`, 11) AS `repaired_id`
	FROM `form_versions`
	WHERE substr(`id`, 1, 10) = 'legacy-v1:'
)
INSERT INTO `__repair_legacy_form_version_ids_preflight`
SELECT
	(
		SELECT count(*)
		FROM `form_versions` `fv`
		WHERE (
			substr(`fv`.`id`, 1, 10) = 'legacy-v1:'
			AND (
				`fv`.`id` <> 'legacy-v1:' || `fv`.`form_id`
				OR length(`fv`.`id`) > 128
				OR length(substr(`fv`.`id`, 11)) = 0
				OR substr(`fv`.`id`, 11) GLOB '*[^A-Za-z0-9_-]*'
			)
		) OR (
			substr(`fv`.`id`, 1, 10) <> 'legacy-v1:'
			AND (
				length(`fv`.`id`) = 0
				OR length(`fv`.`id`) > 128
				OR `fv`.`id` GLOB '*[^A-Za-z0-9_-]*'
			)
		)
	),
	(
		SELECT count(*)
		FROM `legacy_form_versions` `source`
		JOIN `form_versions` `occupied` ON `occupied`.`id` = `source`.`repaired_id`
	),
	(
		SELECT count(*)
		FROM `form_version_fields` `field`
		LEFT JOIN `form_versions` `parent`
			ON `parent`.`event_id` = `field`.`event_id`
			AND `parent`.`id` = `field`.`form_version_id`
		WHERE `parent`.`id` IS NULL
	) + (
		SELECT count(*)
		FROM `submissions` `submission`
		LEFT JOIN `form_versions` `parent`
			ON `parent`.`event_id` = `submission`.`event_id`
			AND `parent`.`form_id` = `submission`.`form_id`
			AND `parent`.`id` = `submission`.`form_version_id`
		WHERE `parent`.`id` IS NULL
	) + (
		SELECT count(*)
		FROM `submission_answers` `answer`
		LEFT JOIN `submissions` `submission`
			ON `submission`.`event_id` = `answer`.`event_id`
			AND `submission`.`id` = `answer`.`submission_id`
			AND `submission`.`form_version_id` = `answer`.`form_version_id`
		LEFT JOIN `form_version_fields` `field`
			ON `field`.`event_id` = `answer`.`event_id`
			AND `field`.`form_version_id` = `answer`.`form_version_id`
			AND `field`.`id` = `answer`.`form_version_field_id`
		WHERE `submission`.`id` IS NULL OR `field`.`id` IS NULL
	);--> statement-breakpoint
DROP TABLE `__repair_legacy_form_version_ids_preflight`;--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
UPDATE `form_versions`
SET `id` = 'legacy-v1_' || substr(`id`, 11)
WHERE substr(`id`, 1, 10) = 'legacy-v1:';--> statement-breakpoint
CREATE TABLE `__repair_legacy_form_version_ids_postflight` (
	`invalid_count` integer NOT NULL CONSTRAINT `repair_legacy_form_version_ids_postflight` CHECK (`invalid_count` = 0)
);--> statement-breakpoint
INSERT INTO `__repair_legacy_form_version_ids_postflight`
SELECT
	(SELECT count(*) FROM `form_versions` WHERE length(`id`) = 0 OR length(`id`) > 128 OR `id` GLOB '*[^A-Za-z0-9_-]*')
	+ (SELECT count(*) FROM `form_version_fields` WHERE length(`form_version_id`) = 0 OR length(`form_version_id`) > 128 OR `form_version_id` GLOB '*[^A-Za-z0-9_-]*')
	+ (SELECT count(*) FROM `submissions` WHERE length(`form_version_id`) = 0 OR length(`form_version_id`) > 128 OR `form_version_id` GLOB '*[^A-Za-z0-9_-]*')
	+ (SELECT count(*) FROM `submission_answers` WHERE length(`form_version_id`) = 0 OR length(`form_version_id`) > 128 OR `form_version_id` GLOB '*[^A-Za-z0-9_-]*');--> statement-breakpoint
DROP TABLE `__repair_legacy_form_version_ids_postflight`;