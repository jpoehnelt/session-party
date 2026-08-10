import assert from "node:assert/strict";
import test from "node:test";
import notifier from "./reg-notify-plugin/index.js";

const result = (overrides = {}) => ({
  failedItems: [],
  newItems: [],
  deletedItems: [],
  passedItems: ["existing.png"],
  ...overrides,
});

test("new screenshots pass when a real baseline also passed", () => {
  assert.equal(notifier.verdict(result({ newItems: ["new.png"] })).state, "success");
});

test("an all-new result fails closed as an empty baseline", () => {
  const assessment = notifier.verdict(result({ newItems: ["new.png"], passedItems: [] }));
  assert.equal(assessment.state, "failure");
  assert.equal(assessment.emptyBaseline, true);
});

test("changed or deleted screenshots require review", () => {
  assert.equal(notifier.verdict(result({ failedItems: ["changed.png"] })).state, "failure");
  assert.equal(notifier.verdict(result({ deletedItems: ["deleted.png"] })).state, "failure");
});

test("failed comparisons include a SHA-bound approval checkbox", () => {
  const body = notifier.commentBody({
    context: "session-party-stories",
    label: "Storybook visual diff",
    sha: "1234567890abcdef1234567890abcdef12345678",
    reportUrl: "https://visual.example.test/report",
    result: result({ failedItems: ["changed.png"] }),
  });

  assert.match(body, /- \[ \] \*\*Approve screenshots\*\* for `1234567`/);
  assert.match(body, /approval resets on every push/);
});

test("successful comparisons do not include an approval checkbox", () => {
  const body = notifier.commentBody({
    context: "session-party-stories",
    label: "Storybook visual diff",
    sha: "1234567890abcdef1234567890abcdef12345678",
    reportUrl: "https://visual.example.test/report",
    result: result(),
  });

  assert.doesNotMatch(body, /Approve screenshots/);
});
