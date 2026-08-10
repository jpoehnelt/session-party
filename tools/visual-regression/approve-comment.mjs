import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const approvalContexts = [
  {
    marker: "<!-- session-party-stories:visual-regression -->",
    context: "session-party-stories",
  },
  {
    marker: "<!-- session-party-pages:visual-regression -->",
    context: "session-party-pages",
  },
];

export function parseApproval(body) {
  const selected = approvalContexts.find(({ marker }) => body.includes(marker));
  if (!selected) return null;

  const sha = body.match(/<!-- sha: ([a-f0-9]{40}) -->/i)?.[1]?.toLowerCase();
  if (!sha) return null;

  const expectedLine = `- [x] **Approve screenshots** for \`${sha.slice(0, 7)}\``;
  const checked = body
    .split(/\r?\n/)
    .some((line) => line.toLowerCase() === expectedLine.toLowerCase());
  return checked ? { ...selected, sha } : null;
}

export function canApprove(permission) {
  return ["admin", "maintain", "write"].includes(permission);
}

async function github(token, method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!token || !repository || !eventPath) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_EVENT_PATH are required");
  }

  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const prNumber = event.issue?.pull_request ? event.issue.number : null;
  const actor = event.sender?.login;
  const approval = parseApproval(event.comment?.body || "");
  if (!prNumber || !actor || !approval) {
    console.log("No checked visual approval for a pull request; ignoring.");
    return;
  }

  const pr = await github(token, "GET", `/repos/${repository}/pulls/${prNumber}`);
  if (pr.head?.sha?.toLowerCase() !== approval.sha) {
    console.log(`Stale visual approval for ${approval.sha.slice(0, 7)}; ignoring.`);
    return;
  }

  const collaborator = await github(
    token,
    "GET",
    `/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`,
  );
  if (!canApprove(collaborator.permission)) {
    throw new Error(`@${actor} does not have permission to approve visual changes`);
  }

  await github(token, "POST", `/repos/${repository}/statuses/${approval.sha}`, {
    state: "success",
    context: approval.context,
    description: `approved by @${actor} via checkbox`,
    target_url: `https://github.com/${repository}/pull/${prNumber}`,
  });
  console.log(`Approved ${approval.context} on ${approval.sha.slice(0, 7)} as @${actor}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
