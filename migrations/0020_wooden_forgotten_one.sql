ALTER TABLE `forms` ADD `cloned_from_event_id` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `cloned_from_form_id` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `cloned_from_version` integer;--> statement-breakpoint
CREATE TRIGGER `forms_clone_provenance_insert`
BEFORE INSERT ON `forms`
WHEN NOT (
  (NEW.`cloned_from_event_id` IS NULL AND NEW.`cloned_from_form_id` IS NULL AND NEW.`cloned_from_version` IS NULL)
  OR
  (NEW.`cloned_from_event_id` IS NOT NULL AND NEW.`cloned_from_form_id` IS NOT NULL AND NEW.`cloned_from_version` > 0)
)
BEGIN
  SELECT RAISE(ABORT, 'forms clone provenance must be complete');
END;--> statement-breakpoint
CREATE TRIGGER `forms_clone_provenance_update`
BEFORE UPDATE OF `cloned_from_event_id`, `cloned_from_form_id`, `cloned_from_version` ON `forms`
WHEN NOT (
  (NEW.`cloned_from_event_id` IS NULL AND NEW.`cloned_from_form_id` IS NULL AND NEW.`cloned_from_version` IS NULL)
  OR
  (NEW.`cloned_from_event_id` IS NOT NULL AND NEW.`cloned_from_form_id` IS NOT NULL AND NEW.`cloned_from_version` > 0)
)
BEGIN
  SELECT RAISE(ABORT, 'forms clone provenance must be complete');
END;
