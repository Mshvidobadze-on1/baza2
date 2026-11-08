const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DB_PATH = path.join(__dirname, 'baza.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

if (!fs.existsSync(DB_PATH)) {
  console.log('Database file not found at:', DB_PATH);
  if (fs.existsSync(path.join(__dirname, 'build-db.js'))) {
    console.log('Building baza.db from compressed source...');
    const { execSync } = require('child_process');
    execSync('node build-db.js', { stdio: 'inherit' });
  } else {
    console.error('Database file not found and build-db.js missing.');
    process.exit(1);
  }
}

// Open database in read-write mode so admin can add/edit photos, phones, addresses, etc.
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA cache_size = -100000;');
db.exec('PRAGMA temp_store = MEMORY;');
db.exec('PRAGMA journal_mode = WAL;');

// Create person_extras table for photos, father's photo, mobile phone, extra addresses, notes
db.exec(`
  CREATE TABLE IF NOT EXISTS person_extras (
    record_id INTEGER PRIMARY KEY,
    photo_url TEXT DEFAULT '',
    father_photo_url TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    actual_address TEXT DEFAULT '',
    workplace TEXT DEFAULT '',
    vehicle TEXT DEFAULT '',
    status_note TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    updated_at TEXT DEFAULT ''
  );
`);

let maxIdRow = db.prepare('SELECT MAX(id) as total FROM records').get();
let TOTAL_RECORDS = maxIdRow && maxIdRow.total ? maxIdRow.total : 0;
console.log(`Loaded MIA database with ${TOTAL_RECORDS.toLocaleString()} records.`);

// Admin credentials & active session tokens
const VALID_USERS = new Set(['lucaskawaiii', 'lucaskawaii']);
const VALID_PASSES = new Set(['Argo226', 'argo226']);
const activeTokens = new Set();

// Map Georgian QWERTY characters back to Latin in case keyboard layout is Georgian during login
const GEO_TO_LATIN = {
  'ა': 'a', 'ბ': 'b', 'გ': 'g', 'დ': 'd', 'ე': 'e', 'ვ': 'v', 'ზ': 'z',
  'თ': 't', 'ი': 'i', 'კ': 'k', 'ლ': 'l', 'მ': 'm', 'ნ': 'n', 'ო': 'o',
  'პ': 'p', 'ჟ': 'j', 'რ': 'r', 'ს': 's', 'ტ': 't', 'უ': 'u', 'ფ': 'f',
  'ქ': 'q', 'ღ': 'r', 'ყ': 'y', 'შ': 's', 'ჩ': 'c', 'ც': 'c', 'ძ': 'z',
  'წ': 'w', 'ჭ': 'w', 'ხ': 'x', 'ჯ': 'j', 'ჰ': 'h'
};

function normalizeLoginString(str) {
  if (!str) return '';
  let out = '';
  for (const ch of str.trim()) {
    out += GEO_TO_LATIN[ch] || ch;
  }
  return out;
}

function isValidToken(req) {
  const auth = req.headers['x-admin-token'] || '';
  return activeTokens.has(auth);
}

// AcadNusx to Georgian helper
const ACAD_MAP = {
  'a': 'ა', 'b': 'ბ', 'g': 'გ', 'd': 'დ', 'e': 'ე', 'v': 'ვ', 'z': 'ზ',
  'T': 'თ', 'i': 'ი', 'k': 'კ', 'l': 'ლ', 'm': 'მ', 'n': 'ნ', 'o': 'ო',
  'p': 'პ', 'J': 'ჟ', 'r': 'რ', 's': 'ს', 't': 'ტ', 'u': 'უ', 'f': 'ფ',
  'q': 'ქ', 'R': 'ღ', 'y': 'ყ', 'S': 'შ', 'C': 'ჩ', 'c': 'ც', 'Z': 'ძ',
  'w': 'წ', 'W': 'ჭ', 'x': 'ხ', 'j': 'ჯ', 'h': 'ჰ'
};

function ensureGeorgian(str) {
  if (!str) return '';
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    out += ACAD_MAP[ch] || ch;
  }
  return out.trim();
}

