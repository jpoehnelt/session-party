import { External, Forbidden, type AppError } from "contracts/errors";
import { installStaffAuthorization } from "contracts/principal";
import {
  acceptanceEvents,
  events,
  managedSpeakerEmails,
  speakerContacts,
  speakerProfiles,
  speakers,
  submissionSpeakers,
  submissions,
  talks,
  talkSpeakers,
  users,
} from "contracts/schema";
import { Effect } from "effect";
import { and, eq, inArray } from "drizzle-orm";
import { Authorizer, CurrentUser, Db } from "@/server/services";
import type {
  DirectoryContact,
  DirectoryIdentityMember,
  DirectoryParticipation,
  DirectoryReusableProfile,
  ListSpeakerDirectoryInput,
  SameNameSuggestion,
  SpeakerDirectoryEntry,
  SpeakerDirectoryPage,
} from "./schema";

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({
      service: "database",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

const normalizeEmail = (value: string | null | undefined): string | null => {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.includes("@") ? normalized : null;
};

const normalizeName = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

const requireInstallStaff = (): Effect.Effect<void, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const authorizer = yield* Authorizer;
    yield* authorizer.authorize({ principal, policy: installStaffAuthorization, eventId: null });
    if (principal.kind !== "browser-session") {
      return yield* Effect.fail(new Forbidden({ reason: "The speaker directory requires a staff browser session" }));
    }
  });

type ParticipationAccumulator = {
  eventId: string;
  eventName: string;
  submitted: boolean;
  accepted: boolean;
  spoke: boolean;
  submissionTitles: Set<string>;
  talkTitles: Set<string>;
  lastActivityAt: Date;
};

type EntryAccumulator = {
  groupKey: string;
  normalizedEmail: string | null;
  displayName: string;
  reusableProfile: DirectoryReusableProfile | null;
  members: DirectoryIdentityMember[];
  participation: Map<string, ParticipationAccumulator>;
  contacts: DirectoryContact[];
};

const participationOutput = (value: ParticipationAccumulator): DirectoryParticipation => ({
  eventId: value.eventId,
  eventName: value.eventName,
  submitted: value.submitted,
  accepted: value.accepted,
  spoke: value.spoke,
  submissionTitles: [...value.submissionTitles].sort((left, right) => left.localeCompare(right)),
  talkTitles: [...value.talkTitles].sort((left, right) => left.localeCompare(right)),
  lastActivityAt: value.lastActivityAt,
});

