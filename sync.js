const MAX_JSON_BYTES = 1_850_000;
const MAX_REPORTS_PER_REQUEST = 25;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    }
  });
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function safeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index % Math.max(1, a.length)) || 0) ^
      (b.charCodeAt(index % Math.max(1, b.length)) || 0);
  }
  return mismatch === 0;
}

function authorized(request, env) {
  return Boolean(env.PROTRACK_ADMIN_PIN) &&
    safeEqual(request.headers.get('X-ProTrack-Pin'), env.PROTRACK_ADMIN_PIN);
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS activity_reports (
      report_key TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_activity_reports_updated_at ON activity_reports(updated_at)')
  ]);
}

function validReportEntry(entry) {
  return entry && typeof entry === 'object' &&
    /^r[a-z0-9]+$/i.test(String(entry.key || '')) &&
    entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data);
}

function normalizeUpdatedAt(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

async function readSnapshot(db) {
  const [reportResult, datasetRow] = await Promise.all([
    db.prepare('SELECT report_key, data_json FROM activity_reports ORDER BY report_key').all(),
    db.prepare("SELECT data_json FROM app_state WHERE state_key = 'dataset'").first()
  ]);
  const reports = {};
  let skipped = 0;
  for (const row of reportResult.results || []) {
    try {
      const value = JSON.parse(row.data_json);
      if (value && typeof value === 'object' && !Array.isArray(value)) reports[row.report_key] = value;
      else skipped += 1;
    } catch (error) {
      skipped += 1;
    }
  }
  let dataset = null;
  if (datasetRow?.data_json) {
    try { dataset = JSON.parse(datasetRow.data_json); } catch (error) { skipped += 1; }
  }
  return { reports, dataset, skipped };
}

async function saveReports(db, input) {
  if (!Array.isArray(input.reports) || !input.reports.length) {
    return response({ ok: false, error: 'ไม่พบรายการรายงานสำหรับบันทึก' }, 400);
  }
  if (input.reports.length > MAX_REPORTS_PER_REQUEST) {
    return response({ ok: false, error: `บันทึกได้ไม่เกิน ${MAX_REPORTS_PER_REQUEST} รายการต่อครั้ง` }, 400);
  }
  const statements = [];
  for (const entry of input.reports) {
    if (!validReportEntry(entry)) return response({ ok: false, error: 'รูปแบบข้อมูลรายงานไม่ถูกต้อง' }, 400);
    const serialized = JSON.stringify(entry.data);
    if (new TextEncoder().encode(serialized).length > MAX_JSON_BYTES) {
      return response({ ok: false, error: `รายงาน ${entry.key} มีขนาดเกินกำหนด กรุณาลดจำนวนหรือขนาดรูปภาพ` }, 413);
    }
    const updatedAt = normalizeUpdatedAt(entry.data.updatedAt || entry.data.createdAt);
    statements.push(db.prepare(`INSERT INTO activity_reports (report_key, data_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(report_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`)
      .bind(String(entry.key), serialized, updatedAt));
  }
  await db.batch(statements);
  return response({ ok: true, saved: statements.length, serverTime: new Date().toISOString() });
}

async function saveDataset(db, input) {
  const dataset = input.dataset;
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset) ||
      !Array.isArray(dataset.cols) || !Array.isArray(dataset.rows) ||
      !dataset.map || typeof dataset.map !== 'object') {
    return response({ ok: false, error: 'รูปแบบทะเบียนโครงการไม่ถูกต้อง' }, 400);
  }
  if (jsonBytes(dataset) > MAX_JSON_BYTES) {
    return response({ ok: false, error: 'ทะเบียนโครงการมีขนาดเกินกำหนด' }, 413);
  }
  const serialized = JSON.stringify(dataset);
  const updatedAt = normalizeUpdatedAt(dataset.updatedAt);
  await db.prepare(`INSERT INTO app_state (state_key, data_json, updated_at)
    VALUES ('dataset', ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`)
    .bind(serialized, updatedAt).run();
  return response({ ok: true, saved: 1, serverTime: new Date().toISOString() });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return response({ ok: false, error: 'ยังไม่ได้ผูกฐานข้อมูล D1 ด้วยชื่อตัวแปร DB' }, 503);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  const url = new URL(request.url);
  if (url.searchParams.get('health') === '1') {
    return response({ ok: true, service: 'ProTrack Cloud Sync', database: 'D1' });
  }
  if (!authorized(request, env)) {
    return response({ ok: false, error: 'รหัสผู้ดูแลฐานข้อมูลไม่ถูกต้อง' }, 401);
  }
  try {
    await ensureSchema(env.DB);
    if (request.method === 'GET') {
      const snapshot = await readSnapshot(env.DB);
      return response({ ok: true, ...snapshot, serverTime: new Date().toISOString() });
    }
    if (request.method !== 'POST') return response({ ok: false, error: 'ไม่รองรับคำขอนี้' }, 405);
    if (!String(request.headers.get('Content-Type') || '').includes('application/json')) {
      return response({ ok: false, error: 'ต้องส่งข้อมูลแบบ JSON' }, 415);
    }
    const input = await request.json();
    if (input.action === 'saveReports') return await saveReports(env.DB, input);
    if (input.action === 'saveDataset') return await saveDataset(env.DB, input);
    return response({ ok: false, error: 'ไม่รู้จักคำสั่งที่ส่งมา' }, 400);
  } catch (error) {
    return response({ ok: false, error: 'ฐานข้อมูลทำงานไม่สำเร็จ', detail: String(error?.message || error) }, 500);
  }
}
