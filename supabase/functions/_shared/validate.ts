// Spoke's data contract for the Citi Bike GBFS feed.
// Pure functions, no I/O: the edge function (Deno) and the tests (Node) both
// import this file, so the rules that run in production are the tested ones.

export type Reject = {
  station_id: string;
  reason: string;
  detail: string;
  payload: unknown;
};

export type StationRow = {
  station_id: string;
  legacy_id: string | null;
  name: string;
  short_name: string | null;
  lat: number;
  lon: number;
  region_id: string | null;
  capacity: number;
  station_type: string | null;
};

export type StatusRow = {
  station_id: string;
  bikes: number;
  ebikes: number;
  docks: number;
  bikes_disabled: number;
  docks_disabled: number;
  is_installed: boolean;
  is_renting: boolean;
  is_returning: boolean;
  last_reported: string;
};

// Citi Bike launched on 27 May 2013. Anything older is a placeholder
// (the live feed reports `last_reported: 86400`, i.e. 2 Jan 1970, for some docks).
export const EARLIEST_VALID = Date.UTC(2013, 4, 1) / 1000;
// Citi Bike covers NYC, Jersey City and Hoboken.
export const BBOX = { minLat: 40.4, maxLat: 41.1, minLon: -74.4, maxLon: -73.6 };
// Allowed clock skew for "reported in the future".
export const FUTURE_SKEW_S = 300;
// A dock can briefly hold more bikes than its nominal capacity (valet service).
export const CAPACITY_TOLERANCE = 2;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const flag = (v: unknown): boolean | null =>
  v === 1 || v === true ? true : v === 0 || v === false ? false : null;

export function validateStations(stations: unknown[]): { rows: StationRow[]; rejects: Reject[] } {
  const rows: StationRow[] = [];
  const rejects: Reject[] = [];
  const seen = new Set<string>();
  for (const raw of stations) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const id = typeof s.station_id === 'string' ? s.station_id.trim() : '';
    const bad = (reason: string, detail: string) =>
      rejects.push({ station_id: id || '(missing)', reason, detail, payload: raw });
    if (!id) { bad('missing_station_id', 'station_id is empty'); continue; }
    if (seen.has(id)) { bad('duplicate_station', 'station_id appears twice in one feed'); continue; }
    seen.add(id);
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (!name) { bad('missing_name', 'name is empty'); continue; }
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < BBOX.minLat || lat > BBOX.maxLat || lon < BBOX.minLon || lon > BBOX.maxLon) {
      bad('outside_service_area', `lat ${s.lat}, lon ${s.lon} is outside the Citi Bike service area`);
      continue;
    }
    if (!isCount(s.capacity)) { bad('invalid_capacity', `capacity ${s.capacity} is not a non-negative integer`); continue; }
    rows.push({
      station_id: id,
      legacy_id: s.legacy_id == null ? null : String(s.legacy_id),
      name,
      short_name: s.short_name == null ? null : String(s.short_name),
      lat, lon,
      region_id: s.region_id == null ? null : String(s.region_id),
      capacity: s.capacity,
      station_type: s.station_type == null ? null : String(s.station_type),
    });
  }
  return { rows, rejects };
}

export function validateStatus(
  statuses: unknown[],
  capacities: Record<string, number>,
  nowS: number,
): { rows: StatusRow[]; rejects: Reject[] } {
  const rows: StatusRow[] = [];
  const rejects: Reject[] = [];
  const seen = new Set<string>();
  for (const raw of statuses) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const id = typeof s.station_id === 'string' ? s.station_id.trim() : '';
    const bad = (reason: string, detail: string) =>
      rejects.push({ station_id: id || '(missing)', reason, detail, payload: raw });
    if (!id) { bad('missing_station_id', 'station_id is empty'); continue; }
    if (seen.has(id)) { bad('duplicate_station', 'station_id appears twice in one feed'); continue; }
    seen.add(id);
    if (!(id in capacities)) { bad('unknown_station', 'status for a station not in station_information'); continue; }

    const counts = ['num_bikes_available', 'num_docks_available'] as const;
    const missing = counts.filter((k) => !isCount(s[k]));
    if (missing.length) { bad('invalid_count', `${missing.join(', ')} not a non-negative integer`); continue; }
    const bikes = s.num_bikes_available as number;
    const docks = s.num_docks_available as number;
    const ebikes = isCount(s.num_ebikes_available) ? s.num_ebikes_available : 0;
    const bikesDisabled = isCount(s.num_bikes_disabled) ? s.num_bikes_disabled : 0;
    const docksDisabled = isCount(s.num_docks_disabled) ? s.num_docks_disabled : 0;
    if (ebikes > bikes) { bad('ebikes_exceed_bikes', `${ebikes} e-bikes but only ${bikes} bikes`); continue; }

    const installed = flag(s.is_installed), renting = flag(s.is_renting), returning = flag(s.is_returning);
    if (installed === null || renting === null || returning === null) {
      bad('invalid_flag', 'is_installed / is_renting / is_returning must be 0 or 1'); continue;
    }

    const reported = Number(s.last_reported);
    if (!Number.isFinite(reported) || reported < EARLIEST_VALID) {
      bad('bogus_timestamp', `last_reported ${s.last_reported} is before Citi Bike existed`); continue;
    }
    if (reported > nowS + FUTURE_SKEW_S) {
      bad('future_timestamp', `last_reported is ${Math.round(reported - nowS)} s in the future`); continue;
    }

    const cap = capacities[id];
    const total = bikes + docks + bikesDisabled + docksDisabled;
    if (installed && cap > 0 && total > cap + CAPACITY_TOLERANCE) {
      bad('over_capacity', `${total} bikes + docks at a ${cap}-dock station`); continue;
    }

    rows.push({
      station_id: id, bikes, ebikes, docks,
      bikes_disabled: bikesDisabled, docks_disabled: docksDisabled,
      is_installed: installed, is_renting: renting, is_returning: returning,
      last_reported: new Date(reported * 1000).toISOString(),
    });
  }
  return { rows, rejects };
}

// Run-level verdict: a batch that rejects too much is still applied (the good
// rows are good), but the run is marked partial so the trust gate sees it.
export function runStatus(rowsIn: number, rejected: number, feedAgeS: number): { status: 'ok' | 'partial' | 'failed'; note: string | null } {
  if (rowsIn === 0) return { status: 'failed', note: 'feed returned no stations' };
  const notes: string[] = [];
  if (rejected / rowsIn > 0.1) notes.push(`${rejected}/${rowsIn} records rejected`);
  if (feedAgeS > 300) notes.push(`feed is ${Math.round(feedAgeS / 60)} min old`);
  return notes.length ? { status: 'partial', note: notes.join('; ') } : { status: 'ok', note: null };
}
