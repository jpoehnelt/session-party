import assert from "node:assert/strict";
import test from "node:test";
import { canApprove, parseApproval } from "./approve-comment.mjs";

const sha = "1234567890abcdef1234567890abcdef12345678";

test("parses a checked Storybook approval bound to its full SHA", () => {
  const approval = parseApproval([
    "<!-- session-party-stories:visual-regression -->",
    `<!-- sha: ${sha} -->`,
    "- [x] **Approve screenshots** for `1234567`",
  ].join("\n"));

  assert.deepEqual(approval, {
    marker: "<!-- session-party-stories:visual-regression -->",
    context: "session-party-stories",
    sha,
  });
});

test("rejects unchecked, mismatched, and foreign approval lines", () => {
  const prefix = `<!-- session-party-pages:visual-regression -->\n<!-- sha: ${sha} -->`;
  assert.equal(parseApproval(`${prefix}\n- [ ] **Approve screenshots** for \`1234567\``), null);
  assert.equal(parseApproval(`${prefix}\n- [x] **Approve screenshots** for \`deadbee\``), null);
  assert.equal(parseApproval(`<!-- sha: ${sha} -->\n- [x] **Approve screenshots** for \`1234567\``), null);
});

test("accepts only write-capable collaborator permissions", () => {
  for (const permission of ["admin", "maintain", "write"]) {
    assert.equal(canApprove(permission), true);
  }
  for (const permission of ["triage", "read", "none", undefined]) {
    assert.equal(canApprove(permission), false);
  }
});