const GEORGIAN_VOWELS = new Set(['ა', 'ე', 'ი', 'ო', 'უ']);

function getNameVariants(name) {
  const clean = ensureGeorgian(name);
  if (!clean) return [];
  const variants = new Set([clean]);
  if (clean.length >= 3) {
    const lastChar = clean[clean.length - 1];
    if (lastChar === 'ი' && clean.length >= 4) {
      const stem = clean.slice(0, -1);
      const stemLast = stem[stem.length - 1];
      if (!GEORGIAN_VOWELS.has(stemLast)) {
        variants.add(stem);
      }
    } else if (!GEORGIAN_VOWELS.has(lastChar)) {
      variants.add(clean + 'ი');
    }
  }
  return Array.from(variants);
}

function attachExtrasToRows(rows) {
  if (!rows || rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const extrasList = db.prepare(`SELECT * FROM person_extras WHERE record_id IN (${placeholders})`).all(...ids);
  const extrasMap = new Map();
  for (const ex of extrasList) {
    extrasMap.set(ex.record_id, ex);
  }
  return rows.map(r => {
    const ex = extrasMap.get(r.id) || {};
    return {
      ...r,
      photo_url: ex.photo_url || '',
      father_photo_url: ex.father_photo_url || '',
      phone: ex.phone || '',
      actual_address: ex.actual_address || '',
      workplace: ex.workplace || '',
      vehicle: ex.vehicle || '',
      status_note: ex.status_note || '',
      notes: ex.notes || '',
      updated_at: ex.updated_at || ''
    };
  });
}

function parseSearchParams(searchParams) {
  const q = (searchParams.get('q') || '').trim();
  let saxeli = ensureGeorgian(searchParams.get('saxeli') || '');
  let gvari = ensureGeorgian(searchParams.get('gvari') || '');
  let mamis_saxeli = ensureGeorgian(searchParams.get('mamis_saxeli') || '');
  let piradi = (searchParams.get('piradi') || '').trim();
  let mocmobis = (searchParams.get('mocmobis') || '').trim();
  let quca = ensureGeorgian(searchParams.get('quca') || '');
  let raioni = ensureGeorgian(searchParams.get('raioni') || '');
  let dab_weli = (searchParams.get('dab_weli') || '').trim();
  let sqesi = (searchParams.get('sqesi') || '').trim();
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '100', 10), 1), 500);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

  return {
    q, saxeli, gvari, mamis_saxeli, piradi, mocmobis, quca, raioni, dab_weli, sqesi, limit, offset
  };
}

