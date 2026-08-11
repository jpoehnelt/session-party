import { External, NotFound, type AppError } from "contracts/errors";
import { eventAuthorization } from "contracts/principal";
import {
  acceptanceEvents,
  events,
  reviewComments,
  reviews,
  speakerContacts,
  speakers,
  submissionAnswers,
  submissionSpeakers,
  submissions,
  talkSpeakers,
  talks,
  taskCompletions,
  tasks,
} from "contracts/schema";
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { Authorizer, CurrentUser, Db } from "@/server/services";
import type { GetInstitutionalArchiveInput, InstitutionalArchive } from "./schema";

const exportAuthorization = eventAuthorization(
  { kind: "event-member", roles: ["owner", "admin"] },
  { kind: "deny" },
);

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({
      service: "database",
      detail: error instanceof Error ? error.message : String(error),
    }),
  });

const millis = (value: Date): number => value.getTime();
const nullableMillis = (value: Date | null): number | null => value === null ? null : value.getTime();

export const getInstitutionalArchive = (
  input: GetInstitutionalArchiveInput,
): Effect.Effect<InstitutionalArchive, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const principal = yield* CurrentUser;
    const authorizer = yield* Authorizer;
    yield* authorizer.authorize({ principal, policy: exportAuthorization, eventId: input.eventId });
    const { db } = yield* Db;

    const [event] = yield* database(() =>
      db.select().from(events).where(eq(events.id, input.eventId)).limit(1),
    );
    if (!event) return yield* Effect.fail(new NotFound({ entity: "event", id: input.eventId }));

    const [
      speakerRows,
      submissionRows,
      submissionSpeakerRows,
      answerRows,
      talkRows,
      talkSpeakerRows,
      reviewRows,
      reviewCommentRows,
      decisionRows,
      taskRows,
      completionRows,
      contactRows,
    ] = yield* Effect.all([
      database(() => db.select().from(speakers).where(eq(speakers.eventId, input.eventId)).orderBy(asc(speakers.id))),
      database(() => db.select().from(submissions).where(eq(submissions.eventId, input.eventId)).orderBy(asc(submissions.submittedAt), asc(submissions.id))),
      database(() => db.select().from(submissionSpeakers).where(eq(submissionSpeakers.eventId, input.eventId)).orderBy(asc(submissionSpeakers.submissionId), asc(submissionSpeakers.id))),
      database(() => db.select().from(submissionAnswers).where(eq(submissionAnswers.eventId, input.eventId)).orderBy(asc(submissionAnswers.submissionId), asc(submissionAnswers.formVersionFieldId), asc(submissionAnswers.id))),
      database(() => db.select().from(talks).where(eq(talks.eventId, input.eventId)).orderBy(asc(talks.startsAt), asc(talks.id))),
      database(() => db.select().from(talkSpeakers).where(eq(talkSpeakers.eventId, input.eventId)).orderBy(asc(talkSpeakers.talkId), asc(talkSpeakers.speakerId))),
      database(() => db.select().from(reviews).where(eq(reviews.eventId, input.eventId)).orderBy(asc(reviews.submissionId), asc(reviews.roundId), asc(reviews.id))),
      database(() => db.select().from(reviewComments).where(eq(reviewComments.eventId, input.eventId)).orderBy(asc(reviewComments.submissionId), asc(reviewComments.createdAt), asc(reviewComments.id))),
      database(() => db.select().from(acceptanceEvents).where(eq(acceptanceEvents.eventId, input.eventId)).orderBy(asc(acceptanceEvents.occurredAt), asc(acceptanceEvents.id))),
      database(() => db.select().from(tasks).where(eq(tasks.eventId, input.eventId)).orderBy(asc(tasks.order), asc(tasks.id))),
      database(() => db.select().from(taskCompletions).where(eq(taskCompletions.eventId, input.eventId)).orderBy(asc(taskCompletions.completedAt), asc(taskCompletions.id))),
      database(() => db.select().from(speakerContacts).where(eq(speakerContacts.eventId, input.eventId)).orderBy(asc(speakerContacts.contactedAt), asc(speakerContacts.id))),
    ], { concurrency: 1 });

    const speakersBySubmission = new Map<string, typeof submissionSpeakerRows>();
    for (const row of submissionSpeakerRows) {
      const rows = speakersBySubmission.get(row.submissionId) ?? [];
      rows.push(row);
      speakersBySubmission.set(row.submissionId, rows);
    }
    const answersBySubmission = new Map<string, typeof answerRows>();
    for (const row of answerRows) {
      const rows = answersBySubmission.get(row.submissionId) ?? [];
      rows.push(row);
      answersBySubmission.set(row.submissionId, rows);
    }
    const speakersByTalk = new Map<string, string[]>();
    for (const row of talkSpeakerRows) {
      const ids = speakersByTalk.get(row.talkId) ?? [];
      ids.push(row.speakerId);
      speakersByTalk.set(row.talkId, ids);
    }

    return {
      format: "session-party.archive.v1",
      exportedAt: Date.now(),
      event: {
        id: event.id,
        slug: event.slug,
        name: event.name,
        description: event.description,
        location: event.location,
        timezone: event.timezone,
        startsAt: nullableMillis(event.startsAt),
        endsAt: nullableMillis(event.endsAt),
        version: event.version,
        createdAt: millis(event.createdAt),
        updatedAt: millis(event.updatedAt),
      },
      speakers: speakerRows.map((speaker) => ({
        id: speaker.id,
        eventId: speaker.eventId,
        userId: speaker.userId,
        contactEmail: speaker.contactEmail,
        displayName: speaker.displayName,
        title: speaker.title,
        organization: speaker.company,
        bio: speaker.bio,
        visible: speaker.visible,
        version: speaker.version,
        createdAt: millis(speaker.createdAt),
        updatedAt: millis(speaker.updatedAt),
      })),
      submissions: submissionRows.map((submission) => ({
        id: submission.id,
        eventId: submission.eventId,
        formId: submission.formId,
        formVersionId: submission.formVersionId,
        title: submission.title,
        category: submission.category,
        status: submission.status,
        submittedAt: millis(submission.submittedAt),
        acceptedAt: nullableMillis(submission.acceptedAt),
        version: submission.version,
        createdAt: millis(submission.createdAt),
        updatedAt: millis(submission.updatedAt),
        speakers: (speakersBySubmission.get(submission.id) ?? []).map((association) => ({
          id: association.id,
          speakerId: association.speakerId,
          isPrimary: association.isPrimary,
          roleLabel: association.roleLabel ?? (association.isPrimary ? "Primary presenter" : "Co-presenter"),
          titleAtTime: association.titleAtTime,
          organizationAtTime: association.organizationAtTime,
          linkedAt: millis(association.createdAt),
        })),
        answers: (answersBySubmission.get(submission.id) ?? []).map((answer) => ({
          id: answer.id,
          fieldId: answer.formVersionFieldId,
          value: answer.value,
          version: answer.version,
          createdAt: millis(answer.createdAt),
          updatedAt: millis(answer.updatedAt),
        })),
      })),
      sessions: talkRows.map((talk) => ({
        id: talk.id,
        eventId: talk.eventId,
        submissionId: talk.submissionId,
        title: talk.title,
        description: talk.description,
        trackId: talk.trackId,
        roomId: talk.roomId,
        startsAt: nullableMillis(talk.startsAt),
        durationMin: talk.durationMin,
        status: talk.status,
        version: talk.version,
        speakerIds: speakersByTalk.get(talk.id) ?? [],
        createdAt: millis(talk.createdAt),
        updatedAt: millis(talk.updatedAt),
      })),
      reviews: reviewRows.map((review) => ({
        id: review.id,
        eventId: review.eventId,
        roundId: review.roundId,
        submissionId: review.submissionId,
        reviewerUserId: review.reviewerUserId,
        ai: review.ai,
        score: review.score,
        scores: review.scores,
        comment: review.comment,
        version: review.version,
        createdAt: millis(review.createdAt),
        updatedAt: millis(review.updatedAt),
      })),
      reviewComments: reviewCommentRows.map((comment) => ({
        id: comment.id,
        eventId: comment.eventId,
        submissionId: comment.submissionId,
        authorUserId: comment.authorUserId,
        body: comment.body,
        createdAt: millis(comment.createdAt),
      })),
      decisions: decisionRows.map((decision) => ({
        id: decision.id,
        eventId: decision.eventId,
        submissionId: decision.submissionId,
        primarySpeakerId: decision.primarySpeakerId,
        type: decision.type,
        submissionVersion: decision.submissionVersion,
        actorUserId: decision.actorUserId,
        occurredAt: millis(decision.occurredAt),
      })),
      tasks: taskRows.map((task) => ({
        id: task.id,
        eventId: task.eventId,
        name: task.name,
        description: task.description,
        kind: task.kind,
        formId: task.formId,
        dueAt: nullableMillis(task.dueAt),
        order: task.order,
        version: task.version,
        createdAt: millis(task.createdAt),
        updatedAt: millis(task.updatedAt),
      })),
      taskCompletions: completionRows.map((completion) => ({
        id: completion.id,
        eventId: completion.eventId,
        taskId: completion.taskId,
        speakerId: completion.speakerId,
        completedAt: millis(completion.completedAt),
        data: completion.data,
        version: completion.version,
        createdAt: millis(completion.createdAt),
        updatedAt: millis(completion.updatedAt),
      })),
      speakerContacts: contactRows.map((contact) => ({
        id: contact.id,
        eventId: contact.eventId,
        speakerId: contact.speakerId,
        actorUserId: contact.actorUserId,
        medium: contact.medium,
        note: contact.note,
        contactedAt: millis(contact.contactedAt),
        createdAt: millis(contact.createdAt),
      })),
    };
  });
