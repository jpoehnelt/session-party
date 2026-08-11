import { useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { Badge, Button, Card, Checkbox, Input, Select, Table, Toaster, toast } from "@/ui";
import type { ContentAsset, ContentLibrary } from "../schema";
import { addContentComment, downloadContent, getContentLibrary, restoreContentVersion } from "./api";
import { RouteFailure, RouteLoading, useRouteLoad } from "../components/route-state";
import { ProductionHeader, ProductionSectionLabel, ProductionStats, productionTableClass } from "../components/production-ui";

export const path = "/e/:eventSlug/content";
export const contentWidth = "wide" as const;

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const u16 = (value: number) => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
const u32 = (value: number) => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
const joinBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
};

/** Builds a standards-compliant, uncompressed ZIP without a browser dependency. */
export function buildStoredZip(files: readonly { readonly name: string; readonly bytes: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const checksum = crc32(file.bytes);
    const local = joinBytes([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(checksum), u32(file.bytes.length), u32(file.bytes.length), u16(name.length), u16(0), name, file.bytes,
    ]);
    localParts.push(local);
    centralParts.push(joinBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(checksum), u32(file.bytes.length), u32(file.bytes.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(localOffset), name,
    ]));
    localOffset += local.length;
  }
  const central = joinBytes(centralParts);
  return joinBytes([
    ...localParts,
    central,
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(localOffset), u16(0),
  ]);
}

const safeFilename = (value: string) => value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "content";

