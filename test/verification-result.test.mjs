import assert from 'node:assert/strict';
import test from 'node:test';
import { formatUtcTime, summarizeTimestamps } from '../src/verification-result.mjs';

const first = '2026-11-24T11:51:33.000Z';
const tsr = (time = first, target = 'file') => ({ type: 'tsr', target, time });
const ots = (time = '2026-11-24T12:51:33.000Z', target = 'file') => ({ type: 'ots', target, time });

test('displays UTC in the requested form without changing the instant', () => {
  assert.equal(formatUtcTime(first), '2026.11.24 11:51.33');
});

test('accepts 5 seconds across TSRs and exactly 24 hours to the farthest same-target proof', () => {
  const summary = summarizeTimestamps([
    tsr('2026-11-24T11:51:38.000Z'), ots('2026-11-25T11:51:33.000Z'), tsr(),
  ]);
  assert.equal(summary.pass, true);
  assert.equal(summary.time, first);
  assert.equal(summary.timeType, 'tsr');
});

test('rejects 5.001 seconds between TSRs and 24 hours plus a second between OTS and TSR', () => {
  assert.match(summarizeTimestamps([tsr(), tsr('2026-11-24T11:51:38.001Z'), ots()]).reason, /TSR.*5 秒/);
  assert.match(summarizeTimestamps([tsr(), ots('2026-11-25T11:51:34.000Z')]).reason, /OTS.*24 小时/);
  assert.match(summarizeTimestamps([tsr(), ots('2026-11-23T11:51:32.000Z')]).reason, /OTS.*24 小时/);
});

test('fails joint validation for incomplete, invalid, or incomparable proofs', () => {
  assert.equal(summarizeTimestamps([tsr(), ots(undefined, 'signature')]).pass, false);
  assert.equal(summarizeTimestamps([tsr(), { ...ots(), time: undefined }]).pass, false);
  assert.equal(summarizeTimestamps([tsr()]).pass, false);
  assert.equal(summarizeTimestamps([tsr(), ots()], { signatureFailed: true }).pass, false);
  assert.equal(summarizeTimestamps([tsr(), ots()]).pass, true);
  assert.equal(summarizeTimestamps([ots()]).timeType, 'ots');
  assert.equal(summarizeTimestamps([]), undefined);
});
