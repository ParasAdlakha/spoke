// Edits one real recording (record-live.mjs) into the Spoke videos.
//   node spoke-video.mjs <2min|3min|captioned> <recording dir> <slides png dir> <out.mp4>
// Segments between recorded marks play in real time, or sped up (labelled "sped up N×")
// so each lasts as long as its narration. Captions are PNG overlays; voices are edge-tts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import sharp from 'sharp';

const [cut, rec, slides, out] = process.argv.slice(2);
const { marks, frames } = JSON.parse(readFileSync(`${rec}/recording.json`, 'utf-8'));
const work = `${rec}/edit-${cut}`;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const voiced = cut !== 'captioned';

// --- the edit --------------------------------------------------------------------
// from/to: recording marks. say: narration. cap: [tag, caption]. min: shortest output length (s).
const demo = [
  { from: 'start', to: 'typing', cap: ['01 · LIVE', 'Every Citi Bike station, from Supabase, updated every minute'],
    say: 'This is Spoke, live. Every dot is a Citi Bike station, read from Supabase, where pg_cron and an edge function load the public feed every minute.' },
  { from: 'typing', to: 'answer', cap: ['02 · ASK', 'A rider near Bryant Park asks for an e-bike'],
    say: 'A rider near Bryant Park asks where to grab an e-bike.' },
  { from: 'answer', to: 'move', cap: ['03 · TRUST GATE', 'Checked first: pipeline health + Sodabase. Then a cited answer'],
    say: 'Before answering, the ask function runs a trust gate: is the live table fresh, are the recent ingest runs healthy, and what does Sodabase say about it? It is trusted, so Spoke answers from the five nearest stations, and cites each one.' },
  { from: 'move', to: 'dock_answer', cap: ['04 · ANYWHERE', 'Click the map: now a free dock near Union Square'],
    say: 'Click anywhere on the map. Near Union Square, where can I dock?' },
  { from: 'dock_answer', to: 'health', cap: ['05 · ANSWER', 'The nearest dock with space, with live counts per station'],
    say: 'East seventeenth and Broadway, six free docks, two minutes away.' },
  { from: 'health', to: 'runs', cap: ['06 · DATA HEALTH', 'The trust gate the answer was checked against'],
    say: 'The data health view shows what the answer was checked against: how old the live table is, and how many ingest runs succeeded in the last fifteen minutes.' },
  { from: 'runs', to: 'quarantine', cap: ['07 · AUDIT', 'One ingest_runs row per minute, success or failure'],
    say: 'Every cron run writes one audit row, even a failed one, with rows in, rows changed, and rows rejected. A silent pipeline shows up as stale data.' },
  { from: 'quarantine', to: 'answers', cap: ['08 · QUARANTINE', 'Bad rows never reach the live tables: 48 stations report 1970'],
    say: 'And here is what the feed got wrong. Forty eight stations report a last update in 1970. Others report more bikes than they have docks. They are quarantined, with a reason, and never reach the live tables.' },
  { from: 'answers', to: 'end', cap: ['09 · LOGGED', 'Every answer logged with its verdict, model and latency'],
    say: 'Every answer is logged with the verdict it was gated on.' },
];
const S = (n) => `${slides}/s${n}.png`;
const steps = cut === '3min'
  ? [
      { slide: S(1), say: 'Hi, we are Paras and Harshita. This is Spoke: live Citi Bike availability for New York, checked before it is trusted. Built on Supabase tables, cron jobs and edge functions, and watched by Sodabase.' },
      { slide: S(2), say: 'The app says three bikes, you walk ten minutes, and the dock is empty. We profiled one pull of the Citi Bike feed: forty eight stations report a last update in 1970, nine report more bikes than docks, and five installed stations have been silent for a day.' },
      ...demo,
      { slide: S(4), say: 'It is a database with two small functions on top: three pg_cron jobs, pg_net, Vault, a twelve rule contract, row level security, and one transaction per minute.' },
      { slide: S(6), say: 'And it is built for Sodabase. A heartbeat every minute, nothing ever deleted, schema only through migrations. Every answer calls Sodabase check trust, and if Sodabase says untrusted, Spoke will not answer.' },
      { slide: S(7), say: 'Spoke. Live Citi Bike, checked before it is trusted. Thank you.', min: 5 },
    ]
  : cut === '2min'
    ? [...demo, { slide: S(1), say: 'Spoke. Live Citi Bike, checked before it is trusted.', min: 4 }]
    : demo.map((d) => ({ ...d, say: undefined, min: Math.max(4.5, d.cap[1].length / 14) })).concat([{ slide: S(1), min: 4 }]);

