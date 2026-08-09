"use strict";

const markerFor = (context) => `<!-- ${context}:visual-regression -->`;

function verdict(comparisonResult) {
  const counts = {
    changed: comparisonResult.failedItems.length,
    new: comparisonResult.newItems.length,
    deleted: comparisonResult.deletedItems.length,
    passed: comparisonResult.passedItems.length,
  };
  const emptyBaseline = counts.new > 0 && counts.passed === 0;
  const state = counts.changed > 0 || counts.deleted > 0 || emptyBaseline ? "failure" : "success";
  return { counts, emptyBaseline, state };
}

function commentBody({ context, label, sha, reportUrl, result }) {
  const { counts, emptyBaseline, state } = verdict(result);
  const icon = state === "success" ? "✅" : "⚠️";
  const lines = [
    markerFor(context),
    `<!-- sha: ${sha} -->`,
    `### ${icon} ${label}`,
    "",
    `Changed: **${counts.changed}** · New: **${counts.new}** · Deleted: **${counts.deleted}** · Passed: **${counts.passed}**`,
  ];
  if (emptyBaseline) {
    lines.push("", "No existing screenshots passed, so this run is treated as a missing baseline rather than an automatic approval.");
  }
  if (reportUrl) lines.push("", `[Open the visual comparison report](${reportUrl})`);
  lines.push("", `Informational result for \`${sha.slice(0, 7)}\`; this repository does not require the status through branch protection.`);
  return lines.join("\n");
}

class SessionPartyNotifier {
  init(config) {
    this.logger = config.logger;
    this.options = config.options || {};
  }

  async notify(params) {
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const sha = process.env.GITHUB_HEAD_SHA || process.env.GITHUB_SHA;
    if (!token || !repository || !sha) {
      this.logger.warn("Skipping GitHub visual report outside CI.");
      return;
    }
    const [owner, repo] = repository.split("/");
    const context = this.options.statusContext || "session-party-visual";
    const label = this.options.label || "Visual diff";
    const assessment = verdict(params.comparisonResult);
    await github(token, "POST", `/repos/${owner}/${repo}/statuses/${sha}`, {
      state: assessment.state,
      context,
      description: `${assessment.counts.changed} changed, ${assessment.counts.new} new, ${assessment.counts.deleted} deleted`,
      ...(params.reportUrl ? { target_url: params.reportUrl } : {}),
    });

    const pr = Number.parseInt(process.env.PR_NUMBER || "", 10);
    if (!Number.isSafeInteger(pr) || pr <= 0) return;
    const body = commentBody({
      context,
      label,
      sha,
      reportUrl: params.reportUrl,
      result: params.comparisonResult,
    });
    const comments = await github(token, "GET", `/repos/${owner}/${repo}/issues/${pr}/comments?per_page=100`);
    const existing = comments.find((comment) => comment.body?.includes(markerFor(context)));
    if (existing) {
      await github(token, "PATCH", `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body });
    } else {
      await github(token, "POST", `/repos/${owner}/${repo}/issues/${pr}/comments`, { body });
    }
  }
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

const factory = () => ({ notifier: new SessionPartyNotifier() });
module.exports = factory;
module.exports.default = factory;
module.exports.verdict = verdict;
module.exports.commentBody = commentBody;