export const listSpeakerDirectory = (
  input: ListSpeakerDirectoryInput,
): Effect.Effect<SpeakerDirectoryPage, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    yield* requireInstallStaff();
    const { db } = yield* Db;
    const now = new Date();
    const [submissionRows, talkRows, acceptedRows] = yield* Effect.all([
      database(() => db.select({
        speakerId: submissionSpeakers.speakerId,
        submissionId: submissions.id,
        eventId: submissions.eventId,
        eventName: events.name,
        title: submissions.title,
        status: submissions.status,
        occurredAt: submissions.submittedAt,
      }).from(submissionSpeakers)
        .innerJoin(submissions, and(
          eq(submissions.eventId, submissionSpeakers.eventId),
          eq(submissions.id, submissionSpeakers.submissionId),
        ))
        .innerJoin(events, eq(events.id, submissions.eventId))),
      database(() => db.select({
        speakerId: talkSpeakers.speakerId,
        eventId: talks.eventId,
        eventName: events.name,
        title: talks.title,
        status: talks.status,
        startsAt: talks.startsAt,
        createdAt: talks.createdAt,
      }).from(talkSpeakers)
        .innerJoin(talks, and(eq(talks.eventId, talkSpeakers.eventId), eq(talks.id, talkSpeakers.talkId)))
        .innerJoin(events, eq(events.id, talks.eventId))),
      database(() => db.select({ submissionId: acceptanceEvents.submissionId })
        .from(acceptanceEvents)
        .where(eq(acceptanceEvents.type, "accepted"))),
    ]);
    const acceptedSubmissionIds = new Set(acceptedRows.map((row) => row.submissionId));
    const participatingSpeakerIds = [...new Set([
      ...submissionRows.map((row) => row.speakerId),
      ...talkRows.filter((row) => row.status === "confirmed" && row.startsAt !== null && row.startsAt <= now).map((row) => row.speakerId),
    ])];
    if (participatingSpeakerIds.length === 0) {
      return { entries: [], events: [], page: input.page ?? 1, pageSize: input.pageSize ?? 25, total: 0, hasMore: false };
    }

    const [identityRows, contactRows] = yield* Effect.all([
      database(() => db.select({
        speaker: speakers,
        event: { id: events.id, name: events.name },
        user: { id: users.id, email: users.email },
        managedEmail: managedSpeakerEmails.normalizedEmail,
        profile: speakerProfiles,
      }).from(speakers)
        .innerJoin(events, eq(events.id, speakers.eventId))
        .leftJoin(users, eq(users.id, speakers.userId))
        .leftJoin(managedSpeakerEmails, and(
          eq(managedSpeakerEmails.eventId, speakers.eventId),
          eq(managedSpeakerEmails.speakerId, speakers.id),
        ))
        .leftJoin(speakerProfiles, eq(speakerProfiles.userId, speakers.userId))
        .where(inArray(speakers.id, participatingSpeakerIds))),
      database(() => db.select({
        contact: speakerContacts,
        eventName: events.name,
        actorName: users.name,
      }).from(speakerContacts)
        .innerJoin(events, eq(events.id, speakerContacts.eventId))
        .innerJoin(users, eq(users.id, speakerContacts.actorUserId))
        .where(inArray(speakerContacts.speakerId, participatingSpeakerIds))),
    ]);

    const groups = new Map<string, EntryAccumulator>();
    const speakerGroup = new Map<string, string>();
    for (const row of identityRows) {
      const userId = row.user?.id ?? null;
      const email = normalizeEmail(row.user?.email)
        ?? normalizeEmail(row.managedEmail)
        ?? normalizeEmail(row.speaker.contactEmail);
      const groupKey = email ? `email:${email}` : `speaker:${row.speaker.id}`;
      const profile: DirectoryReusableProfile | null = row.profile ? {
        id: row.profile.id,
        userId: row.profile.userId,
        displayName: row.profile.displayName,
        title: row.profile.title,
        company: row.profile.company,
        bio: row.profile.bio,
        headshotUrl: row.profile.headshotUrl,
        links: [...(row.profile.links ?? [])],
        visible: row.profile.visible,
        version: row.profile.version,
      } : null;
      const member: DirectoryIdentityMember = {
        speakerId: row.speaker.id,
        eventId: row.event.id,
        eventName: row.event.name,
        kind: userId ? "claimed" : row.managedEmail ? "managed" : "event-record",
        userId,
        email,
        displayName: row.speaker.displayName,
        title: row.speaker.title,
        company: row.speaker.company,
        bio: row.speaker.bio,
        headshotUrl: row.speaker.headshotUrl,
        links: [...(row.speaker.links ?? [])],
        profileReviewStatus: row.speaker.profileReviewStatus,
        profileSourceId: row.speaker.profileSourceId,
        profileSourceVersion: row.speaker.profileSourceVersion,
      };
      const existing = groups.get(groupKey);
      if (existing) {
        existing.members.push(member);
        if (!existing.reusableProfile && profile) existing.reusableProfile = profile;
      } else {
        groups.set(groupKey, {
          groupKey,
          normalizedEmail: email,
          displayName: profile?.displayName ?? member.displayName,
          reusableProfile: profile,
          members: [member],
          participation: new Map(),
          contacts: [],
        });
      }
      speakerGroup.set(row.speaker.id, groupKey);
    }

    const activity = (
      speakerId: string,
      eventId: string,
      eventName: string,
      occurredAt: Date,
    ): ParticipationAccumulator | null => {
      const group = groups.get(speakerGroup.get(speakerId) ?? "");
      if (!group) return null;
      const existing = group.participation.get(eventId);
      if (existing) {
        if (occurredAt > existing.lastActivityAt) existing.lastActivityAt = occurredAt;
        return existing;
      }
      const created: ParticipationAccumulator = {
        eventId,
        eventName,
        submitted: false,
        accepted: false,
        spoke: false,
        submissionTitles: new Set(),
        talkTitles: new Set(),
        lastActivityAt: occurredAt,
      };
      group.participation.set(eventId, created);
      return created;
    };

    for (const row of submissionRows) {
      const participation = activity(row.speakerId, row.eventId, row.eventName, row.occurredAt);
      if (!participation) continue;
      participation.submitted = true;
      participation.accepted ||= row.status === "accepted" || acceptedSubmissionIds.has(row.submissionId);
      participation.submissionTitles.add(row.title);
    }
    for (const row of talkRows) {
      if (row.status !== "confirmed" || row.startsAt === null || row.startsAt > now) continue;
      const participation = activity(row.speakerId, row.eventId, row.eventName, row.startsAt ?? row.createdAt);
      if (!participation) continue;
      participation.spoke = true;
      participation.talkTitles.add(row.title);
    }
    for (const row of contactRows) {
      const group = groups.get(speakerGroup.get(row.contact.speakerId) ?? "");
      if (!group) continue;
      group.contacts.push({
        id: row.contact.id,
        eventId: row.contact.eventId,
        eventName: row.eventName,
        speakerId: row.contact.speakerId,
        actorUserId: row.contact.actorUserId,
        actorName: row.actorName,
        medium: row.contact.medium,
        note: row.contact.note,
        contactedAt: row.contact.contactedAt,
      });
    }

    const nameGroups = new Map<string, EntryAccumulator[]>();
    for (const group of groups.values()) {
      const name = normalizeName(group.displayName);
      nameGroups.set(name, [...(nameGroups.get(name) ?? []), group]);
    }

    let entries: SpeakerDirectoryEntry[] = [];
    for (const group of groups.values()) {
      const members = [...group.members].sort((left, right) =>
        left.eventName.localeCompare(right.eventName) || left.speakerId.localeCompare(right.speakerId));
      const participation = [...group.participation.values()]
        .map(participationOutput)
        .sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime() || left.eventName.localeCompare(right.eventName));
      if (!members[0] || !participation[0]) continue;
      const sameNameSuggestions: SameNameSuggestion[] = (nameGroups.get(normalizeName(group.displayName)) ?? [])
        .filter((candidate) => candidate.groupKey !== group.groupKey)
        .map((candidate) => ({
          groupKey: candidate.groupKey,
          normalizedEmail: candidate.normalizedEmail,
          displayName: candidate.displayName,
        }));
      entries.push({
        groupKey: group.groupKey,
        normalizedEmail: group.normalizedEmail,
        displayName: group.displayName,
        reusableProfile: group.reusableProfile,
        members: [members[0], ...members.slice(1)],
        participation: [participation[0], ...participation.slice(1)],
        contacts: [...group.contacts].sort((left, right) => right.contactedAt.getTime() - left.contactedAt.getTime()),
        sameNameSuggestions,
      });
    }

    const query = input.query?.trim().toLowerCase() ?? "";
    if (query) {
      entries = entries.filter((entry) => JSON.stringify({
        email: entry.normalizedEmail,
        displayName: entry.displayName,
        profile: entry.reusableProfile,
        members: entry.members.map(({ displayName, email, title, company, bio, links }) => ({ displayName, email, title, company, bio, links })),
      }).toLowerCase().includes(query));
    }
    if (input.eventId || input.status) {
      entries = entries.filter((entry) => entry.participation.some((participation) =>
        (!input.eventId || participation.eventId === input.eventId)
        && (!input.status || participation[input.status])));
    }
    entries.sort((left, right) => left.displayName.localeCompare(right.displayName)
      || (left.normalizedEmail ?? left.groupKey).localeCompare(right.normalizedEmail ?? right.groupKey));

    const eventMap = new Map<string, string>();
    for (const group of groups.values()) {
      for (const participation of group.participation.values()) eventMap.set(participation.eventId, participation.eventName);
    }
    const directoryEvents = [...eventMap].map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 25;
    const offset = (page - 1) * pageSize;
    return {
      entries: entries.slice(offset, offset + pageSize),
      events: directoryEvents,
      page,
      pageSize,
      total: entries.length,
      hasMore: offset + pageSize < entries.length,
    };
  });
