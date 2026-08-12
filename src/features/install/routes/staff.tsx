import { useEffect, useState, type FormEvent } from "react";
import { Schema } from "effect";
import { apiFetch } from "@/client/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  Input,
  PageHeader,
  Skeleton,
  Table,
  Toaster,
  toast,
} from "@/ui";
import {
  GrantInstallStaffOutput,
  InstallGrant,
  RevokeInstallStaffOutput,
  type InstallGrant as InstallGrantRecord,
} from "../schema";

export const path = "/staff";
export const contentWidth = "standard" as const;

export const fetchInstallGrants = (): Promise<readonly InstallGrantRecord[]> =>
  apiFetch("/api/v1/install/staff", { schema: Schema.Array(InstallGrant) });

const grantStaff = (email: string) => apiFetch("/api/v1/install/staff", {
  method: "POST",
  body: { email, idempotencyKey: crypto.randomUUID() },
  schema: GrantInstallStaffOutput,
});

const revokeStaff = (grant: InstallGrantRecord) => apiFetch(
  `/api/v1/install/staff/${encodeURIComponent(grant.id)}`,
  {
    method: "DELETE",
    body: { expectedVersion: grant.version, idempotencyKey: crypto.randomUUID() },
    schema: RevokeInstallStaffOutput,
  },
);

export default function StaffPage() {
  const [grants, setGrants] = useState<readonly InstallGrantRecord[] | null>(null);
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = () => {
    setGrants(null);
    void fetchInstallGrants().then(setGrants).catch((error) => {
      setGrants([]);
      toast(error instanceof Error ? error.message : "Could not load staff history", { tone: "danger" });
    });
  };
  useEffect(load, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await grantStaff(email);
      setEmail("");
      setGrants((current) => [result.grant, ...(current ?? []).filter((grant) => grant.id !== result.grant.id)]);
      toast(result.created ? "Install staff access granted." : "That account already has staff access.", { tone: "success" });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not grant staff access", { tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (grant: InstallGrantRecord) => {
    setRevoking(grant.id);
    try {
      const result = await revokeStaff(grant);
      setGrants((current) => current?.map((item) => item.id === result.grant.id ? result.grant : item) ?? [result.grant]);
      toast("Install staff access revoked.", { tone: "success" });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not revoke staff access", { tone: "danger" });
      load();
    } finally {
      setRevoking(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Install staff"
        description="Staff can organize every event in this installation. This authority is never available to API keys."
      />
      <Card title="Grant staff access">
        <form className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end" onSubmit={submit}>
          <Input
            label="Existing account email"
            type="email"
            required
            value={email}
            hint="The person must already have an account in this installation."
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button type="submit" className="min-h-11" loading={saving}>Grant staff</Button>
        </form>
      </Card>
      <Card className="mt-6" title="Grant history">
        {grants === null ? <Skeleton className="h-40" /> : (
          <Table
            columns={[
              { key: "person", header: "Person", render: (grant: InstallGrantRecord) => <span>{grant.name ?? grant.email}<span className="block text-xs text-ink-faint">{grant.email}</span></span> },
              { key: "status", header: "Status", render: (grant: InstallGrantRecord) => <Badge tone={grant.revokedAt ? "neutral" : "success"}>{grant.revokedAt ? "Revoked" : "Active staff"}</Badge> },
              { key: "granted", header: "Granted", render: (grant: InstallGrantRecord) => <span>{grant.grantedAt.toLocaleDateString()}<span className="block text-xs text-ink-faint">by {grant.grantedByEmail}</span></span> },
              { key: "revoked", header: "Revoked", render: (grant: InstallGrantRecord) => grant.revokedAt ? <span>{grant.revokedAt.toLocaleDateString()}<span className="block text-xs text-ink-faint">by {grant.revokedByEmail}</span></span> : "—" },
              { key: "actions", header: "Manage", render: (grant: InstallGrantRecord) => grant.revokedAt ? null : (
                <AlertDialog>
                  <AlertDialogTrigger asChild><Button type="button" size="sm" variant="ghost" loading={revoking === grant.id}>Revoke</Button></AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader><AlertDialogTitle>Revoke staff access?</AlertDialogTitle><AlertDialogDescription>{grant.email} will immediately lose install-wide organizer authority. Existing event memberships are unchanged.</AlertDialogDescription></AlertDialogHeader>
                    <AlertDialogFooter><AlertDialogCancel>Keep access</AlertDialogCancel><AlertDialogAction onClick={() => void revoke(grant)}>Revoke staff</AlertDialogAction></AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) },
            ]}
            rows={[...grants]}
            rowKey={(grant) => grant.id}
            empty="No staff grants have been recorded."
          />
        )}
      </Card>
      <Toaster />
    </>
  );
}
