"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SUPPORTED_STAKING_DURATIONS,
  isSupportedStakingDuration
} = require("../src/staking-duration-catalogue");

test("catalogue preserves legacy and approved future contract durations", () => {
  assert.deepEqual(SUPPORTED_STAKING_DURATIONS, [30, 60, 90, 180, 365, 430, 730, 1095]);
});

test("duration validator accepts listed integer durations and numeric strings", () => {
  for (const duration of SUPPORTED_STAKING_DURATIONS) {
    assert.equal(isSupportedStakingDuration(duration), true);
    assert.equal(isSupportedStakingDuration(String(duration)), true);
  }
});

test("duration validator rejects unsupported, fractional and malformed values", () => {
  for (const value of [0, -30, 31, 120, 360, 500, 1096, 30.5, "", "abc", null, undefined]) {
    assert.equal(isSupportedStakingDuration(value), false, `unexpectedly accepted ${String(value)}`);
  }
});
