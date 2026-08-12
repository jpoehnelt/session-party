export const demoTarget = {
  eventId: "demo-event",
  eventSlug: "ai-engineer-sandbox",
  productionConfirmation: "ai-engineer-sandbox",
} as const;

export interface DemoUserIdentity {
  readonly id: string;
  readonly email: string;
}

export interface ProductionEventIdentity {
  readonly id: string;
  readonly slug: string;
}

const sqlQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const appendUpsert = (
  statement: string,
  conflictColumns: readonly string[],
  updateColumns: readonly string[],
): string => {
  if (!statement.endsWith(";")) throw new Error("Exported demo insert must end with a semicolon.");
  const conflict = conflictColumns.map((column) => `"${column}"`).join(",");
  const updates = updateColumns.map((column) => `"${column}"=excluded."${column}"`).join(",");
  return `${statement.slice(0, -1)} ON CONFLICT(${conflict}) DO UPDATE SET ${updates};`;
};

export function reconcileDemoInsert(statement: string): string {
  if (statement.startsWith('INSERT INTO "users"')) {
    return statement.replace('INSERT INTO "users"', 'INSERT OR IGNORE INTO "users"');
  }
  if (statement.startsWith('INSERT INTO "speaker_profiles"')) {
    // The reusable profile belongs to the fixture user, not to one event. Reconcile
    // it in place so another event's snapshot/source link is never deleted.
    return appendUpsert(statement, ["user_id"], [
      "id",
      "slug",
      "display_name",
      "title",
      "company",
      "bio",
      "headshot_url",
      "links",
      "visible",
      "version",
      "created_at",
      "updated_at",
    ]);
  }
  if (statement.startsWith('INSERT INTO "speaker_profile_changes"')) {
    return appendUpsert(statement, ["profile_id", "profile_version"], [
      "id",
      "actor_user_id",
      "before",
      "after",
      "created_at",
    ]);
  }
  return statement;
}

export function assertExactProductionTarget(rows: readonly ProductionEventIdentity[]): void {
  if (
    rows.length !== 1
    || rows[0]?.id !== demoTarget.eventId
    || rows[0]?.slug !== demoTarget.eventSlug
  ) {
    throw new Error(
      `Replacement requires exactly ${demoTarget.eventId}/${demoTarget.eventSlug}; found ${JSON.stringify(rows)}.`,
    );
  }
}

export function assertCompatibleDemoUsers(
  localUsers: readonly DemoUserIdentity[],
  remoteUsers: readonly DemoUserIdentity[],
): void {
  const localById = new Map(localUsers.map((user) => [user.id, user.email.toLowerCase()]));
  const localByEmail = new Map(localUsers.map((user) => [user.email.toLowerCase(), user.id]));
  for (const remote of remoteUsers) {
    const email = remote.email.toLowerCase();
    if (localById.get(remote.id) !== email || localByEmail.get(email) !== remote.id) {
      throw new Error(
        `Production user collision is not the deterministic demo identity: ${remote.id}/${remote.email}.`,
      );
    }
  }
}

export function buildDemoReplacementSql(
  orderedInserts: readonly string[],
  productionOwnerUserId: string,
  membershipNow: number,
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(productionOwnerUserId)) {
    throw new Error("Production owner ID contains unsupported characters.");
  }
  if (!Number.isSafeInteger(membershipNow) || membershipNow <= 0) {
    throw new Error("Membership timestamp must be a positive safe integer.");
  }
  const eventInserts = orderedInserts.filter((statement) => statement.startsWith('INSERT INTO "events"'));
  if (
    eventInserts.length !== 1
    || !eventInserts[0]?.includes(demoTarget.eventId)
    || !eventInserts[0]?.includes(demoTarget.eventSlug)
  ) {
    throw new Error("Demo snapshot must contain exactly the locked event identity.");
  }
  const safeInserts = orderedInserts.map(reconcileDemoInsert);
  return [
    "-- Session Party demo-event replacement. Generated locally after isolated import validation.",
    `-- Scope is locked to ${demoTarget.eventId}/${demoTarget.eventSlug}; user rows are retained when their exact identity already exists.`,
    "PRAGMA defer_foreign_keys=TRUE;",
    `DELETE FROM events WHERE id = ${sqlQuote(demoTarget.eventId)} AND slug = ${sqlQuote(demoTarget.eventSlug)};`,
    ...safeInserts,
    `INSERT INTO event_members (id, event_id, user_id, role, version, created_at, updated_at)
SELECT 'production-demo-owner', ${sqlQuote(demoTarget.eventId)}, ${sqlQuote(productionOwnerUserId)}, 'owner', 1, ${membershipNow}, ${membershipNow}
WHERE NOT EXISTS (
  SELECT 1 FROM event_members
  WHERE event_id = ${sqlQuote(demoTarget.eventId)} AND user_id = ${sqlQuote(productionOwnerUserId)}
);`,
    "",
  ].join("\n");
}

export function fixtureUserCollisionSql(users: readonly DemoUserIdentity[]): string {
  if (users.length === 0) throw new Error("Demo snapshot contains no fixture users.");
  const ids = users.map(({ id }) => sqlQuote(id)).join(", ");
  const emails = users.map(({ email }) => sqlQuote(email.toLowerCase())).join(", ");
  return `SELECT id, email FROM users WHERE id IN (${ids}) OR lower(email) IN (${emails}) ORDER BY id;`;
}
