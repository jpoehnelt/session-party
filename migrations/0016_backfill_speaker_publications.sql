WITH `latest_agenda_publications` AS (
	SELECT `publication`.*
	FROM `domain_changes` AS `publication`
	WHERE `publication`.`aggregate_type` = 'agenda-publication'
		AND `publication`.`event_type` = 'agenda/published'
		AND NOT EXISTS (
			SELECT 1
			FROM `domain_changes` AS `newer`
			WHERE `newer`.`event_id` = `publication`.`event_id`
				AND `newer`.`aggregate_type` = 'agenda-publication'
				AND `newer`.`event_type` = 'agenda/published'
				AND `newer`.`aggregate_version` > `publication`.`aggregate_version`
		)
),
`speaker_publication_backfill` AS (
	SELECT
		`publication`.`event_id`,
		`publication`.`aggregate_version` AS `revision`,
		`publication`.`occurred_at` AS `published_at`,
		json_object(
			'event', json_object(
				'id', `event`.`id`,
				'slug', `event`.`slug`,
				'name', `event`.`name`,
				'description', `event`.`description`,
				'location', `event`.`location`,
				'timezone', `event`.`timezone`,
				'startsAt', `event`.`starts_at`,
				'endsAt', `event`.`ends_at`,
				'bannerAssetId', `event`.`banner_asset_id`,
				'accentColor', `event`.`accent_color`
			),
			'revision', `publication`.`aggregate_version`,
			'publishedAt', `publication`.`occurred_at`,
			'speakers', json(COALESCE((
				SELECT json_group_array(json(`eligible`.`speaker_json`))
				FROM (
					SELECT json_object(
						'id', `speaker`.`id`,
						'displayName', `speaker`.`display_name`,
						'title', `speaker`.`title`,
						'company', `speaker`.`company`,
						'bio', `speaker`.`bio`,
						'headshotAssetId', `speaker`.`headshot_asset_id`,
						'links', json(COALESCE(`speaker`.`links`, '[]'))
					) AS `speaker_json`
					FROM `speakers` AS `speaker`
					WHERE `speaker`.`event_id` = `publication`.`event_id`
						AND `speaker`.`visible` = 1
						AND (
							EXISTS (
								SELECT 1
								FROM `managed_speaker_emails` AS `managed`
								WHERE `managed`.`event_id` = `speaker`.`event_id`
									AND `managed`.`speaker_id` = `speaker`.`id`
							) OR EXISTS (
								SELECT 1
								FROM `acceptance_events` AS `acceptance`
								INNER JOIN `speaker_provisioning` AS `provisioning`
									ON `provisioning`.`event_id` = `acceptance`.`event_id`
									AND `provisioning`.`acceptance_event_id` = `acceptance`.`id`
									AND `provisioning`.`status` = 'provisioned'
								WHERE `acceptance`.`event_id` = `speaker`.`event_id`
									AND `acceptance`.`primary_speaker_id` = `speaker`.`id`
									AND `acceptance`.`type` = 'accepted'
									AND NOT EXISTS (
										SELECT 1
										FROM `acceptance_events` AS `newer_acceptance`
										WHERE `newer_acceptance`.`event_id` = `acceptance`.`event_id`
											AND `newer_acceptance`.`submission_id` = `acceptance`.`submission_id`
											AND (
												`newer_acceptance`.`occurred_at` > `acceptance`.`occurred_at`
												OR (
													`newer_acceptance`.`occurred_at` = `acceptance`.`occurred_at`
													AND `newer_acceptance`.`id` > `acceptance`.`id`
												)
											)
									)
							)
						)
					ORDER BY `speaker`.`display_name`, `speaker`.`id`
				) AS `eligible`
			), '[]'))
		) AS `payload`
	FROM `latest_agenda_publications` AS `publication`
	INNER JOIN `events` AS `event` ON `event`.`id` = `publication`.`event_id`
	WHERE NOT EXISTS (
		SELECT 1
		FROM `domain_changes` AS `existing`
		WHERE `existing`.`event_id` = `publication`.`event_id`
			AND `existing`.`aggregate_type` = 'speaker-publication'
			AND `existing`.`aggregate_id` = `publication`.`event_id`
			AND `existing`.`aggregate_version` = `publication`.`aggregate_version`
			AND `existing`.`event_type` = 'portal/speakers-published'
	)
)
INSERT INTO `domain_changes` (
	`id`, `event_id`, `aggregate_type`, `aggregate_id`, `aggregate_version`, `event_type`,
	`audiences`, `payload`, `actor_user_id`, `actor_api_key_id`, `request_id`,
	`idempotency_record_id`, `occurred_at`
)
SELECT
	'speaker-publication-backfill-' || `event_id` || '-' || `revision`,
	`event_id`,
	'speaker-publication',
	`event_id`,
	`revision`,
	'portal/speakers-published',
	json('[{"kind":"public"}]'),
	`payload`,
	NULL,
	NULL,
	'speaker-publication-backfill-' || `event_id` || '-' || `revision`,
	NULL,
	`published_at`
FROM `speaker_publication_backfill`;
