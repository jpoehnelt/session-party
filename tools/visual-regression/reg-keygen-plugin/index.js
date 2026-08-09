"use strict";

const { execFileSync } = require("node:child_process");

class SessionPartyKeyGenerator {
  init(config) {
    this.logger = config.logger;
  }

  async getActualKey() {
    const sha = process.env.GITHUB_CAPTURE_SHA || process.env.GITHUB_SHA;
    if (isSha(sha)) return sha;
    return git(["rev-parse", "HEAD"]);
  }

  async getExpectedKey() {
    const event = process.env.GITHUB_EVENT_NAME;
    if (event === "pull_request" || event === "pull_request_target") {
      const sha = process.env.REG_EXPECTED_SHA || process.env.GITHUB_BASE_SHA;
      if (isSha(sha)) return sha;
      this.logger.warn("No valid PR baseline SHA is available.");
      return Promise.reject(null);
    }
    if (event === "push") {
      this.logger.info("Main push is publish-only.");
      return Promise.reject(null);
    }
    try {
      return git(["rev-parse", "HEAD~1"]);
    } catch {
      return Promise.reject(null);
    }
  }
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const factory = () => ({ keyGenerator: new SessionPartyKeyGenerator() });
module.exports = factory;
module.exports.default = factory;
module.exports.SessionPartyKeyGenerator = SessionPartyKeyGenerator;
