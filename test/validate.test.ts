// node --test (Node 22.6+ strips TypeScript types natively)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStatus, validateStations, validateStatus, EARLIEST_VALID } from '../supabase/functions/_shared/validate.ts';

const NOW = Date.UTC(2026, 10, 4, 21, 0, 0) / 1000;
const caps = { A: 20, B: 30, C: 0 };
const good = (over: Record<string, unknown> = {}) => ({
  station_id: 'A', num_bikes_available: 5, num_ebikes_available: 2, num_docks_available: 14,
  num_bikes_disabled: 1, num_docks_disabled: 0, is_installed: 1, is_renting: 1, is_returning: 1,
  last_reported: NOW - 30, ...over,
});

test('a clean status record passes and is normalised', () => {
  const { rows, rejects } = validateStatus([good()], caps, NOW);
  assert.equal(rejects.length, 0);
  assert.deepEqual(rows[0], {
    station_id: 'A', bikes: 5, ebikes: 2, docks: 14, bikes_disabled: 1, docks_disabled: 0,
    is_installed: true, is_renting: true, is_returning: true,
    last_reported: new Date((NOW - 30) * 1000).toISOString(),
  });
});

test('the 1970 placeholder timestamp seen in the live feed is quarantined', () => {
  const { rows, rejects } = validateStatus([good({ last_reported: 86400 })], caps, NOW);
  assert.equal(rows.length, 0);
  assert.equal(rejects[0].reason, 'bogus_timestamp');
  assert.ok(86400 < EARLIEST_VALID);
});

test('each contract rule rejects with its own reason', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ station_id: '' }, 'missing_station_id'],
    [{ station_id: 'ZZZ' }, 'unknown_station'],
    [{ num_bikes_available: -1 }, 'invalid_count'],
    [{ num_docks_available: 2.5 }, 'invalid_count'],
    [{ num_ebikes_available: 9 }, 'ebikes_exceed_bikes'],
    [{ is_renting: 'yes' }, 'invalid_flag'],
    [{ last_reported: NOW + 3600 }, 'future_timestamp'],
    [{ num_bikes_available: 15, num_docks_available: 15 }, 'over_capacity'],
  ];
  for (const [over, reason] of cases) {
    const { rows, rejects } = validateStatus([good(over)], caps, NOW);
    assert.equal(rows.length, 0, reason);
    assert.equal(rejects[0].reason, reason);
  }
});

test('over-capacity allows valet tolerance and skips zero-capacity docks', () => {
  assert.equal(validateStatus([good({ num_bikes_available: 7 })], caps, NOW).rows.length, 1); // 7+14+1 = 22 = 20 + 2
  assert.equal(validateStatus([good({ station_id: 'C', num_bikes_available: 9 })], caps, NOW).rows.length, 1);
});

test('duplicates in one feed keep the first and quarantine the rest', () => {
  const { rows, rejects } = validateStatus([good(), good({ num_bikes_available: 0 })], caps, NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bikes, 5);
  assert.equal(rejects[0].reason, 'duplicate_station');
});

test('stations outside the service area or without a name are rejected', () => {
  const base = { station_id: 'S1', name: 'Broadway & W 41 St', lat: 40.755, lon: -73.986, capacity: 55 };
  assert.equal(validateStations([base]).rows.length, 1);
  assert.equal(validateStations([{ ...base, lat: 0, lon: 0 }]).rejects[0].reason, 'outside_service_area');
  assert.equal(validateStations([{ ...base, name: '  ' }]).rejects[0].reason, 'missing_name');
  assert.equal(validateStations([{ ...base, capacity: -3 }]).rejects[0].reason, 'invalid_capacity');
});

test('run status: empty feed fails, heavy rejection or an old feed is partial', () => {
  assert.equal(runStatus(0, 0, 10).status, 'failed');
  assert.equal(runStatus(2500, 48, 50).status, 'ok');
  assert.equal(runStatus(2500, 400, 50).status, 'partial');
  assert.equal(runStatus(2500, 0, 900).status, 'partial');
});
