"use strict";

// The accepted catalogue is the union of immutable legacy terms and the
// approved future offer durations. Existing 60/430-day contracts remain valid.
const SUPPORTED_STAKING_DURATIONS = Object.freeze([
  30, 60, 90, 180, 365, 430, 730, 1095,
]);

const DURATION_SET = new Set(SUPPORTED_STAKING_DURATIONS);

function isSupportedStakingDuration(value) {
  return Number.isInteger(Number(value)) && DURATION_SET.has(Number(value));
}

module.exports = {
  SUPPORTED_STAKING_DURATIONS,
  isSupportedStakingDuration,
};
