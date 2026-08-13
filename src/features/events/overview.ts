import { External, type AppError } from "contracts/errors";
import { submissions } from "contracts/schema";
import { Effect } from "effect";
import { eq, sql } from "drizzle-orm";
import { listAgenda } from "@/features/agenda/service";
import { Db, type Authorizer, type CurrentUser } from "@/server/services";
import type {
  EventOverviewMetrics,
  EventOverviewSubmissionCounts,
  GetEventOverviewInput,
} from "./schema";

const database = <A>(run: () => Promise<A>): Effect.Effect<A, External> =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new External({ service: "database", detail: String(error) }),
  });

const emptySubmissionCounts = (): EventOverviewSubmissionCounts => ({
  submitted: 0,
  inReview: 0,
  accepted: 0,
  rejected: 0,
  waitlist: 0,
  withdrawn: 0,
});

export const getEventOverview = (
  input: GetEventOverviewInput,
): Effect.Effect<EventOverviewMetrics, AppError, Authorizer | CurrentUser | Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [submissionRows, agenda] = yield* Effect.all([
      database(() => db
        .select({
          status: submissions.status,
          total: sql<number>`count(*)`.mapWith(Number),
        })
        .from(submissions)
        .where(eq(submissions.eventId, input.eventId))
        .groupBy(submissions.status)),
      listAgenda({ eventId: input.eventId, view: "day" }),
    ]);
    const submissionCounts = submissionRows.reduce<EventOverviewSubmissionCounts>((counts, row) => {
      const key = row.status === "in_review" ? "inReview" : row.status;
      return { ...counts, [key]: row.total };
    }, emptySubmissionCounts());
    const activeTalks = agenda.talks.filter(({ status }) => status !== "cancelled");

    return {
      submissionCounts,
      agenda: {
        activeTalkCount: activeTalks.length,
        scheduledTalkCount: activeTalks.filter(({ roomId, startsAt }) => roomId !== null && startsAt !== null).length,
        backlogCount: agenda.backlog.length,
        unplacedTalkCount: agenda.warnings.unplacedTalkCount,
        conflictCount: agenda.warnings.conflictCount,
        publishedTalkCount: agenda.publication.talkCount,
      },
    };
  });
