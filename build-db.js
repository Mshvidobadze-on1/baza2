const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(__dirname, 'baza.db');

const ACAD_MAP = {
  'a': 'ა', 'b': 'ბ', 'g': 'გ', 'd': 'დ', 'e': 'ე', 'v': 'ვ', 'z': 'ზ',
  'T': 'თ', 'i': 'ი', 'k': 'კ', 'l': 'ლ', 'm': 'მ', 'n': 'ნ', 'o': 'ო',
  'p': 'პ', 'J': 'ჟ', 'r': 'რ', 's': 'ს', 't': 'ტ', 'u': 'უ', 'f': 'ფ',
  'q': 'ქ', 'R': 'ღ', 'y': 'ყ', 'S': 'შ', 'C': 'ჩ', 'c': 'ც', 'Z': 'ძ',
  'w': 'წ', 'W': 'ჭ', 'x': 'ხ', 'j': 'ჯ', 'h': 'ჰ'
};

const CHAR_MAP = new Array(128);
for (let i = 0; i < 128; i++) {
  const ch = String.fromCharCode(i);
  CHAR_MAP[i] = ACAD_MAP[ch] || ch;
}

function toGeorgian(str) {
  if (!str) return '';
  let out = '';
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    out += code < 128 ? CHAR_MAP[code] : str[i];
  }
  return out.trim();
}

function stripQuotes(s) {
  if (!s) return '';
  const len = s.length;
  if (len >= 2 && s.charCodeAt(0) === 34 && s.charCodeAt(len - 1) === 34) {
    return s.slice(1, len - 1);
  }
  return s;
}

function parseCSVLine(line) {
  const parts = line.split(',');
  if (parts.length === 11) {
    for (let i = 0; i < 11; i++) {
      parts[i] = stripQuotes(parts[i]);
    }
    return parts;
  }

  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  result.push(cur);

  if (result.length === 10 && /^\d{2}\/\d{2}\/\d{2}/.test(result[3])) {
    result.splice(3, 0, '');
  }
  while (result.length < 11) {
    result.push('');
  }
  return result;
}

async function buildDatabase() {
  if (fs.existsSync(DB_FILE)) {
    console.log('Database already exists at:', DB_FILE);
    return;
  }

  const partFiles = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('baza.part') && f.endsWith('.gz'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)[0], 10);
      const numB = parseInt(b.match(/\d+/)[0], 10);
      return numA - numB;
    });

  if (partFiles.length === 0) {
    console.error('No data parts found in', DATA_DIR);
    process.exit(1);
  }

  console.log(`Found ${partFiles.length} data part(s). Initializing SQLite database (low-memory mode)...`);
  const startTime = Date.now();
  const db = new DatabaseSync(DB_FILE);

  db.exec(`
    PRAGMA page_size = 4096;
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA cache_size = -32000;
    PRAGMA temp_store = FILE;

    CREATE TABLE records (
      id INTEGER PRIMARY KEY,
      piradi TEXT,
      gvari TEXT,
      saxeli TEXT,
      mamis_saxeli TEXT,
      dab_weli TEXT,
      reg_tarigi TEXT,
      dmonac TEXT,
      sqesi TEXT,
      mocmobis TEXT,
      quca TEXT,
      raioni TEXT
    );

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

  const insertStmt = db.prepare(
    'INSERT INTO records (id, piradi, gvari, saxeli, mamis_saxeli, dab_weli, reg_tarigi, dmonac, sqesi, mocmobis, quca, raioni) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  let rowId = 0;
  let isFirstLine = true;
  let leftover = '';

  db.exec('BEGIN');

  for (const part of partFiles) {
    console.log(`Extracting and importing ${part}...`);
    const partPath = path.join(DATA_DIR, part);
    const stream = fs.createReadStream(partPath).pipe(zlib.createGunzip());

    for await (const chunk of stream) {
      const data = leftover + chunk.toString('utf8');
      let start = 0;
      let idx;
      while ((idx = data.indexOf('\n', start)) !== -1) {
        let line = data.slice(start, idx);
        start = idx + 1;
        if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
          line = line.slice(0, line.length - 1);
        }
        if (!line) continue;
        if (isFirstLine) {
          isFirstLine = false;
          continue;
        }

        rowId++;
        const cols = parseCSVLine(line);
        insertStmt.run(
          rowId,
          cols[0].trim(),
          toGeorgian(cols[1]),
          toGeorgian(cols[2]),
          toGeorgian(cols[3]),
          cols[4].trim(),
          cols[5].trim(),
          toGeorgian(cols[6]),
          cols[7].trim(),
          cols[8].trim(),
          toGeorgian(cols[9]),
          toGeorgian(cols[10])
        );

        if (rowId % 100000 === 0) {
          db.exec('COMMIT');
          console.log(`Imported ${rowId.toLocaleString()} rows...`);
          db.exec('BEGIN');
        }
      }
      leftover = data.slice(start);
    }
  }

  if (leftover.trim() && !isFirstLine) {
    rowId++;
    const cols = parseCSVLine(leftover.trim());
    insertStmt.run(
      rowId,
      cols[0].trim(),
      toGeorgian(cols[1]),
      toGeorgian(cols[2]),
      toGeorgian(cols[3]),
      cols[4].trim(),
      cols[5].trim(),
      toGeorgian(cols[6]),
      cols[7].trim(),
      cols[8].trim(),
      toGeorgian(cols[9]),
      toGeorgian(cols[10])
    );
  }

  db.exec('COMMIT');
  console.log(`Inserted ${rowId.toLocaleString()} rows in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Building indexes...`);

  db.exec('CREATE INDEX IF NOT EXISTS idx_gvari_saxeli ON records(gvari, saxeli);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_saxeli_gvari ON records(saxeli, gvari);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_piradi ON records(piradi);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_quca ON records(quca);');

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.close();

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Database build finished in ${totalTime}s! Ready to serve.`);
}

if (require.main === module) {
  buildDatabase().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}

module.exports = buildDatabase;
