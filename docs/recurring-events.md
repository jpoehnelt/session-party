# Recurring events and install staff

Session Party supports repeat editions without introducing organization tenancy or a hidden CRM. Events remain the authorization and data-isolation boundary. Cross-event workflows are explicit organizer actions in the browser.

## Install staff

Private installations configured with `INITIAL_ADMIN_EMAIL` can grant a signed-in account the single install role `staff`. Active staff authority satisfies event owner/admin checks across the installation and is rechecked on each protected request. Grants and revocations are durable, idempotent, and audited.

Open-registration installations—where `INITIAL_ADMIN_EMAIL` is unset—cannot create or use install-wide staff grants. Event memberships remain the only source of organizer authority there.

Install staff does not create shadow event memberships and does not widen event-scoped API keys. The staff-management and other cross-event operations are browser-session only.

## Speaker history and returning invitations

Install staff can search prior-event speaker history by identity, email, event, and workflow outcome. The directory links records only through explicit managed-email claims or signed-in user identity; matching names alone never merge people.

Inviting a returning speaker is a preview-and-confirm workflow. It copies either the reusable speaker profile or a selected historical event profile into the target event as a new `in_review` record. It does not accept the speaker, send email, copy submissions, or copy portal completion state. Replays are idempotent and conflicts do not partially mutate the target.

## Copying a team

An owner, admin, or install staff member who can manage both events can preview and copy the source event's owner/admin/reviewer memberships. Existing target members are skipped and keep their current roles. The operation is atomic, idempotent, and safe when two copies race.

## Cloning a next edition

The event settings page previews exact counts before creating a required-name, required-slug, dated target event. The target starts private and unpublished. The source event and its public revisions remain unchanged.

The clone copies only reusable structure:

| Copied as new target records | Deliberately excluded |
|---|---|
| Forms, using the latest published version when one exists | Submissions and speaker associations |
| Form fields and semantic keys | Reviews and decisions |
| Review rounds and rubrics, reset to pending with no dates | Speakers, profiles, contacts, tasks assignments, and portal completion state |
| Task templates, with deadlines cleared | Talks, placements, and published agenda revisions |
| Resource/wiki pages | Published form versions |
| Tracks and rooms | Embeds and public-program state |
| Message templates with placeholders intact | Deliveries and rendered message snapshots |
| Optional team memberships through the team-copy operation | API keys, integrations, provider configuration, and secrets |

Every cloned form is a new unpublished draft with source-event, source-form, and source-version provenance. Conditional logic is remapped to the new field IDs, and task templates are remapped to the new form IDs. No public revision points at the cloned records.

Preview fingerprints and source versions guard against applying a stale plan. Applying the same idempotency key returns the original target, and concurrent clone/team-copy attempts cannot create duplicate events or memberships.

## Deterministic demo fixture

The local seed includes `AI Engineer Sandbox 2027` (`demo-next-edition`). It represents a structure-only second edition: draft form provenance, pending review rounds, reusable tracks and rooms, a task template, a speaker resource page, a message template, and copied team roles. It intentionally contains none of the excluded operational or public state above.