// --- voice -----------------------------------------------------------------------
steps.forEach((s, i) => {
  if (!voiced || !s.say) return;
  s.mp3 = `${work}/line-${String(i).padStart(2, '0')}.mp3`;
  execFileSync('python', ['-m', 'edge_tts', '--voice', 'en-US-AvaNeural', '--rate=+6%', '--text', s.say, '--write-media', s.mp3]);
  s.len = dur(s.mp3);
});

// --- caption overlays --------------------------------------------------------------
async function overlay(file, cap, speed) {
  const parts = [];
  if (cap) {
    const text = esc(cap[1]);
    const w = Math.min(1700, 140 + (cap[0].length + cap[1].length) * 15.5);
    const x = (1920 - w) / 2;
    parts.push(`<rect x="${x}" y="958" width="${w}" height="74" rx="18" fill="#1d1c1a" fill-opacity="0.94"/>`,
      `<text x="${x + 30}" y="1004" font-family="Consolas, monospace" font-weight="700" font-size="20" fill="#8fb3ff" letter-spacing="1.5">${esc(cap[0])}</text>`,
      `<text x="${x + 46 + cap[0].length * 12.2}" y="1006" font-family="Segoe UI, Arial, sans-serif" font-weight="600" font-size="28" fill="#f6f5f1">${text}</text>`);
  }
  if (speed > 1.2) {
    const label = `▶▶  sped up ${Math.round(speed)}× · real run`;
    parts.push(`<rect x="1572" y="28" width="320" height="52" rx="26" fill="#1452e0" fill-opacity="0.95"/>`,
      `<text x="1732" y="62" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="22" fill="#fff">${esc(label)}</text>`);
  }
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">${parts.join('')}</svg>`)).png().toFile(file);
}

// --- clips -------------------------------------------------------------------------
const clips = [];
let t = 0;
for (const [i, s] of steps.entries()) {
  const want = Math.max(s.min ?? 0, (s.len ?? 0) + 0.7);
  const clip = `${work}/clip-${String(i).padStart(2, '0')}.mp4`;
  const ov = `${work}/ov-${i}.png`;
  if (s.slide) {
    await overlay(ov, null, 1);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', s.slide, '-t', want.toFixed(2), '-vf', 'fps=30,scale=1920:1080,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', clip]);
  } else {
    const a = marks[s.from], b = marks[s.to];
    if (!a || !b) throw new Error(`missing mark ${s.from} or ${s.to}`);
    const raw = (b - a) / 1000;
    const speed = Math.max(1, raw / want);
    await overlay(ov, s.cap, speed);
    const shown = frames.filter((fr, k) => (frames[k + 1]?.ts ?? Infinity) > a && fr.ts < b);
    const lines = shown.map((fr, k) => {
      const from = Math.max(fr.ts, a), to = Math.min(shown[k + 1]?.ts ?? b, b);
      return `file '${fr.f.replace(/\\/g, '/')}'\nduration ${((to - from) / 1000 / speed).toFixed(4)}`;
    });
    // Narration longer than the real segment: hold the last frame.
    const extra = want - raw / speed;
    lines.push(`file '${shown.at(-1).f.replace(/\\/g, '/')}'\nduration ${Math.max(0.04, extra).toFixed(4)}`, `file '${shown.at(-1).f.replace(/\\/g, '/')}'`);
    writeFileSync(`${work}/list-${i}.txt`, lines.join('\n'));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${work}/list-${i}.txt`, '-loop', '1', '-i', ov,
      '-filter_complex', '[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p[v];[v][1:v]overlay=0:0,format=yuv420p', '-t', want.toFixed(2), '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', clip]);
    console.log(`${s.from}→${s.to}: ${raw.toFixed(0)}s real → ${want.toFixed(1)}s (${speed.toFixed(1)}×)`);
  }
  s.at = t;
  t += dur(clip);
  clips.push(clip);
}
writeFileSync(`${work}/clips.txt`, clips.map((c) => `file '${c.replace(/\\/g, '/')}'`).join('\n'));
const silent = `${work}/silent.mp4`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${work}/clips.txt`, '-c', 'copy', silent]);

// --- audio -------------------------------------------------------------------------
if (!voiced) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, '-c', 'copy', '-movflags', '+faststart', out]);
} else {
  const v = steps.filter((s) => s.mp3);
  const inputs = ['-i', silent, ...v.flatMap((s) => ['-i', s.mp3])];
  const delays = v.map((s, k) => `[${k + 1}:a]adelay=${Math.round(s.at * 1000 + 250)}|${Math.round(s.at * 1000 + 250)}[a${k}]`).join(';');
  const mix = `${delays};${v.map((_, k) => `[a${k}]`).join('')}amix=inputs=${v.length}:normalize=0[aout]`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', t.toFixed(2), out]);
}
console.log('wrote', out, Math.round(dur(out)), 's');
