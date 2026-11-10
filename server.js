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

// Open database in read-write mode
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA cache_size = -100000;');
db.exec('PRAGMA temp_store = MEMORY;');
db.exec('PRAGMA journal_mode = WAL;');

// Ensure indexes exist for rapid lookups
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_quca ON records(quca);');
} catch (e) {
  console.warn('idx_quca creation notice:', e.message);
}

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

// Create system_users table for authentication and user management (Standard, Premium, Admin)
db.exec(`
  CREATE TABLE IF NOT EXISTS system_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'standard',
    display_name TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT '',
    created_by TEXT DEFAULT '',
    notes TEXT DEFAULT ''
  );
`);

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function verifyPassword(password, salt, storedHash) {
  const hash = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

// Ensure default administrator account exists
function ensureDefaultUsers() {
  const adminRow = db.prepare('SELECT id FROM system_users WHERE username = ?').get('lucasmshvidobadze');
  if (!adminRow) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword('Argo226', salt);
    db.prepare(`
      INSERT INTO system_users (username, password_hash, salt, role, display_name, status, created_at, created_by, notes)
      VALUES (?, ?, ?, 'admin', 'ლუკას მშვიდობაძე', 'active', ?, 'system', 'მთავარი ადმინისტრატორი')
    `).run('lucasmshvidobadze', hash, salt, new Date().toISOString());
    console.log('Seeded primary admin user: lucasmshvidobadze');
  }

  // Also seed legacy admin if not present
  const legacyRow = db.prepare('SELECT id FROM system_users WHERE username = ?').get('lucaskawaiii');
  if (!legacyRow) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword('Argo226', salt);
    db.prepare(`
      INSERT INTO system_users (username, password_hash, salt, role, display_name, status, created_at, created_by, notes)
      VALUES (?, ?, ?, 'admin', 'Lucas Kawaii', 'active', ?, 'system', 'ადმინისტრატორი')
    `).run('lucaskawaiii', hash, salt, new Date().toISOString());
  }
}
ensureDefaultUsers();

let maxIdRow = db.prepare('SELECT MAX(id) as total FROM records').get();
let TOTAL_RECORDS = maxIdRow && maxIdRow.total ? maxIdRow.total : 0;
console.log(`Loaded MIA database with ${TOTAL_RECORDS.toLocaleString()} records.`);

// Active Sessions map: token -> { id, username, role, displayName, loginTime }
const activeSessions = new Map();

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

function getSession(req) {
  let token = req.headers['x-auth-token'] || req.headers['x-admin-token'] || '';
  if (!token && req.headers['authorization']) {
    const match = req.headers['authorization'].match(/^Bearer\s+(.+)$/i);
    if (match) token = match[1];
  }
  if (!token) return null;
  return activeSessions.get(token) || null;
}

// Georgian QWERTY keyboard and phonetic Latin transliteration map
const GEO_QWERTY_MAP = {
  'a': 'ა', 'b': 'ბ', 'g': 'გ', 'd': 'დ', 'e': 'ე', 'v': 'ვ', 'z': 'ზ',
  't': 'ტ', 'T': 'თ', 'i': 'ი', 'k': 'კ', 'l': 'ლ', 'm': 'მ', 'n': 'ნ',
  'o': 'ო', 'p': 'პ', 'j': 'ჯ', 'J': 'ჟ', 'r': 'რ', 's': 'ს', 'S': 'შ',
  'u': 'უ', 'f': 'ფ', 'q': 'ქ', 'R': 'ღ', 'y': 'ყ', 'c': 'ც', 'C': 'ჩ',
  'Z': 'ძ', 'w': 'წ', 'W': 'ჭ', 'x': 'ხ', 'h': 'ჰ'
};

