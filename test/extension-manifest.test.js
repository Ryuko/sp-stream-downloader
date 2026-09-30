"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const manifest = require("../manifest.json");

// One manifest serves both browsers: Chrome reads `service_worker` (and ignores
// `scripts`), Firefox reads `scripts` (and ignores `service_worker`).
test("background declares the same script for Chrome and Firefox", () => {
  assert.equal(manifest.background.service_worker, "background.js");
  assert.deepEqual(manifest.background.scripts, [manifest.background.service_worker]);
});

test("Firefox settings: stable add-on id, data collection declared", () => {
  const g = manifest.browser_specific_settings.gecko;
  assert.match(g.id, /^[\w.-]+@[\w.-]+$/);
  assert.deepEqual(g.data_collection_permissions.required, ["none"]);
});