const saveBlob = (filename: string, bytes: Uint8Array, contentType: string) => {
  const blob = new Blob([bytes as BlobPart], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export default function OrganizerContentRoute() {
  const { eventSlug = "" } = useParams();
  const [state, retry] = useRouteLoad(() => getContentLibrary(eventSlug), eventSlug);
  const [busy, setBusy] = useState<string | null>(null);
  if (state.status === "loading") return <RouteLoading label="Loading speaker content" />;
  if (state.status === "error") return <RouteFailure message={state.message} onRetry={retry} />;

  const perform = async (id: string, action: () => Promise<unknown>, success?: string, refresh = true) => {
    setBusy(id);
    try {
      await action();
      if (success) toast(success, { tone: "success" });
      if (refresh) retry();
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Content action failed", { tone: "danger" });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const fetchAsset = (asset: ContentAsset) => downloadContent(state.data.event.id, { eventId: state.data.event.id, assetId: asset.id });
  return <>
    <OrganizerContentLibrary
      library={state.data}
      busy={busy}
      onComment={(asset, body) => perform(asset.id, () => addContentComment(state.data.event.id, {
        eventId: state.data.event.id, assetId: asset.id, body, idempotencyKey: crypto.randomUUID(),
      }), "Comment added")}
      onRestore={(asset) => {
        const current = state.data.assets.find((candidate) =>
          candidate.speakerId === asset.speakerId && candidate.purpose === asset.purpose && candidate.current
        );
        if (!current) return Promise.resolve();
        return perform(asset.id, () => restoreContentVersion(state.data.event.id, {
          eventId: state.data.event.id,
          assetId: asset.id,
          expectedCurrentAssetId: current.id,
          expectedCurrentVersion: current.version,
          expectedSpeakerVersion: asset.speakerVersion,
          idempotencyKey: crypto.randomUUID(),
        }), "Version restored");
      }}
      onDownload={(asset) => perform(`download:${asset.id}`, async () => {
        const output = await fetchAsset(asset);
        saveBlob(output.asset.filename, fromBase64(output.contentBase64), output.asset.contentType);
      }, undefined, false)}
      onDownloadZip={(assets) => perform("zip", async () => {
        const downloaded = await Promise.all(assets.map(fetchAsset));
        const files = downloaded.map((output) => ({
          name: `${safeFilename(output.asset.speakerName)}-${output.asset.purpose}-v${output.asset.version}-${safeFilename(output.asset.filename)}`,
          bytes: fromBase64(output.contentBase64),
        }));
        saveBlob(`${safeFilename(state.data.event.name)}-speaker-content.zip`, buildStoredZip(files), "application/zip");
      }, undefined, false)}
    />
    <Toaster />
  </>;
}

export function OrganizerContentLibrary({
  library,
  busy = null,
  onComment,
  onRestore,
  onDownload,
  onDownloadZip,
}: {
  readonly library: ContentLibrary;
  readonly busy?: string | null;
  readonly onComment: (asset: ContentAsset, body: string) => boolean | void | Promise<boolean | void>;
  readonly onRestore: (asset: ContentAsset) => boolean | void | Promise<boolean | void>;
  readonly onDownload: (asset: ContentAsset) => boolean | void | Promise<boolean | void>;
  readonly onDownloadZip: (assets: readonly ContentAsset[]) => boolean | void | Promise<boolean | void>;
}) {
  const [query, setQuery] = useState("");
  const [purpose, setPurpose] = useState("all");
  const [versions, setVersions] = useState("current");
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [exportStatus, setExportStatus] = useState("");
  const filtered = useMemo(() => library.assets.filter((asset) => {
    const matchesQuery = !query.trim() || [asset.speakerName, asset.filename, asset.purpose].some((value) => value.toLowerCase().includes(query.trim().toLowerCase()));
    return matchesQuery && (purpose === "all" || asset.purpose === purpose) && (versions === "history" || asset.current);
  }), [library.assets, purpose, query, versions]);
  const selected = library.assets.filter((asset) => asset.current && selectedIds.includes(asset.id));
  const currentCount = library.assets.filter((asset) => asset.current).length;
  const speakerCount = new Set(library.assets.map((asset) => asset.speakerId)).size;
  const startZip = async () => {
    if (selected.length === 0) return;
    setExportStatus(`Generating ZIP for ${selected.length} latest file${selected.length === 1 ? "" : "s"}…`);
    try {
      const result = await onDownloadZip(selected);
      if (result === false) {
        setExportStatus("ZIP generation failed. Try again.");
        return;
      }
      setExportStatus(`ZIP download started for ${selected.length} latest file${selected.length === 1 ? "" : "s"}.`);
    } catch {
      setExportStatus("ZIP generation failed. Try again.");
    }
  };
  return <div className="space-y-8">
    <ProductionHeader
      eyebrow="Organizer control room / Deliverables"
      title="Speaker content"
      description={`Central file library for ${library.event.name}, including retained versions and cross-role comments.`}
      accent="sky"
    />
    <ProductionStats stats={[
      { label: "Current files", value: currentCount, tone: "sky" },
      { label: "Speakers", value: speakerCount, tone: "lime" },
      { label: "Retained versions", value: library.assets.length - currentCount, tone: "purple" },
    ]} />
    <section>
      <ProductionSectionLabel>Content library</ProductionSectionLabel>
      <div className="mb-4 grid gap-3 border-2 border-[#171714] bg-[#fffdf7] p-4 sm:grid-cols-[minmax(0,1fr)_12rem_12rem]">
        <Input type="search" label="Search" placeholder="Speaker, filename, or type" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        <Select label="Purpose" value={purpose} onChange={(event) => setPurpose(event.currentTarget.value)}>
          <option value="all">All files</option><option value="headshot">Headshots</option><option value="slides">Slides</option><option value="document">Documents</option>
        </Select>
        <Select label="Versions" value={versions} onChange={(event) => setVersions(event.currentTarget.value)}>
          <option value="current">Current only</option><option value="history">All history</option>
        </Select>
      </div>
      <Card className="mb-4" title={`${selected.length} files selected`}>
        <div className="flex flex-wrap gap-3">
          <Button disabled={selected.length === 0 || busy === "zip"} loading={busy === "zip"} onClick={() => void startZip()}>Download selected ZIP</Button>
          <Button variant="ghost" onClick={() => setSelectedIds(filtered.filter((asset) => asset.current).map((asset) => asset.id))}>Select current results</Button>
          <Button variant="ghost" onClick={() => setSelectedIds([])}>Clear</Button>
        </div>
        {exportStatus ? <p className="mt-3 text-sm font-semibold" role="status">{exportStatus}</p> : null}
      </Card>
      <div className={productionTableClass}>
        <Table
          rows={[...filtered]}
          rowKey={(asset) => asset.id}
          empty="Speaker uploads will appear here."
          columns={[
            { key: "select", header: "Select", render: (asset) => <Checkbox label={`Select ${asset.filename}`} checked={asset.current && selectedIds.includes(asset.id)} disabled={!asset.current} onChange={(event) => setSelectedIds((ids) => event.currentTarget.checked ? [...ids, asset.id] : ids.filter((id) => id !== asset.id))} /> },
            { key: "speaker", header: "Speaker / session", render: (asset) => <div><strong>{asset.speakerName}</strong><p className="text-xs text-ink-muted">{asset.sessionTitles.length > 0 ? asset.sessionTitles.join(", ") : "No session assigned"}</p><p className="text-xs text-ink-muted">{asset.purpose}</p></div> },
            { key: "file", header: "File", render: (asset) => <div><strong>{asset.filename}</strong><p className="text-xs text-ink-muted">{asset.contentType} · {asset.size.toLocaleString()} bytes</p></div> },
            { key: "version", header: "Version", render: (asset) => <div><Badge tone={asset.current ? "success" : "neutral"}>{asset.current ? "Current" : "History"}</Badge><p className="mt-1 text-xs">v{asset.version} of {asset.versionCount} · {new Date(asset.uploadedAt).toLocaleString()}</p>{asset.restoredFromAssetId ? <p className="text-xs">Restored from v{library.assets.find((candidate) => candidate.id === asset.restoredFromAssetId)?.version ?? "?"}</p> : null}</div> },
            { key: "comments", header: "Comments", render: (asset) => <details><summary className="cursor-pointer font-bold">{asset.comments.length} comment{asset.comments.length === 1 ? "" : "s"}</summary><ul className="my-2 space-y-2">{asset.comments.map((comment) => <li key={comment.id} className="text-xs"><strong>{comment.authorName}</strong> · {new Date(comment.createdAt).toLocaleString()}<p>{comment.body}</p></li>)}</ul><form className="min-w-64 space-y-2" onSubmit={async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const body = String(new FormData(form).get("body") ?? "").trim(); if (body && await onComment(asset, body) !== false) form.reset(); }}><Input name="body" label="Add comment" required /><Button type="submit" size="sm" loading={busy === asset.id}>Comment</Button></form></details> },
            { key: "actions", header: "Actions", render: (asset) => <div className="flex flex-col gap-2"><Button size="sm" variant="secondary" loading={busy === `download:${asset.id}`} onClick={() => onDownload(asset)}>Download</Button>{!asset.current ? <Button size="sm" variant="ghost" loading={busy === asset.id} onClick={() => onRestore(asset)}>Restore as current</Button> : null}</div> },
          ]}
        />
      </div>
    </section>
  </div>;
}