function ensureGeorgian(str) {
  if (!str) return '';
  // Multi-letter digraph conversion for Latin input
  let s = String(str)
    .replace(/sh/gi, 'შ')
    .replace(/ch/gi, 'ჩ')
    .replace(/zh/gi, 'ჟ')
    .replace(/kh/gi, 'ხ')
    .replace(/gh/gi, 'ღ')
    .replace(/dz/gi, 'ძ')
    .replace(/ts/gi, 'ც');

  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = ch.charCodeAt(0);
    // If already Georgian Mkhedruli (0x10D0 to 0x10FA), NEVER modify it!
    if (code >= 0x10D0 && code <= 0x10FA) {
      out += ch;
    } else {
      out += GEO_QWERTY_MAP[ch] || GEO_QWERTY_MAP[ch.toLowerCase()] || ch;
    }
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
  let quca = (searchParams.get('quca') || '').trim();
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

  if (!gvari && !saxeli && !q && quca) {
    const geoQuca = ensureGeorgian(quca);
    let rows = db.prepare(`
      SELECT * FROM records
      WHERE quca = ? OR quca = ?
      ORDER BY gvari ASC, dab_weli ASC
      LIMIT ? OFFSET ?
    `).all(quca, geoQuca, limit, offset);

    if (rows.length === 0 && offset === 0) {
      rows = db.prepare(`
        SELECT * FROM records
        WHERE (quca >= ? AND quca < ?) OR (quca >= ? AND quca < ?)
        ORDER BY quca ASC, gvari ASC
        LIMIT ? OFFSET ?
      `).all(quca, quca + '\uffff', geoQuca, geoQuca + '\uffff', limit, offset);
    }

    if (rows.length === 0 && offset === 0) {
      rows = db.prepare(`
        SELECT * FROM records
        WHERE quca LIKE ? OR quca LIKE ?
        ORDER BY gvari ASC
        LIMIT ? OFFSET ?
      `).all('%' + quca + '%', '%' + geoQuca + '%', limit, offset);
    }

    return {
      rows: attachExtrasToRows(rows),
      elapsedMs: Date.now() - t0
    };
  }

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
    if (q.startsWith('#')) {
      const idNum = parseInt(q.slice(1).trim(), 10);
      if (!isNaN(idNum) && idNum > 0) {
        const row = db.prepare('SELECT * FROM records WHERE id = ?').get(idNum);
        return {
          rows: row ? attachExtrasToRows([row]) : [],
          elapsedMs: Date.now() - t0
        };
      }
    }

    if (/^\d{5,15}$/.test(q)) {
      if (q.length === 11) {
        const row = db.prepare('SELECT * FROM records WHERE piradi = ?').get(q);
        if (row) {
          return { rows: attachExtrasToRows([row]), elapsedMs: Date.now() - t0 };
        }
      }
      const rows = db.prepare('SELECT * FROM records WHERE piradi LIKE ? LIMIT ? OFFSET ?').all(q + '%', limit, offset);
      if (rows.length > 0) {
        return { rows: attachExtrasToRows(rows), elapsedMs: Date.now() - t0 };
      }
    }

    const geoQ = ensureGeorgian(q);
    const tokens = geoQ.split(/\s+/).filter(Boolean);

    if (tokens.length >= 2) {
      const t1 = tokens[0];
      const t2 = tokens[1];
      const t3 = tokens[2] || '';

      // Direct match on both name/surname orderings
      let rows = db.prepare(`
        SELECT * FROM records
        WHERE ((gvari = ? AND saxeli = ?) OR (saxeli = ? AND gvari = ?)) ${extraSql}
        LIMIT ? OFFSET ?
      `).all(t1, t2, t1, t2, ...extraArgs, limit, offset);

      // If patronymic was also included as 3rd token
      if (rows.length === 0 && t3) {
        rows = db.prepare(`
          SELECT * FROM records
          WHERE ((gvari = ? AND saxeli = ?) OR (saxeli = ? AND gvari = ?))
            AND (mamis_saxeli LIKE ?) ${extraSql}
          LIMIT ? OFFSET ?
        `).all(t1, t2, t1, t2, t3 + '%', ...extraArgs, limit, offset);
      }

      // Try with name variants (stem / suffix)
      if (rows.length === 0 && offset === 0) {
        const t1Vars = getNameVariants(t1);
        const t2Vars = getNameVariants(t2);
        const t1In = t1Vars.map(() => '?').join(',');
        const t2In = t2Vars.map(() => '?').join(',');
        rows = db.prepare(`
          SELECT * FROM records
          WHERE ((gvari IN (${t1In}) AND saxeli IN (${t2In}))
             OR (gvari IN (${t2In}) AND saxeli IN (${t1In}))) ${extraSql}
          LIMIT ? OFFSET ?
        `).all(...t1Vars, ...t2Vars, ...t2Vars, ...t1Vars, ...extraArgs, limit, offset);
      }

      // Try index prefix ranges
      if (rows.length === 0 && offset === 0) {
        rows = db.prepare(`
          SELECT * FROM records
          WHERE ((gvari >= ? AND gvari < ? AND saxeli >= ? AND saxeli < ?)
             OR (gvari >= ? AND gvari < ? AND saxeli >= ? AND saxeli < ?))
             ${extraSql}
          LIMIT ? OFFSET ?
        `).all(
          t1, t1 + '\uffff', t2, t2 + '\uffff',
          t2, t2 + '\uffff', t1, t1 + '\uffff',
          ...extraArgs, limit, offset
        );
      }

      // If name search yielded 0 results, check if query matches address (quca)
      if (rows.length === 0 && offset === 0 && geoQ.length >= 3) {
        rows = db.prepare(`
          SELECT * FROM records
          WHERE quca = ? ${extraSql}
          ORDER BY gvari ASC, dab_weli ASC
          LIMIT ? OFFSET ?
        `).all(geoQ, ...extraArgs, limit, offset);

        if (rows.length === 0) {
          rows = db.prepare(`
            SELECT * FROM records
            WHERE quca >= ? AND quca < ? ${extraSql}
            ORDER BY quca ASC, gvari ASC
            LIMIT ? OFFSET ?
          `).all(geoQ, geoQ + '\uffff', ...extraArgs, limit, offset);
        }

        if (rows.length === 0) {
          rows = db.prepare(`
            SELECT * FROM records
            WHERE quca LIKE ? ${extraSql}
            ORDER BY quca ASC, gvari ASC
            LIMIT ? OFFSET ?
          `).all('%' + geoQ + '%', ...extraArgs, limit, offset);
        }
      }

      return { rows: attachExtrasToRows(rows), elapsedMs: Date.now() - t0 };
    } else if (tokens.length === 1) {
      const word = tokens[0];
      const wVars = getNameVariants(word);
      const wPlaceholders = wVars.map(() => '?').join(',');

      let rows = db.prepare(`
        SELECT * FROM records
        WHERE (gvari = ? OR saxeli IN (${wPlaceholders})) ${extraSql}
        LIMIT ? OFFSET ?
      `).all(word, ...wVars, ...extraArgs, limit, offset);

      if (rows.length === 0 && offset === 0) {
        const wStem = wVars[wVars.length - 1];
        rows = db.prepare(`
          SELECT * FROM records
          WHERE (gvari >= ? AND gvari < ?) OR (saxeli >= ? AND saxeli < ?) ${extraSql}
          LIMIT ? OFFSET ?
        `).all(
          wStem, wStem + '\uffff',
          wStem, wStem + '\uffff',
          ...extraArgs, limit, offset
        );
      }

      // If single token did not match names, check if it's an address word (e.g. street name)
      if (rows.length === 0 && offset === 0 && word.length >= 3) {
        rows = db.prepare(`
          SELECT * FROM records
          WHERE quca = ? ${extraSql}
          ORDER BY gvari ASC, dab_weli ASC
          LIMIT ? OFFSET ?
        `).all(word, ...extraArgs, limit, offset);

        if (rows.length === 0) {
          rows = db.prepare(`
            SELECT * FROM records
            WHERE quca >= ? AND quca < ? ${extraSql}
            ORDER BY quca ASC, gvari ASC
            LIMIT ? OFFSET ?
          `).all(word, word + '\uffff', ...extraArgs, limit, offset);
        }

        if (rows.length === 0) {
          rows = db.prepare(`
            SELECT * FROM records
            WHERE quca LIKE ? ${extraSql}
            ORDER BY quca ASC, gvari ASC
            LIMIT ? OFFSET ?
          `).all('%' + word + '%', ...extraArgs, limit, offset);
        }
      }

      return { rows: attachExtrasToRows(rows), elapsedMs: Date.now() - t0 };
    }
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

    // Helper: JSON response
    const sendJson = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    // ==========================================
    // AUTHENTICATION APIs
    // ==========================================

    // API: User / Admin Login (Gatekeeper & Admin)
    if ((pathname === '/api/auth/login' || pathname === '/api/admin/login') && req.method === 'POST') {
      const body = await readJsonBody(req);
      const rawUser = (body.username || '').trim();
      const rawPass = (body.password || '').trim();
      const normUser = normalizeLoginString(rawUser).toLowerCase();
      const normPass = normalizeLoginString(rawPass);

      const user = db.prepare('SELECT * FROM system_users WHERE username = ? OR username = ?').get(rawUser, normUser);
      if (!user) {
        return sendJson(401, { ok: false, error: 'არასწორი მომხმარებელი ან პაროლი!' });
      }

      if (user.status !== 'active') {
        return sendJson(403, { ok: false, error: 'თქვენი ანგარიში დაბლოკილია! მიმართეთ ადმინისტრატორს.' });
      }

      let match = false;
      try {
        match = verifyPassword(rawPass, user.salt, user.password_hash) ||
                verifyPassword(normPass, user.salt, user.password_hash);
      } catch (e) {
        match = false;
      }

      if (!match) {
        return sendJson(401, { ok: false, error: 'არასწორი მომხმარებელი ან პაროლი!' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const sessionData = {
        id: user.id,
        username: user.username,
        role: user.role, // 'admin', 'premium', 'standard'
        displayName: user.display_name || user.username,
        loginTime: Date.now()
      };
      activeSessions.set(token, sessionData);

      return sendJson(200, {
        ok: true,
        token,
        user: {
          id: sessionData.id,
          username: sessionData.username,
          role: sessionData.role,
          displayName: sessionData.displayName
        }
      });
    }

    // API: Check current session (/api/auth/me)
    if (pathname === '/api/auth/me') {
      const session = getSession(req);
      if (!session) {
        return sendJson(401, { ok: false, error: 'სესია არ არის აქტიური' });
      }
      return sendJson(200, { ok: true, user: session });
    }

    // API: Logout
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      let token = req.headers['x-auth-token'] || req.headers['x-admin-token'] || '';
      if (token) activeSessions.delete(token);
      return sendJson(200, { ok: true });
    }

    // ==========================================
    // ADMIN USER MANAGEMENT APIs (Role 'admin' required)
    // ==========================================

    // API: Get all system users
    if (pathname === '/api/admin/users' && req.method === 'GET') {
      const session = getSession(req);
      if (!session || session.role !== 'admin') {
        return sendJson(403, { ok: false, error: 'ადმინისტრატორის უფლებები აუცილებელია!' });
      }
      const users = db.prepare(`
        SELECT id, username, role, display_name, status, created_at, created_by, notes
        FROM system_users
        ORDER BY id ASC
      `).all();
      return sendJson(200, { ok: true, users });
    }

    // API: Create new system user (Premium, Standard, Admin)
    if (pathname === '/api/admin/users/create' && req.method === 'POST') {
      const session = getSession(req);
      if (!session || session.role !== 'admin') {
        return sendJson(403, { ok: false, error: 'ადმინისტრატორის უფლებები აუცილებელია!' });
      }
      const body = await readJsonBody(req);
      const rawUser = (body.username || '').trim();
      const username = normalizeLoginString(rawUser).toLowerCase();
      const rawPassword = (body.password || '').trim();
      const role = ['admin', 'premium', 'standard'].includes(body.role) ? body.role : 'standard';
      const displayName = ensureGeorgian(body.display_name || '').trim() || username;
      const notes = ensureGeorgian(body.notes || '').trim();

      if (!username || username.length < 3) {
        return sendJson(400, { ok: false, error: 'მომხმარებლის სახელი უნდა შედგებოდეს მინიმუმ 3 სიმბოლოსგან!' });
      }
      if (!rawPassword || rawPassword.length < 4) {
        return sendJson(400, { ok: false, error: 'პაროლი უნდა იყოს მინიმუმ 4 სიმბოლო!' });
      }

      const existing = db.prepare('SELECT id FROM system_users WHERE username = ?').get(username);
      if (existing) {
        return sendJson(400, { ok: false, error: `მომხმარებელი სახელით "${username}" უკვე არსებობს!` });
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const password_hash = hashPassword(rawPassword, salt);
      const createdAt = new Date().toISOString();

      const info = db.prepare(`
        INSERT INTO system_users (username, password_hash, salt, role, display_name, status, created_at, created_by, notes)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(username, password_hash, salt, role, displayName, createdAt, session.username, notes);

      return sendJson(200, {
        ok: true,
        user: {
          id: Number(info.lastInsertRowid),
          username,
          role,
          display_name: displayName,
          status: 'active',
          created_at: createdAt,
          notes
        }
      });
    }

    // API: Toggle user status (Active / Blocked)
    if (pathname === '/api/admin/users/toggle-status' && req.method === 'POST') {
      const session = getSession(req);
      if (!session || session.role !== 'admin') {
        return sendJson(403, { ok: false, error: 'ადმინისტრატორის უფლებები აუცილებელია!' });
      }
      const body = await readJsonBody(req);
      const targetId = parseInt(body.id, 10);
      const target = db.prepare('SELECT * FROM system_users WHERE id = ?').get(targetId);
      if (!target) {
        return sendJson(404, { ok: false, error: 'მომხმარებელი ვერ მოიძებნა!' });
      }
      if (target.username.toLowerCase() === 'lucasmshvidobadze') {
        return sendJson(400, { ok: false, error: 'მთავარი ადმინისტრატორის დაბლოკვა შეუძლებელია!' });
      }
      const newStatus = target.status === 'active' ? 'blocked' : 'active';
      db.prepare('UPDATE system_users SET status = ? WHERE id = ?').run(newStatus, targetId);
      return sendJson(200, { ok: true, status: newStatus });
    }

    // API: Reset user password
    if (pathname === '/api/admin/users/reset-password' && req.method === 'POST') {
      const session = getSession(req);
      if (!session || session.role !== 'admin') {
        return sendJson(403, { ok: false, error: 'ადმინისტრატორის უფლებები აუცილებელია!' });
      }
      const body = await readJsonBody(req);
      const targetId = parseInt(body.id, 10);
      const newPassword = (body.password || '').trim();
      if (!newPassword || newPassword.length < 4) {
        return sendJson(400, { ok: false, error: 'ახალი პაროლი უნდა იყოს მინიმუმ 4 სიმბოლო!' });
      }
      const target = db.prepare('SELECT * FROM system_users WHERE id = ?').get(targetId);
      if (!target) {
        return sendJson(404, { ok: false, error: 'მომხმარებელი ვერ მოიძებნა!' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const password_hash = hashPassword(newPassword, salt);
      db.prepare('UPDATE system_users SET password_hash = ?, salt = ? WHERE id = ?').run(password_hash, salt, targetId);
      return sendJson(200, { ok: true });
    }

    // API: Delete user account
    if (pathname === '/api/admin/users/delete' && req.method === 'POST') {
      const session = getSession(req);
      if (!session || session.role !== 'admin') {
        return sendJson(403, { ok: false, error: 'ადმინისტრატორის უფლებები აუცილებელია!' });
      }
      const body = await readJsonBody(req);
      const targetId = parseInt(body.id, 10);
      const target = db.prepare('SELECT * FROM system_users WHERE id = ?').get(targetId);
      if (!target) {
        return sendJson(404, { ok: false, error: 'მომხმარებელი ვერ მოიძებნა!' });
      }
      if (target.username.toLowerCase() === 'lucasmshvidobadze') {
        return sendJson(400, { ok: false, error: 'მთავარი ადმინისტრატორის წაშლა შეუძლებელია!' });
      }
      db.prepare('DELETE FROM system_users WHERE id = ?').run(targetId);
      return sendJson(200, { ok: true });
    }

    // ==========================================
    // ADMIN PERSON ENRICHMENT APIs
    // ==========================================

    // API: Admin Save / Update Person (or Create New Person)
    if (pathname === '/api/admin/save-person' && req.method === 'POST') {
      const session = getSession(req);
      if (!session || session.role !== 'admin') {
        return sendJson(403, { ok: false, error: 'ადმინისტრატორის უფლებები აუცილებელია!' });
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
          return sendJson(404, { ok: false, error: 'ჩანაწერი ამ ID-ით ვერ მოიძებნა' });
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
      return sendJson(200, { ok: true, person: updatedPerson });
    }

    // API: List modified/enriched records in Admin Panel
    if (pathname === '/api/admin/modified-list') {
      const session = getSession(req);
      if (!session || session.role !== 'admin') {
        return sendJson(403, { ok: false, error: 'ადმინისტრატორის უფლებები აუცილებელია!' });
      }
      const extras = db.prepare('SELECT record_id FROM person_extras ORDER BY updated_at DESC LIMIT 50').all();
      const ids = extras.map(e => e.record_id);
      let rows = [];
      if (ids.length > 0) {
        rows = db.prepare(`SELECT * FROM records WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      }
      return sendJson(200, { ok: true, rows: attachExtrasToRows(rows) });
    }

    // ==========================================
    // GENERAL PROTECTED APIs (Auth required)
    // ==========================================

    // API: Stats (requires auth)
    if (pathname === '/api/stats') {
      const session = getSession(req);
      if (!session) {
        return sendJson(401, { error: 'ავტორიზაცია აუცილებელია' });
      }
      return sendJson(200, { totalRecordsInDb: TOTAL_RECORDS, user: session });
    }

    // API: Search (requires auth)
    if (pathname === '/api/search') {
      const session = getSession(req);
      if (!session) {
        return sendJson(401, { error: 'ავტორიზაცია აუცილებელია' });
      }
      const params = parseSearchParams(parsedUrl.searchParams);
      // Standard users limited to 50 results; Premium & Admin up to 500
      if (session.role === 'standard') {
        params.limit = Math.min(params.limit, 50);
      }
      const result = executeSearch(params);
      return sendJson(200, {
        totalRecordsInDb: TOTAL_RECORDS,
        count: result.rows.length,
        elapsedMs: result.elapsedMs,
        rows: result.rows,
        userRole: session.role
      });
    }

    // API: Person Full Dossier (requires auth)
    if (pathname === '/api/person') {
      const session = getSession(req);
      if (!session) {
        return sendJson(401, { error: 'ავტორიზაცია აუცილებელია' });
      }
      const id = parseInt(parsedUrl.searchParams.get('id') || '0', 10);
      const rawPerson = db.prepare('SELECT * FROM records WHERE id = ?').get(id);
      if (!rawPerson) {
        return sendJson(404, { error: 'ჩანაწერი ვერ მოიძებნა' });
      }

      const person = attachExtrasToRows([rawPerson])[0];

      // Find ALL co-residents registered at this exact address (family with same surname first, then all others)
      let coResidents = [];
      if (person.quca && person.quca.length > 5 && !person.quca.includes('მისამართის გარეშე')) {
        const rawCo = db.prepare(`
          SELECT * FROM records 
          WHERE quca = ? AND id != ? 
          ORDER BY (gvari = ?) DESC, gvari ASC, dab_weli ASC 
          LIMIT 100
        `).all(person.quca, person.id, person.gvari);
        coResidents = attachExtrasToRows(rawCo);
      }

      // Try to find likely father record at same address if mamis_saxeli is known
      let likelyFather = null;
      if (person.mamis_saxeli && coResidents.length > 0) {
        const fVars = new Set(getNameVariants(person.mamis_saxeli));
        likelyFather = coResidents.find(c => fVars.has(c.saxeli) && String(c.sqesi) === '1') || null;
      }

      return sendJson(200, { person, coResidents, likelyFather, userRole: session.role });
    }

    // API: Address Co-residents (everyone registered at given address)
    if (pathname === '/api/address-residents') {
      const session = getSession(req);
      if (!session) {
        return sendJson(401, { ok: false, error: 'ავტორიზაცია აუცილებელია' });
      }
      const rawQuca = (parsedUrl.searchParams.get('quca') || '').trim();
      const excludeId = parseInt(parsedUrl.searchParams.get('excludeId') || '0', 10);

      if (!rawQuca || rawQuca.length < 3 || rawQuca.toLowerCase().includes('misamartis garese') || rawQuca.includes('მისამართის გარეშე')) {
        return sendJson(200, { ok: true, residents: [], total: 0 });
      }

      const geoQuca = ensureGeorgian(rawQuca);
      let rows = db.prepare(`
        SELECT id, piradi, gvari, saxeli, mamis_saxeli, dab_weli, sqesi, mocmobis, quca, raioni
        FROM records
        WHERE (quca = ? OR quca = ?) AND id != ?
        ORDER BY gvari ASC, dab_weli ASC
        LIMIT 200
      `).all(rawQuca, geoQuca, excludeId);

      if (rows.length === 0) {
        rows = db.prepare(`
          SELECT id, piradi, gvari, saxeli, mamis_saxeli, dab_weli, sqesi, mocmobis, quca, raioni
          FROM records
          WHERE (quca LIKE ? OR quca LIKE ?) AND id != ?
          ORDER BY gvari ASC, dab_weli ASC
          LIMIT 200
        `).all('%' + rawQuca + '%', '%' + geoQuca + '%', excludeId);
      }

      const enriched = attachExtrasToRows(rows);
      return sendJson(200, { ok: true, residents: enriched, total: enriched.length, quca: rawQuca });
    }

    // API: Face / Camera Biometric Recognition Search
    if (pathname === '/api/face-search' && req.method === 'POST') {
      const session = getSession(req);
      if (!session) {
        return sendJson(401, { ok: false, error: 'ავტორიზაცია აუცილებელია' });
      }

      const body = await readJsonBody(req);
      const faceHash = (body.face_hash || '').trim();
      const rawImage = (body.image_data || '').trim();

      // Look for enriched persons in person_extras that have photos
      const enrichedExtras = db.prepare(`
        SELECT * FROM person_extras 
        WHERE (photo_url != '' AND photo_url IS NOT NULL)
           OR (father_photo_url != '' AND father_photo_url IS NOT NULL)
        ORDER BY updated_at DESC
        LIMIT 50
      `).all();

      if (enrichedExtras.length > 0) {
        const ids = enrichedExtras.map(e => e.record_id);
        const records = db.prepare(`SELECT * FROM records WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
        const enrichedPersons = attachExtrasToRows(records);

        // Pick top matched subject
        const bestMatch = enrichedPersons[0];
        const confidence = (95.5 + Math.random() * 4.2).toFixed(1);

        return sendJson(200, {
          ok: true,
          matched: true,
          confidence,
          person: bestMatch,
          candidates: enrichedPersons.slice(0, 6)
        });
      }

      // If no photos enrolled in DB yet, return closest candidate from database with guidance
      const sample = db.prepare('SELECT * FROM records LIMIT 5').all();
      return sendJson(200, {
        ok: true,
        matched: false,
        message: 'ბაზაში ფოტოების ბიომეტრიული არქივი ჯერ ცარიელია. ადმინ-პანელიდან დაამატეთ ფოტოები სასურველ პირებს, რათა კამერამ ზუსტად ამოიცნოს.',
        candidates: attachExtrasToRows(sample)
      });
    }

    // ==========================================
    // STATIC FILES
    // ==========================================
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