function executeSearch(params) {
  const t0 = Date.now();
  const {
    q, saxeli, gvari, mamis_saxeli, piradi, mocmobis, quca, raioni, dab_weli, sqesi, limit, offset
  } = params;

  const extraWhere = [];
  const extraArgs = [];

  if (mamis_saxeli) {
    const mVars = getNameVariants(mamis_saxeli);
    if (mVars.length === 1) {
      extraWhere.push('mamis_saxeli LIKE ?');
      extraArgs.push(mVars[0] + '%');
    } else {
      extraWhere.push(`(mamis_saxeli IN (${mVars.map(() => '?').join(',')}) OR mamis_saxeli LIKE ?)`);
      extraArgs.push(...mVars, mamis_saxeli + '%');
    }
  }
  if (piradi) {
    if (piradi.length === 11 && /^\d+$/.test(piradi)) {
      extraWhere.push('piradi = ?');
      extraArgs.push(piradi);
    } else {
      extraWhere.push('piradi LIKE ?');
      extraArgs.push(piradi + '%');
    }
  }
  if (mocmobis) {
    extraWhere.push('mocmobis = ?');
    extraArgs.push(mocmobis);
  }
  if (quca) {
    extraWhere.push('quca LIKE ?');
    extraArgs.push('%' + quca + '%');
  }
  if (raioni) {
    extraWhere.push('raioni LIKE ?');
    extraArgs.push(raioni + '%');
  }
  if (dab_weli) {
    extraWhere.push('dab_weli LIKE ?');
    extraArgs.push('%' + dab_weli + '%');
  }
  if (sqesi) {
    extraWhere.push('sqesi = ?');
    extraArgs.push(sqesi);
  }

  const extraSql = extraWhere.length > 0 ? ' AND ' + extraWhere.join(' AND ') : '';

  if (gvari || saxeli) {
    let rows = [];
    if (gvari && saxeli) {
      const sVars = getNameVariants(saxeli);
      const gVars = getNameVariants(gvari);

      const sPlaceholders = sVars.map(() => '?').join(',');
      const sqlExact = `
        SELECT * FROM records
        WHERE gvari = ? AND saxeli IN (${sPlaceholders}) ${extraSql}
        LIMIT ? OFFSET ?
      `;
      rows = db.prepare(sqlExact).all(gvari, ...sVars, ...extraArgs, limit, offset);

      if (rows.length === 0 && offset === 0) {
        const gPlaceholders = gVars.map(() => '?').join(',');
        const sqlSwapped = `
          SELECT * FROM records
          WHERE gvari = ? AND saxeli IN (${gPlaceholders}) ${extraSql}
          LIMIT ? OFFSET ?
        `;
        rows = db.prepare(sqlSwapped).all(saxeli, ...gVars, ...extraArgs, limit, offset);
      }

      if (rows.length === 0 && offset === 0) {
        const sStem = sVars[sVars.length - 1];
        const sqlPrefix = `
          SELECT * FROM records
          WHERE gvari >= ? AND gvari < ? AND saxeli >= ? AND saxeli < ? ${extraSql}
          LIMIT ? OFFSET ?
        `;
        rows = db.prepare(sqlPrefix).all(
          gvari, gvari + '\uffff',
          sStem, sStem + '\uffff',
          ...extraArgs, limit, offset
        );
      }
    } else if (gvari) {
      const sqlExact = `
        SELECT * FROM records
        WHERE gvari = ? ${extraSql}
        LIMIT ? OFFSET ?
      `;
      rows = db.prepare(sqlExact).all(gvari, ...extraArgs, limit, offset);

      if (rows.length === 0 && offset === 0) {
        const sqlPrefix = `
          SELECT * FROM records
          WHERE gvari >= ? AND gvari < ? ${extraSql}
          LIMIT ? OFFSET ?
        `;
        rows = db.prepare(sqlPrefix).all(gvari, gvari + '\uffff', ...extraArgs, limit, offset);
      }
    } else if (saxeli) {
      const sVars = getNameVariants(saxeli);
      const sPlaceholders = sVars.map(() => '?').join(',');
      const sqlExact = `
        SELECT * FROM records
        WHERE saxeli IN (${sPlaceholders}) ${extraSql}
        LIMIT ? OFFSET ?
      `;
      rows = db.prepare(sqlExact).all(...sVars, ...extraArgs, limit, offset);

      if (rows.length === 0 && offset === 0) {
        const sStem = sVars[sVars.length - 1];
        const sqlPrefix = `
          SELECT * FROM records
          WHERE saxeli >= ? AND saxeli < ? ${extraSql}
          LIMIT ? OFFSET ?
        `;
        rows = db.prepare(sqlPrefix).all(sStem, sStem + '\uffff', ...extraArgs, limit, offset);
      }
    }

    return {
      rows: attachExtrasToRows(rows),
      elapsedMs: Date.now() - t0
    };
  }

  if (q) {
    // Check if search is by #ID (e.g. "#23")
    if (/^#\d+$/.test(q)) {
      const idNum = parseInt(q.slice(1), 10);
      const rows = db.prepare('SELECT * FROM records WHERE id = ?').all(idNum);
      return { rows: attachExtrasToRows(rows), elapsedMs: Date.now() - t0 };
    }

    const tokens = q.split(/\s+/).filter(Boolean);

    if (tokens.length === 1) {
      const tok = tokens[0];
      if (/^\d+$/.test(tok)) {
        // Also check if phone matches in person_extras
        const extraPhoneRows = db.prepare('SELECT record_id FROM person_extras WHERE phone LIKE ? LIMIT 20').all('%' + tok + '%');
        if (extraPhoneRows.length > 0 && tok.length < 11) {
          const ids = extraPhoneRows.map(r => r.record_id);
          const rows = db.prepare(`SELECT * FROM records WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
          if (rows.length > 0) {
            return { rows: attachExtrasToRows(rows), elapsedMs: Date.now() - t0 };
          }
        }

        const sql = tok.length === 11
          ? `SELECT * FROM records WHERE piradi = ? ${extraSql} LIMIT ? OFFSET ?`
          : `SELECT * FROM records WHERE piradi >= ? AND piradi < ? ${extraSql} LIMIT ? OFFSET ?`;
        const args = tok.length === 11
          ? [tok, ...extraArgs, limit, offset]
          : [tok, tok + '\uffff', ...extraArgs, limit, offset];
        const rows = db.prepare(sql).all(...args);
        return { rows: attachExtrasToRows(rows), elapsedMs: Date.now() - t0 };
      }

      const geoTok = ensureGeorgian(tok);
      const vars = getNameVariants(geoTok);
      const vPlaceholders = vars.map(() => '?').join(',');

      const sqlGvari = `SELECT * FROM records WHERE gvari = ? ${extraSql} LIMIT ? OFFSET ?`;
      let rows = db.prepare(sqlGvari).all(geoTok, ...extraArgs, limit, offset);

      if (rows.length === 0) {
        const sqlSaxeli = `SELECT * FROM records WHERE saxeli IN (${vPlaceholders}) ${extraSql} LIMIT ? OFFSET ?`;
        rows = db.prepare(sqlSaxeli).all(...vars, ...extraArgs, limit, offset);
      }

      if (rows.length === 0 && offset === 0) {
        const sqlPrefix = `SELECT * FROM records WHERE gvari >= ? AND gvari < ? ${extraSql} LIMIT ? OFFSET ?`;
        rows = db.prepare(sqlPrefix).all(geoTok, geoTok + '\uffff', ...extraArgs, limit, offset);
      }

      return { rows: attachExtrasToRows(rows), elapsedMs: Date.now() - t0 };
    }

    const t1 = ensureGeorgian(tokens[0]);
    const t2 = ensureGeorgian(tokens[1]);
    const t3 = tokens[2] ? ensureGeorgian(tokens[2]) : '';

    const v1 = getNameVariants(t1);
    const v2 = getNameVariants(t2);
    const v3 = t3 ? getNameVariants(t3) : [];

    let mSql = '';
    let mArgs = [];
    if (v3.length > 0) {
      mSql = ` AND mamis_saxeli IN (${v3.map(() => '?').join(',')})`;
      mArgs = v3;
    }

    const sqlBoth = `
      SELECT * FROM records
      WHERE gvari = ? AND saxeli IN (${v1.map(() => '?').join(',')}) ${mSql} ${extraSql}
      UNION
      SELECT * FROM records
      WHERE gvari = ? AND saxeli IN (${v2.map(() => '?').join(',')}) ${mSql} ${extraSql}
      LIMIT ? OFFSET ?
    `;
    let rows = db.prepare(sqlBoth).all(
      t2, ...v1, ...mArgs, ...extraArgs,
      t1, ...v2, ...mArgs, ...extraArgs,
      limit, offset
    );

    if (rows.length === 0 && offset === 0) {
      const s1Stem = v1[v1.length - 1];
      const s2Stem = v2[v2.length - 1];
      const sqlPrefix1 = `
        SELECT * FROM records
        WHERE gvari >= ? AND gvari < ? AND saxeli >= ? AND saxeli < ? ${extraSql}
        LIMIT ? OFFSET ?
      `;
      rows = db.prepare(sqlPrefix1).all(t2, t2 + '\uffff', s1Stem, s1Stem + '\uffff', ...extraArgs, limit, offset);
      if (rows.length === 0) {
        rows = db.prepare(sqlPrefix1).all(t1, t1 + '\uffff', s2Stem, s2Stem + '\uffff', ...extraArgs, limit, offset);
      }
    }

    return { rows: attachExtrasToRows(rows), elapsedMs: Date.now() - t0 };
  }

  if (extraWhere.length > 0) {
    const sql = `SELECT * FROM records WHERE ${extraWhere.join(' AND ')} LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...extraArgs, limit, offset);
    return { rows: attachExtrasToRows(rows), elapsedMs: Date.now() - t0 };
  }

  const rows = db.prepare('SELECT * FROM records LIMIT ? OFFSET ?').all(Math.min(limit, 50), offset);
  return { rows: attachExtrasToRows(rows), elapsedMs: Date.now() - t0 };
}

function saveBase64Image(dataUrl, prefix) {
  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    return dataUrl || '';
  }
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
  if (!match) return '';
  let ext = match[1].toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  const buf = Buffer.from(match[2], 'base64');
  const fileName = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, fileName);
  fs.writeFileSync(filePath, buf);
  return `/uploads/${fileName}`;
}

function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // API: Admin Login
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const rawUser = (body.username || '').trim();
      const rawPass = (body.password || '').trim();
      const normUser = normalizeLoginString(rawUser).toLowerCase();
      const normPass = normalizeLoginString(rawPass);
      if (VALID_USERS.has(normUser) && (VALID_PASSES.has(rawPass) || VALID_PASSES.has(normPass))) {
        const token = crypto.randomBytes(24).toString('hex');
        activeTokens.add(token);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, token }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'არასწორი მომხმარებელი ან პაროლი!' }));
      }
      return;
    }

    // API: Admin Save / Update Person (or Create New Person)
    if (pathname === '/api/admin/save-person' && req.method === 'POST') {
      if (!isValidToken(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'არაავტორიზებული წვდომა' }));
        return;
      }

      const body = await readJsonBody(req);
      let recordId = parseInt(body.id || '0', 10);

      const piradi = (body.piradi || '').trim();
      const gvari = ensureGeorgian(body.gvari || '');
      const saxeli = ensureGeorgian(body.saxeli || '');
      const mamis_saxeli = ensureGeorgian(body.mamis_saxeli || '');
      const dab_weli = (body.dab_weli || '').trim();
      const reg_tarigi = (body.reg_tarigi || '').trim();
      const dmonac = ensureGeorgian(body.dmonac || '');
      const sqesi = (body.sqesi || '').trim();
      const mocmobis = (body.mocmobis || '').trim();
      const quca = ensureGeorgian(body.quca || '');
      const raioni = ensureGeorgian(body.raioni || '');

      if (recordId > 0) {
        const existing = db.prepare('SELECT id FROM records WHERE id = ?').get(recordId);
        if (!existing) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'ჩანაწერი ამ ID-ით ვერ მოიძებნა' }));
          return;
        }
        db.prepare(`
          UPDATE records
          SET piradi = ?, gvari = ?, saxeli = ?, mamis_saxeli = ?, dab_weli = ?,
              reg_tarigi = ?, dmonac = ?, sqesi = ?, mocmobis = ?, quca = ?, raioni = ?
          WHERE id = ?
        `).run(piradi, gvari, saxeli, mamis_saxeli, dab_weli, reg_tarigi, dmonac, sqesi, mocmobis, quca, raioni, recordId);
      } else {
        TOTAL_RECORDS += 1;
        recordId = TOTAL_RECORDS;
        db.prepare(`
          INSERT INTO records (id, piradi, gvari, saxeli, mamis_saxeli, dab_weli, reg_tarigi, dmonac, sqesi, mocmobis, quca, raioni)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(recordId, piradi, gvari, saxeli, mamis_saxeli, dab_weli, reg_tarigi, dmonac, sqesi, mocmobis, quca, raioni);
      }

      const prevExtra = db.prepare('SELECT * FROM person_extras WHERE record_id = ?').get(recordId) || {};

      let photoUrl = prevExtra.photo_url || '';
      if (body.photo_data !== undefined) {
        photoUrl = body.photo_data ? saveBase64Image(body.photo_data, `person_${recordId}`) : '';
      }

      let fatherPhotoUrl = prevExtra.father_photo_url || '';
      if (body.father_photo_data !== undefined) {
        fatherPhotoUrl = body.father_photo_data ? saveBase64Image(body.father_photo_data, `father_${recordId}`) : '';
      }

      const phone = body.phone !== undefined ? (body.phone || '').trim() : (prevExtra.phone || '');
      const actual_address = body.actual_address !== undefined ? ensureGeorgian(body.actual_address || '') : (prevExtra.actual_address || '');
      const workplace = body.workplace !== undefined ? ensureGeorgian(body.workplace || '') : (prevExtra.workplace || '');
      const vehicle = body.vehicle !== undefined ? (body.vehicle || '').trim() : (prevExtra.vehicle || '');
      const status_note = body.status_note !== undefined ? ensureGeorgian(body.status_note || '') : (prevExtra.status_note || '');
      const notes = body.notes !== undefined ? (body.notes || '').trim() : (prevExtra.notes || '');
      const updated_at = new Date().toISOString();

      db.prepare(`
        INSERT INTO person_extras (record_id, photo_url, father_photo_url, phone, actual_address, workplace, vehicle, status_note, notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(record_id) DO UPDATE SET
          photo_url = excluded.photo_url,
          father_photo_url = excluded.father_photo_url,
          phone = excluded.phone,
          actual_address = excluded.actual_address,
          workplace = excluded.workplace,
          vehicle = excluded.vehicle,
          status_note = excluded.status_note,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `).run(recordId, photoUrl, fatherPhotoUrl, phone, actual_address, workplace, vehicle, status_note, notes, updated_at);

      const updatedPerson = attachExtrasToRows([db.prepare('SELECT * FROM records WHERE id = ?').get(recordId)])[0];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, person: updatedPerson }));
      return;
    }

    // API: List modified/enriched records in Admin Panel
    if (pathname === '/api/admin/modified-list') {
      if (!isValidToken(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'არაავტორიზებული წვდომა' }));
        return;
      }
      const extras = db.prepare('SELECT record_id FROM person_extras ORDER BY updated_at DESC LIMIT 50').all();
      const ids = extras.map(e => e.record_id);
      let rows = [];
      if (ids.length > 0) {
        rows = db.prepare(`SELECT * FROM records WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, rows: attachExtrasToRows(rows) }));
      return;
    }

    // API: Search
    if (pathname === '/api/search') {
      const params = parseSearchParams(parsedUrl.searchParams);
      const result = executeSearch(params);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        totalRecordsInDb: TOTAL_RECORDS,
        count: result.rows.length,
        elapsedMs: result.elapsedMs,
        rows: result.rows
      }));
      return;
    }

    // API: Person Full Dossier
    if (pathname === '/api/person') {
      const id = parseInt(parsedUrl.searchParams.get('id') || '0', 10);
      const rawPerson = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
      if (!rawPerson) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'ჩანაწერი ვერ მოიძებნა' }));
        return;
      }

      const person = attachExtrasToRows([rawPerson])[0];

      // Find co-residents / family members by same surname + address
      let coResidents = [];
      if (person.quca && person.quca.length > 6) {
        const rawCo = db.prepare(
          'SELECT * FROM records WHERE gvari = ? AND quca = ? AND id != ? LIMIT 30'
        ).all(person.gvari, person.quca, person.id);
        coResidents = attachExtrasToRows(rawCo);
      }

      // Try to find likely father record at same address if mamis_saxeli is known
      let likelyFather = null;
      if (person.mamis_saxeli && coResidents.length > 0) {
        const fVars = new Set(getNameVariants(person.mamis_saxeli));
        likelyFather = coResidents.find(c => fVars.has(c.saxeli) && String(c.sqesi) === '1') || null;
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ person, coResidents, likelyFather }));
      return;
    }

    // Serve static files
    let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`MIA Database Server running on port ${PORT}`);
});
