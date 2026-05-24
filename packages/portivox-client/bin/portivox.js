#!/usr/bin/env node
"use strict";

// ── Node.js version gate ──────────────────────────────────────────────────────
// This runs BEFORE any require() from dist/index.js, so the error is always
// readable regardless of what modern syntax the main bundle uses.
// The engines field in package.json is advisory only (npm installs anyway);
// this check is the hard enforced barrier.
var nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 12) {
  process.stderr.write(
    "\n" +
    "  ✖  portivox-client requires Node.js 12 or later.\n" +
    "     You are running Node.js " + process.version + ".\n" +
    "\n" +
    "     Upgrade via nvm:    nvm install --lts\n" +
    "     Or download from:   https://nodejs.org/en/download\n" +
    "\n"
  );
  process.exit(1);
}

require("../dist/index.js");
