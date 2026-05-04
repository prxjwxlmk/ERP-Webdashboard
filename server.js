const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const os       = require('os');
const Database = require('better-sqlite3');
const multer   = require('multer');
const nodemailer = require('nodemailer');

const app     = express();
const PORT    = 8080;
const DB_FILE    = path.join(__dirname, 'motorstock.db');
const AUTH_FILE  = path.join(__dirname, 'auth.json');
const ALERT_FILE = path.join(__dirname, 'alert-config.json');
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const TRF_FILES_DIR = path.join(__dirname, 'uploads', 'transformer');

// ── Create upload folders if they don't exist ────────────────────
fs.mkdirSync(UPLOADS_DIR,   { recursive: true });
fs.mkdirSync(TRF_FILES_DIR, { recursive: true });

app.use(express.static(__dirname));
app.use(express.json({ limit: '20mb' }));

// JSON body parser error handling
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  next(err);
});

// ── Serve uploaded images ─────────────────────────────────────────
app.use('/uploads', express.static(UPLOADS_DIR));

// ════════════════════════════════════════════════════
// MULTER — image upload config (materials/motors)
// ════════════════════════════════════════════════════
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext    = path.extname(file.originalname).toLowerCase();
    const prefix = req.query.type === 'motor' ? 'mot' : 'mat';
    const unique = crypto.randomBytes(8).toString('hex');
    cb(null, `${prefix}_${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Images only (jpg, png, gif, webp)'));
  }
});

// ════════════════════════════════════════════════════
// MULTER — transformer test file upload config
// Accepts PDF, Excel, Word, images — max 20MB
// ════════════════════════════════════════════════════
const trfStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TRF_FILES_DIR),
  filename: (req, file, cb) => {
    const ext    = path.extname(file.originalname).toLowerCase();
    const unique = crypto.randomBytes(10).toString('hex');
    cb(null, `trf_${unique}${ext}`);
  }
});

const trfUpload = multer({
  storage: trfStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB — test result sheets can be large
  fileFilter: (req, file, cb) => {
    const allowed = [
      '.pdf', '.xlsx', '.xls', '.csv',
      '.docx', '.doc', '.txt',
      '.jpg', '.jpeg', '.png', '.gif', '.webp'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Unsupported file type'));
  }
});

// ════════════════════════════════════════════════════
// DATABASE SETUP
// ════════════════════════════════════════════════════
const db = new Database(DB_FILE);

// WAL mode = multiple people can read at the same time,
// and a crash mid-write won't corrupt the database
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS materials (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    unit       TEXT    NOT NULL,
    qty        REAL    NOT NULL DEFAULT 0,
    min_qty    REAL    NOT NULL DEFAULT 0,
    category   TEXT    NOT NULL DEFAULT 'General',
    type       TEXT    NOT NULL DEFAULT 'raw',
    image      TEXT    NOT NULL DEFAULT '',
    created_at TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS motors (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    power      TEXT DEFAULT '',
    frame      TEXT DEFAULT '',
    image      TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS bom (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    motor_id    INTEGER NOT NULL REFERENCES motors(id)    ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    qty_per     REAL    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS productions (
    id         INTEGER PRIMARY KEY,
    motor_id   INTEGER,
    motor_name TEXT    NOT NULL,
    qty        INTEGER NOT NULL,
    prod_date  TEXT    NOT NULL,
    timestamp  TEXT    NOT NULL,
    logged_by  TEXT    DEFAULT '—'
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    ts   TEXT NOT NULL,
    type TEXT NOT NULL,
    msg  TEXT NOT NULL,
    by   TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS id_counter (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS stock_in (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id   INTEGER NOT NULL,
    material_name TEXT    NOT NULL,
    qty_received  REAL    NOT NULL,
    invoice_no    TEXT    NOT NULL DEFAULT '',
    received_date TEXT    NOT NULL,
    timestamp     TEXT    NOT NULL,
    received_by   TEXT    NOT NULL DEFAULT '—',
    notes         TEXT    NOT NULL DEFAULT '',
    payment_reminder_sent INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS material_process_bom (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    output_material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    input_material_id  INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    qty_required      REAL    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS material_processing_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    output_material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    qty_produced      REAL    NOT NULL,
    timestamp         TEXT    NOT NULL,
    processed_by      TEXT    NOT NULL DEFAULT '—'
  );

  -- ── TRANSFORMER MODULE TABLES ─────────────────────
  CREATE TABLE IF NOT EXISTS transformer_jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    job_no           TEXT    NOT NULL UNIQUE,
    customer_name    TEXT    NOT NULL,
    customer_contact TEXT    NOT NULL DEFAULT '',
    kva_rating       TEXT    NOT NULL DEFAULT '',
    received_date    TEXT    NOT NULL,
    expected_date    TEXT    NOT NULL DEFAULT '',
    fault_description TEXT   NOT NULL DEFAULT '',
    repair_work      TEXT    NOT NULL DEFAULT '',
    status           TEXT    NOT NULL DEFAULT 'Received',
    labour_charge    REAL    NOT NULL DEFAULT 0,
    payment_status   TEXT    NOT NULL DEFAULT 'Pending',
    created_by       TEXT    NOT NULL DEFAULT '—',
    created_at       TEXT    DEFAULT (datetime('now','localtime')),
    updated_at       TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS transformer_materials (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        INTEGER NOT NULL REFERENCES transformer_jobs(id) ON DELETE CASCADE,
    material_name TEXT    NOT NULL,
    qty_used      REAL    NOT NULL,
    unit          TEXT    NOT NULL DEFAULT '',
    cost_per_unit REAL    NOT NULL DEFAULT 0,
    added_by      TEXT    NOT NULL DEFAULT '—',
    added_at      TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS transformer_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        INTEGER NOT NULL REFERENCES transformer_jobs(id) ON DELETE CASCADE,
    filename      TEXT    NOT NULL,
    original_name TEXT    NOT NULL,
    file_size     INTEGER NOT NULL DEFAULT 0,
    uploaded_by   TEXT    NOT NULL DEFAULT '—',
    uploaded_at   TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS trf_job_counter (
    year  INTEGER PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 1
  );
`);

// ── Add image and type columns to existing tables if missing ──────
// SQLite ALTER TABLE does not support IF NOT EXISTS,
// so try/catch silently skips if the column already exists
try { db.exec("ALTER TABLE materials ADD COLUMN image TEXT NOT NULL DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE materials ADD COLUMN type TEXT NOT NULL DEFAULT 'raw'"); } catch(e) {}
try { db.exec("ALTER TABLE motors    ADD COLUMN image TEXT NOT NULL DEFAULT ''"); } catch(e) {}
// Links transformer material usage back to a motor-inventory material for live stock deduction
try { db.exec('ALTER TABLE transformer_materials ADD COLUMN material_id INTEGER DEFAULT NULL'); } catch(e) {}
try { db.exec('ALTER TABLE stock_in ADD COLUMN payment_reminder_sent INTEGER NOT NULL DEFAULT 0'); } catch(e) {}

// Seed id counter on first run
if (!db.prepare("SELECT value FROM id_counter WHERE name='nextId'").get()) {
  db.prepare("INSERT INTO id_counter (name,value) VALUES ('nextId',1)").run();
}

// ════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════
const DEFAULT_AUTH = {
  admin:       { password:'admin123',  role:'admin',       label:'Admin'                 },
  store:       { password:'store123',  role:'store',       label:'Store Manager'         },
  production:  { password:'prod123',   role:'production',  label:'Production Supervisor' },
  viewer:      { password:'view123',   role:'viewer',      label:'Viewer'                },
  transformer: { password:'trf123',    role:'transformer', label:'Transformer Manager'   }
};

function loadAuth() {
  if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE,'utf8'));
  fs.writeFileSync(AUTH_FILE, JSON.stringify(DEFAULT_AUTH, null, 2));
  return DEFAULT_AUTH;
}

const DEFAULT_ALERT_CONFIG = {
  enabled: false,
  smtpUser: '',
  smtpPass: '',
  recipients: '',
  lastImmediate: '',
  lastDaily: '',
  lastImmediateHash: '',
  lastDailyKey: ''
};

const ALERT_TIMEZONE = 'Asia/Kolkata';
const ALERT_CHECK_INTERVAL_MS = 60 * 1000;
const ALERT_IMMEDIATE_COOLDOWN_MS = 60 * 60 * 1000;

function loadAlertConfig() {
  if (!fs.existsSync(ALERT_FILE)) {
    fs.writeFileSync(ALERT_FILE, JSON.stringify(DEFAULT_ALERT_CONFIG, null, 2));
    return { ...DEFAULT_ALERT_CONFIG };
  }

  try {
    const saved = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8'));
    return { ...DEFAULT_ALERT_CONFIG, ...saved };
  } catch (err) {
    console.error('Alert config read error:', err.message);
    return { ...DEFAULT_ALERT_CONFIG };
  }
}

function saveAlertConfigFile(config) {
  const next = { ...DEFAULT_ALERT_CONFIG, ...config };
  fs.writeFileSync(ALERT_FILE, JSON.stringify(next, null, 2));
  return next;
}

function parseRecipients(value = '') {
  return [...new Set(
    String(value)
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
  )];
}

function validateAlertConfig(config, { forTest = false } = {}) {
  const recipients = parseRecipients(config.recipients);
  const needsMailSettings = Boolean(config.enabled || forTest);

  if (!needsMailSettings) return null;
  if (!config.smtpUser) return 'Gmail address is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.smtpUser)) return 'Enter a valid Gmail address';
  if (!/gmail\.com$/i.test(config.smtpUser)) return 'Use a Gmail address as the sender';
  if (!config.smtpPass) return 'Gmail App Password is required';
  if (config.smtpPass.replace(/\s+/g, '').length !== 16) return 'App Password must be 16 characters (spaces are okay)';
  if (!recipients.length) return 'Enter at least one recipient email address';

  return null;
}

function createAlertTransport(config) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass.replace(/\s+/g, '')
    }
  });
}

function getAlertErrorMessage(err) {
  if (!err) return 'Unknown email error';
  if (err.code === 'EAUTH') {
    return 'Gmail rejected the login. Recheck the Gmail address and 16-character App Password.';
  }
  if (['ESOCKET', 'ETIMEDOUT', 'ECONNECTION', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code)) {
    return 'Could not reach Gmail SMTP. Check internet access or firewall rules for smtp.gmail.com.';
  }

  const raw = String(err.response || err.message || err);
  return raw.length > 220 ? raw.slice(0, 217) + '...' : raw;
}

function getAlertNowInfo(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ALERT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value || '';

  return {
    iso: date.toISOString(),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour') || 0),
    minute: Number(get('minute') || 0),
    display: new Intl.DateTimeFormat('en-IN', {
      timeZone: ALERT_TIMEZONE,
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date)
  };
}

function getLowStockMaterials() {
  return db.prepare(`
    SELECT id, name, unit, qty, min_qty AS min, category
    FROM materials
    WHERE min_qty > 0 AND qty <= min_qty
    ORDER BY
      CASE WHEN qty = 0 THEN 0 ELSE 1 END,
      (qty - min_qty),
      name COLLATE NOCASE
  `).all().map(m => ({
    ...m,
    status: m.qty === 0 ? 'OUT OF STOCK' : 'LOW'
  }));
}

function getLowStockSnapshotHash(materials) {
  const snapshot = materials.map(m => ({
    id: m.id,
    qty: Number(m.qty),
    min: Number(m.min),
    status: m.status
  }));
  return crypto.createHash('sha1').update(JSON.stringify(snapshot)).digest('hex');
}

function formatLowStockLines(materials) {
  if (!materials.length) return ['All materials are above their minimum threshold.'];
  return materials.map((m, index) =>
    `${index + 1}. ${m.name} — ${m.qty} ${m.unit} in stock, minimum ${m.min} ${m.unit} (${m.status})`
  );
}

function getDuePaymentStockInEntries() {
  return db.prepare(`
    SELECT si.id, si.material_id AS materialId, si.material_name AS materialName,
           si.qty_received AS qtyReceived, si.invoice_no AS invoiceNo,
           si.received_date AS receivedDate, m.unit, m.type
    FROM stock_in si
    LEFT JOIN materials m ON m.id = si.material_id
    WHERE si.payment_reminder_sent = 0
      AND date(si.received_date) <= date('now','-45 days')
      AND (m.type = 'raw' OR m.type IS NULL)
    ORDER BY si.received_date
  `).all();
}

function formatPaymentReminderLines(entries) {
  if (!entries.length) return ['No raw material stock-in entries are due for payment reminder.'];
  return entries.map((entry, index) => {
    const invoiceText = entry.invoiceNo ? ` · Invoice: ${entry.invoiceNo}` : '';
    return `${index + 1}. ${entry.materialName} — ${entry.qtyReceived} ${entry.unit || ''}${invoiceText} · Received: ${entry.receivedDate}`;
  });
}

async function sendConfiguredEmail(config, subject, lines) {
  const transporter = createAlertTransport(config);
  const recipients = parseRecipients(config.recipients);
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);

  await transporter.sendMail({
    from: `"MotorStock Alerts" <${config.smtpUser}>`,
    to: recipients.join(', '),
    subject,
    text
  });
}

function insertSystemLog(message) {
  try {
    db.prepare('INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)').run(
      new Date().toLocaleString('en-IN'),
      'add',
      message,
      'System'
    );
  } catch (err) {
    console.error('Alert activity log error:', err.message);
  }
}

let alertCheckRunning = false;
let alertCheckQueued = false;

async function runAlertChecks(reason = 'scheduled') {
  const config = loadAlertConfig();
  const validationError = validateAlertConfig(config);
  if (!config.enabled || validationError) return;

  const nowInfo = getAlertNowInfo();
  const lowStock = getLowStockMaterials();
  const duePayments = getDuePaymentStockInEntries();
  let updated = false;
  let dailySent = false;

  if (!lowStock.length && config.lastImmediateHash) {
    config.lastImmediateHash = '';
    updated = true;
  }

  if (duePayments.length) {
    const subject = `[MotorStock] Supplier payment reminder - ${duePayments.length} raw stock-in entry(ies) due`;
    const lines = [
      'MotorStock supplier payment reminder',
      `Time: ${nowInfo.display} (${ALERT_TIMEZONE})`,
      '',
      'The following raw material entries were received 45 or more days ago and are due for payment:',
      '',
      ...formatPaymentReminderLines(duePayments)
    ];

    try {
      await sendConfiguredEmail(config, subject, lines);
      const mark = db.prepare('UPDATE stock_in SET payment_reminder_sent = 1 WHERE id = ?');
      duePayments.forEach(entry => mark.run(entry.id));
      updated = true;
      insertSystemLog(`Payment reminder email sent (${duePayments.length} raw stock-in entry(ies))`);
    } catch (err) {
      console.error(`Payment reminder email failed [${reason}]:`, getAlertErrorMessage(err));
    }
  }

  const dailyDue = nowInfo.hour >= 8 && config.lastDailyKey !== nowInfo.dateKey;
  if (dailyDue) {
    const outCount = lowStock.filter(m => m.status === 'OUT OF STOCK').length;
    const subject = lowStock.length
      ? `[MotorStock] Daily low-stock summary - ${lowStock.length} item(s) need attention`
      : '[MotorStock] Daily stock summary - all materials above threshold';

    const lines = [
      'MotorStock daily summary',
      `Time: ${nowInfo.display} (${ALERT_TIMEZONE})`,
      '',
      `Low / out-of-stock items: ${lowStock.length}`,
      `Out of stock: ${outCount}`,
      ''
    ];

    lines.push(...formatLowStockLines(lowStock));

    try {
      await sendConfiguredEmail(config, subject, lines);
      config.lastDaily = nowInfo.iso;
      config.lastDailyKey = nowInfo.dateKey;
      updated = true;
      dailySent = true;
      insertSystemLog(`Daily stock summary email sent (${lowStock.length} item(s) need attention)`);
    } catch (err) {
      console.error(`Daily alert email failed [${reason}]:`, getAlertErrorMessage(err));
    }
  }

  if (lowStock.length && !dailySent) {
    const lowHash = getLowStockSnapshotHash(lowStock);
    const lastImmediateMs = config.lastImmediate ? Date.parse(config.lastImmediate) : 0;
    const cooldownPassed = !lastImmediateMs || (Date.now() - lastImmediateMs) >= ALERT_IMMEDIATE_COOLDOWN_MS;
    const changedSinceLastAlert = lowHash !== config.lastImmediateHash;

    if (changedSinceLastAlert && cooldownPassed) {
      const outCount = lowStock.filter(m => m.status === 'OUT OF STOCK').length;
      const subject = `[MotorStock] Low stock alert - ${lowStock.length} item(s) need attention`;
      const lines = [
        'MotorStock immediate low-stock alert',
        `Time: ${nowInfo.display} (${ALERT_TIMEZONE})`,
        '',
        `${lowStock.length} item(s) are now at or below their minimum threshold.`,
        `Out of stock: ${outCount}`,
        ''
      ];

      lines.push(...formatLowStockLines(lowStock));

      try {
        await sendConfiguredEmail(config, subject, lines);
        config.lastImmediate = nowInfo.iso;
        config.lastImmediateHash = lowHash;
        updated = true;
        insertSystemLog(`Immediate low-stock email sent (${lowStock.length} item(s) need attention)`);
      } catch (err) {
        console.error(`Immediate alert email failed [${reason}]:`, getAlertErrorMessage(err));
      }
    }
  }

  if (updated) {
    saveAlertConfigFile(config);
  }
}

function queueAlertCheck(reason = 'scheduled') {
  if (alertCheckRunning) {
    alertCheckQueued = true;
    return;
  }

  alertCheckRunning = true;
  Promise.resolve()
    .then(() => runAlertChecks(reason))
    .catch(err => {
      console.error(`Alert check failed [${reason}]:`, err);
    })
    .finally(() => {
      alertCheckRunning = false;
      if (alertCheckQueued) {
        alertCheckQueued = false;
        queueAlertCheck('queued');
      }
    });
}

// ════════════════════════════════════════════════════
// SESSIONS (in-memory, 8 hour TTL)
// ════════════════════════════════════════════════════
const sessions = {};
const SESSION_TTL = 8 * 60 * 60 * 1000;

function createSession(role, label) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { role, label, createdAt: Date.now() };
  return token;
}

function getSession(token) {
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) { delete sessions[token]; return null; }
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const t in sessions) if (now - sessions[t].createdAt > SESSION_TTL) delete sessions[t];
}, 60 * 60 * 1000);

function requireAuth(roles) {
  return (req, res, next) => {
    const s = getSession(req.headers['x-session-token']);
    if (!s) return res.status(401).json({ error: 'Not logged in' });
    if (roles && !roles.includes(s.role)) return res.status(403).json({ error: 'Access denied' });
    req.session = s;
    next();
  };
}

// ════════════════════════════════════════════════════
// IMAGE UPLOAD ROUTES
// ════════════════════════════════════════════════════

// POST /api/upload?type=material  or  ?type=motor
// Returns: { url: '/uploads/mat_abc123.jpg' }
app.post('/api/upload',
  requireAuth(['admin', 'store']),
  upload.single('image'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ url: `/uploads/${req.file.filename}` });
  }
);

// DELETE /api/upload/:filename
// Deletes the file from disk when a material/motor is removed
app.delete('/api/upload/:filename', requireAuth(['admin', 'store']), (req, res) => {
  const filename = req.params.filename;
  // Block path traversal — only simple filenames allowed
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename))
    return res.status(400).json({ error: 'Invalid filename' });
  const filePath = path.join(UPLOADS_DIR, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════
// LOGIN ROUTES
// ════════════════════════════════════════════════════
app.post('/api/login', (req, res) => {
  const { role, password } = req.body;
  const auth  = loadAuth();
  const entry = auth[role];
  if (!entry || entry.password !== password)
    return res.status(401).json({ error: 'Incorrect role or password' });
  const token = createSession(entry.role, entry.label);
  res.json({ token, role: entry.role, label: entry.label });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) delete sessions[token];
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  const s = getSession(req.headers['x-session-token']);
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  res.json({ role: s.role, label: s.label });
});

app.post('/api/change-password', requireAuth(['admin']), (req, res) => {
  const { role, newPassword } = req.body;
  if (!role || !newPassword || newPassword.length < 5)
    return res.status(400).json({ error: 'Password must be at least 5 characters' });
  const auth = loadAuth();
  if (!auth[role]) return res.status(404).json({ error: 'Role not found' });
  auth[role].password = newPassword;
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
  res.json({ success: true });
});

// ════════════════════════════════════════════════════
// DATA — READ  (image column added)
// ════════════════════════════════════════════════════
app.get('/api/data', requireAuth(null), (req, res) => {
  try {
    const materials = db.prepare(
      'SELECT id, name, unit, qty, min_qty AS min, category, type, image FROM materials ORDER BY id'
    ).all();

    const motors = db.prepare(
      'SELECT id, name, power, frame, image FROM motors ORDER BY id'
    ).all();

    const bomRows = db.prepare(
      'SELECT motor_id, material_id AS materialId, qty_per AS qtyPer FROM bom'
    ).all();

    // Attach BOM array to each motor
    motors.forEach(m => {
      m.bom = bomRows
        .filter(b => b.motor_id === m.id)
        .map(b => ({ materialId: b.materialId, qtyPer: b.qtyPer }));
    });

    const productions = db.prepare(
      `SELECT id, motor_id AS motorId, motor_name AS motorName,
              qty, prod_date AS date, timestamp, logged_by AS loggedBy
       FROM productions ORDER BY id`
    ).all();

    const logRows = db.prepare(
      'SELECT ts, type, msg, by FROM activity_log ORDER BY id DESC LIMIT 200'
    ).all();

    const counter = db.prepare("SELECT value FROM id_counter WHERE name='nextId'").get();

    res.json({
      materials,
      motors,
      productions,
      log: logRows,
      nextId: counter ? counter.value : 1
    });

  } catch (err) {
    console.error('GET /api/data error:', err.message);
    res.status(500).json({ error: 'Database read failed' });
  }
});

// ════════════════════════════════════════════════════
// MATERIAL PROCESSING ROUTES

app.get('/api/process-bom', requireAuth(null), (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT output_material_id AS outputMaterialId,
              input_material_id AS inputMaterialId,
              qty_required AS qtyRequired
       FROM material_process_bom
       ORDER BY output_material_id, id`
    ).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/process-bom', requireAuth(['admin','production']), (req, res) => {
  const { outputMaterialId, inputs } = req.body;
  const outputId = parseInt(outputMaterialId);
  if (!outputId || !Array.isArray(inputs) || !inputs.length) {
    return res.status(400).json({ error: 'Output material and at least one input material are required' });
  }

  const outputMat = db.prepare('SELECT id, type FROM materials WHERE id = ?').get(outputId);
  if (!outputMat) return res.status(404).json({ error: 'Output material not found' });
  if (outputMat.type !== 'processed') return res.status(400).json({ error: 'Output material must be processed type' });

  const validInputs = inputs.map(item => ({
    materialId: parseInt(item.materialId),
    qtyRequired: parseFloat(item.qtyRequired)
  })).filter(item => item.materialId && item.qtyRequired > 0);

  if (!validInputs.length) {
    return res.status(400).json({ error: 'At least one valid input material is required' });
  }

  const invalidInput = validInputs.find(item => !db.prepare('SELECT id, type FROM materials WHERE id = ?').get(item.materialId));
  if (invalidInput) {
    return res.status(404).json({ error: 'One or more input materials were not found' });
  }
  const invalidType = validInputs.find(item => {
    const mat = db.prepare('SELECT type FROM materials WHERE id = ?').get(item.materialId);
    return mat && mat.type !== 'raw';
  });
  if (invalidType) {
    return res.status(400).json({ error: 'Input materials must be raw type' });
  }

  const saveBom = db.transaction(() => {
    db.prepare('DELETE FROM material_process_bom WHERE output_material_id = ?').run(outputId);
    const ins = db.prepare('INSERT INTO material_process_bom (output_material_id, input_material_id, qty_required) VALUES (?,?,?)');
    for (const item of validInputs) {
      ins.run(outputId, item.materialId, item.qtyRequired);
    }
  });

  try {
    saveBom();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/process-run', requireAuth(['admin','production']), (req, res) => {
  const outputId = parseInt(req.body.outputMaterialId);
  const qty      = parseFloat(req.body.qty);
  if (!outputId || !qty || qty <= 0) {
    return res.status(400).json({ error: 'Valid output material and quantity are required' });
  }

  const bom = db.prepare(
    'SELECT input_material_id AS materialId, qty_required AS qtyRequired FROM material_process_bom WHERE output_material_id = ?'
  ).all(outputId);

  if (!bom.length) {
    return res.status(400).json({ error: 'Process BOM not defined for this output material' });
  }

  const outputMat = db.prepare('SELECT id, name, qty, type FROM materials WHERE id = ?').get(outputId);
  if (!outputMat) return res.status(404).json({ error: 'Output material not found' });
  if (outputMat.type !== 'processed') return res.status(400).json({ error: 'Output material must be processed type' });

  const requirements = bom.map(item => ({
    materialId: item.materialId,
    qtyRequired: item.qtyRequired * qty
  }));

  for (const item of requirements) {
    const inv = db.prepare('SELECT id, name, qty FROM materials WHERE id = ?').get(item.materialId);
    if (!inv) return res.status(404).json({ error: 'Input material not found' });
    if (inv.qty < item.qtyRequired) {
      return res.status(400).json({ error: `Insufficient stock for ${inv.name}` });
    }
  }

  const who = req.session.label;
  const now = new Date().toLocaleString('en-IN');

  const runProcess = db.transaction(() => {
    const updInput = db.prepare('UPDATE materials SET qty = qty - ? WHERE id = ?');
    for (const item of requirements) {
      updInput.run(item.qtyRequired, item.materialId);
    }
    db.prepare('UPDATE materials SET qty = qty + ? WHERE id = ?').run(qty, outputId);
    db.prepare(
      'INSERT INTO material_processing_log (output_material_id, qty_produced, timestamp, processed_by) VALUES (?,?,?,?)'
    ).run(outputId, qty, now, who);
    db.prepare('INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)').run(
      now,
      'produce',
      `Processed ${qty} qty of ${outputMat.name}`,
      who
    );
  });

  try {
    runProcess();
    const newQty = db.prepare('SELECT qty FROM materials WHERE id = ?').get(outputId).qty;
    queueAlertCheck('process-run');
    res.json({ success: true, newQty, outputMaterialId: outputId, outputMaterialName: outputMat.name, qtyProduced: qty, timestamp: now, processedBy: who });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/process-log', requireAuth(null), (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT mpl.id,
              mpl.output_material_id AS outputMaterialId,
              m.name AS outputMaterialName,
              mpl.qty_produced AS qtyProduced,
              mpl.timestamp,
              mpl.processed_by AS processedBy
       FROM material_processing_log mpl
       LEFT JOIN materials m ON m.id = mpl.output_material_id
       ORDER BY mpl.id DESC`
    ).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DATA — WRITE  (image column saved)
// ════════════════════════════════════════════════════
app.post('/api/data', requireAuth(['admin','store','production']), (req, res) => {
  const { materials=[], motors=[], productions=[], log=[], nextId } = req.body;

  const saveAll = db.transaction(() => {

    // ── Materials ──────────────────────────────────
    db.prepare('DELETE FROM materials').run();
    const insMat = db.prepare(
      'INSERT INTO materials (id,name,unit,qty,min_qty,category,type,image) VALUES (?,?,?,?,?,?,?,?)'
    );
    for (const m of materials) {
      insMat.run(m.id, m.name, m.unit, m.qty, m.min, m.category, m.type || 'raw', m.image||'');
    }

    // ── Motors + BOM ───────────────────────────────
    db.prepare('DELETE FROM bom').run();
    db.prepare('DELETE FROM motors').run();
    const insMot = db.prepare(
      'INSERT INTO motors (id,name,power,frame,image) VALUES (?,?,?,?,?)'
    );
    const insBom = db.prepare(
      'INSERT INTO bom (motor_id,material_id,qty_per) VALUES (?,?,?)'
    );
    for (const m of motors) {
      insMot.run(m.id, m.name, m.power||'', m.frame||'', m.image||'');
      for (const b of (m.bom||[])) {
        insBom.run(m.id, b.materialId, b.qtyPer);
      }
    }

    // ── Productions ────────────────────────────────
    db.prepare('DELETE FROM productions').run();
    const insProd = db.prepare(
      `INSERT INTO productions (id,motor_id,motor_name,qty,prod_date,timestamp,logged_by)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const p of productions) {
      insProd.run(p.id, p.motorId||null, p.motorName, p.qty, p.date, p.timestamp, p.loggedBy||'—');
    }

    // ── Activity Log ───────────────────────────────
    db.prepare('DELETE FROM activity_log').run();
    const insLog = db.prepare(
      'INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)'
    );
    for (const l of log) {
      insLog.run(l.ts, l.type, l.msg, l.by||'');
    }

    // ── ID Counter ─────────────────────────────────
    if (nextId) {
      db.prepare("UPDATE id_counter SET value=? WHERE name='nextId'").run(nextId);
    }
  });

  try {
    saveAll();
    queueAlertCheck('data-save');
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/data error:', err.message);
    res.status(500).json({ error: 'Save failed: ' + err.message });
  }
});

// ════════════════════════════════════════════════════
// STOCK-IN ROUTES
// ════════════════════════════════════════════════════

// GET all stock-in records, newest first
app.get('/api/stock-in', requireAuth(null), (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, material_id AS materialId, material_name AS materialName,
             qty_received AS qtyReceived, invoice_no AS invoiceNo,
             received_date AS receivedDate, timestamp, received_by AS receivedBy, notes
      FROM stock_in ORDER BY id DESC LIMIT 300
    `).all();
    res.json(rows);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// POST — record new stock received, increments material qty directly
app.post('/api/stock-in', requireAuth(['admin','store']), (req, res) => {
  const { materialId, qtyReceived, invoiceNo='', receivedDate, notes='' } = req.body;

  if (!materialId || !qtyReceived || qtyReceived <= 0 || !receivedDate)
    return res.status(400).json({ error: 'materialId, qtyReceived and receivedDate are required' });

  const mat = db.prepare('SELECT id, name, qty FROM materials WHERE id=?').get(materialId);
  if (!mat) return res.status(404).json({ error: 'Material not found' });

  const who = req.session.label;
  const now = new Date().toLocaleString('en-IN');

  const doStockIn = db.transaction(() => {
    // Increment the material qty
    db.prepare('UPDATE materials SET qty = qty + ? WHERE id = ?').run(qtyReceived, materialId);

    // Record the stock-in entry
    db.prepare(`
      INSERT INTO stock_in (material_id, material_name, qty_received, invoice_no, received_date, timestamp, received_by, notes)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(materialId, mat.name, qtyReceived, invoiceNo, receivedDate, now, who, notes);

    // Add to activity log
    db.prepare('INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)').run(
      now, 'restock',
      `Stock-In: ${mat.name} +${qtyReceived}${invoiceNo ? ' · Invoice: ' + invoiceNo : ''}`,
      who
    );
  });

  try {
    doStockIn();
    const newQty = db.prepare('SELECT qty FROM materials WHERE id=?').get(materialId).qty;
    queueAlertCheck('stock-in');
    res.json({ success: true, newQty });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE — cancel a stock-in entry (Admin only), reverses the qty
app.delete('/api/stock-in/:id', requireAuth(['admin']), (req, res) => {
  const id = parseInt(req.params.id);
  const entry = db.prepare('SELECT * FROM stock_in WHERE id=?').get(id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  const who = req.session.label;
  const now = new Date().toLocaleString('en-IN');

  const doCancel = db.transaction(() => {
    // Deduct qty back — floor at 0
    db.prepare('UPDATE materials SET qty = MAX(0, qty - ?) WHERE id = ?')
      .run(entry.qty_received, entry.material_id);

    db.prepare('DELETE FROM stock_in WHERE id=?').run(id);

    db.prepare('INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)').run(
      now, 'add',
      `Stock-In CANCELLED: ${entry.material_name} -${entry.qty_received}${entry.invoice_no ? ' · Invoice: ' + entry.invoice_no : ''}`,
      who
    );
  });

  try {
    doCancel();
    queueAlertCheck('stock-in-cancel');
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════
// MIGRATION — Import data.json into SQLite (one-time)
// ════════════════════════════════════════════════════
app.post('/api/migrate', requireAuth(['admin']), (req, res) => {
  const dataFile = path.join(__dirname, 'data.json');
  if (!fs.existsSync(dataFile))
    return res.status(404).json({ error: 'No data.json found in the folder' });

  try {
    const old = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const { materials=[], motors=[], productions=[], log=[], nextId } = old;

    const migrate = db.transaction(() => {
      db.prepare('DELETE FROM materials').run();
      const insMat = db.prepare('INSERT INTO materials (id,name,unit,qty,min_qty,category,image) VALUES (?,?,?,?,?,?,?)');
      for (const m of materials) insMat.run(m.id, m.name, m.unit, m.qty, m.min, m.category, m.image||'');

      db.prepare('DELETE FROM bom').run();
      db.prepare('DELETE FROM motors').run();
      const insMot = db.prepare('INSERT INTO motors (id,name,power,frame,image) VALUES (?,?,?,?,?)');
      const insBom = db.prepare('INSERT INTO bom (motor_id,material_id,qty_per) VALUES (?,?,?)');
      for (const m of motors) {
        insMot.run(m.id, m.name, m.power||'', m.frame||'', m.image||'');
        for (const b of (m.bom||[])) insBom.run(m.id, b.materialId, b.qtyPer);
      }

      db.prepare('DELETE FROM productions').run();
      const insProd = db.prepare('INSERT INTO productions (id,motor_id,motor_name,qty,prod_date,timestamp,logged_by) VALUES (?,?,?,?,?,?,?)');
      for (const p of productions) insProd.run(p.id, p.motorId||null, p.motorName, p.qty, p.date, p.timestamp, p.loggedBy||'—');

      db.prepare('DELETE FROM activity_log').run();
      const insLog = db.prepare('INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)');
      for (const l of log) insLog.run(l.ts, l.type, l.msg, l.by||'');

      if (nextId) db.prepare("UPDATE id_counter SET value=? WHERE name='nextId'").run(nextId);
    });

    migrate();
    fs.renameSync(dataFile, path.join(__dirname, 'data.json.bak'));
    queueAlertCheck('migrate');

    res.json({
      success: true,
      message: `Migrated ${materials.length} materials, ${motors.length} motors, ${productions.length} production runs. data.json renamed to data.json.bak`
    });

  } catch (err) {
    console.error('Migration error:', err.message);
    res.status(500).json({ error: 'Migration failed: ' + err.message });
  }
});

// ════════════════════════════════════════════════════
// TRANSFORMER MODULE ROUTES
// ════════════════════════════════════════════════════

// ── Job number generator — TRF-2026-001 format ───────────────────
function nextJobNo() {
  const year = new Date().getFullYear();
  let row = db.prepare('SELECT value FROM trf_job_counter WHERE year=?').get(year);
  if (!row) {
    db.prepare('INSERT INTO trf_job_counter (year, value) VALUES (?,1)').run(year);
    row = { value: 1 };
  } else {
    db.prepare('UPDATE trf_job_counter SET value=value+1 WHERE year=?').run(year);
    row = db.prepare('SELECT value FROM trf_job_counter WHERE year=?').get(year);
  }
  return `TRF-${year}-${String(row.value).padStart(3, '0')}`;
}

// GET /api/transformer/jobs — list all jobs, newest first
app.get('/api/transformer/jobs', requireAuth(['admin','transformer','viewer']), (req, res) => {
  try {
    const jobs = db.prepare(`
      SELECT id, job_no, customer_name, customer_contact, kva_rating,
             received_date, expected_date, status, labour_charge,
             payment_status, created_by, created_at, updated_at
      FROM transformer_jobs ORDER BY id DESC
    `).all();
    res.json(jobs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/transformer/jobs/:id — single job with materials and files
app.get('/api/transformer/jobs/:id', requireAuth(['admin','transformer','viewer']), (req, res) => {
  try {
    const job = db.prepare('SELECT * FROM transformer_jobs WHERE id=?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.materials = db.prepare('SELECT * FROM transformer_materials WHERE job_id=? ORDER BY id').all(job.id);
    job.files     = db.prepare('SELECT * FROM transformer_files WHERE job_id=? ORDER BY id').all(job.id);
    res.json(job);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/transformer/jobs — create new job
app.post('/api/transformer/jobs', requireAuth(['admin','transformer']), (req, res) => {
  const {
    customer_name, customer_contact='', kva_rating='',
    received_date, expected_date='', fault_description='', repair_work=''
  } = req.body;
  if (!customer_name || !received_date)
    return res.status(400).json({ error: 'customer_name and received_date are required' });
  try {
    const job_no = nextJobNo();
    const now    = new Date().toLocaleString('en-IN');
    const result = db.prepare(`
      INSERT INTO transformer_jobs
        (job_no, customer_name, customer_contact, kva_rating, received_date,
         expected_date, fault_description, repair_work, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,'Received',?,?,?)
    `).run(job_no, customer_name, customer_contact, kva_rating, received_date,
           expected_date, fault_description, repair_work, req.session.label, now, now);
    db.prepare('INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)').run(
      now, 'add', `New transformer job: ${job_no} — ${customer_name} (${kva_rating} KVA)`, req.session.label
    );
    res.json({ success: true, id: result.lastInsertRowid, job_no });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/transformer/jobs/:id — update job details/status
app.patch('/api/transformer/jobs/:id', requireAuth(['admin','transformer']), (req, res) => {
  const id  = parseInt(req.params.id);
  const job = db.prepare('SELECT * FROM transformer_jobs WHERE id=?').get(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const {
    customer_name    = job.customer_name,
    customer_contact = job.customer_contact,
    kva_rating       = job.kva_rating,
    received_date    = job.received_date,
    expected_date    = job.expected_date,
    fault_description = job.fault_description,
    repair_work      = job.repair_work,
    status           = job.status,
    labour_charge    = job.labour_charge,
    payment_status   = job.payment_status,
  } = req.body;
  const now = new Date().toLocaleString('en-IN');
  try {
    db.prepare(`
      UPDATE transformer_jobs SET
        customer_name=?, customer_contact=?, kva_rating=?,
        received_date=?, expected_date=?, fault_description=?,
        repair_work=?, status=?, labour_charge=?, payment_status=?, updated_at=?
      WHERE id=?
    `).run(customer_name, customer_contact, kva_rating, received_date,
           expected_date, fault_description, repair_work, status,
           labour_charge, payment_status, now, id);
    if (req.body.status && req.body.status !== job.status) {
      db.prepare('INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)').run(
        now, 'add', `Job ${job.job_no}: status changed ${job.status} → ${status}`, req.session.label
      );
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/transformer/jobs/:id — delete job (admin only)
app.delete('/api/transformer/jobs/:id', requireAuth(['admin']), (req, res) => {
  const id  = parseInt(req.params.id);
  const job = db.prepare('SELECT * FROM transformer_jobs WHERE id=?').get(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  try {
    // Delete associated files from disk
    const files = db.prepare('SELECT filename FROM transformer_files WHERE job_id=?').all(id);
    for (const f of files) {
      const fp = path.join(TRF_FILES_DIR, f.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    db.prepare('DELETE FROM transformer_jobs WHERE id=?').run(id);
    const now = new Date().toLocaleString('en-IN');
    db.prepare('INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)').run(
      now, 'add', `Deleted transformer job: ${job.job_no} — ${job.customer_name}`, req.session.label
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Materials per job ─────────────────────────────────────────────

// POST /api/transformer/jobs/:id/materials — add material to a job
// If material_id is provided the qty is deducted from the motor-inventory in real-time.
app.post('/api/transformer/jobs/:id/materials', requireAuth(['admin','transformer']), (req, res) => {
  const job_id = parseInt(req.params.id);
  const { material_name, qty_used, unit='', cost_per_unit=0, material_id=null } = req.body;
  if (!material_name || !qty_used || qty_used <= 0)
    return res.status(400).json({ error: 'material_name and qty_used are required' });

  // Validate linked inventory material and check available stock
  let invMat = null;
  if (material_id) {
    invMat = db.prepare('SELECT id, name, qty, unit FROM materials WHERE id=?').get(material_id);
    if (!invMat) return res.status(404).json({ error: 'Linked inventory material not found' });
    if (invMat.qty < qty_used)
      return res.status(400).json({
        error: `Insufficient stock — only ${invMat.qty} ${invMat.unit} available for "${invMat.name}"`
      });
  }

  try {
    const now = new Date().toLocaleString('en-IN');
    const job = db.prepare('SELECT job_no FROM transformer_jobs WHERE id=?').get(job_id);

    const doInsert = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO transformer_materials
          (job_id, material_name, qty_used, unit, cost_per_unit, added_by, added_at, material_id)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(job_id, material_name, qty_used, unit, cost_per_unit, req.session.label, now, material_id || null);

      let newQty = null;
      if (invMat) {
        // Deduct from motor-inventory stock
        db.prepare('UPDATE materials SET qty = qty - ? WHERE id = ?').run(qty_used, material_id);
        newQty = db.prepare('SELECT qty FROM materials WHERE id=?').get(material_id).qty;
        db.prepare('INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)').run(
          now, 'restock',
          `Transformer job ${job?.job_no || job_id}: used ${qty_used} ${unit} of "${material_name}" — stock deducted`,
          req.session.label
        );
      }

      return { id: result.lastInsertRowid, newQty };
    });

    const { id, newQty } = doInsert();
    queueAlertCheck('trf-material-add');
    res.json({ success: true, id, newQty });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/transformer/materials/:id — remove a material entry and restore inventory qty if linked
app.delete('/api/transformer/materials/:id', requireAuth(['admin','transformer']), (req, res) => {
  const id  = parseInt(req.params.id);
  const row = db.prepare('SELECT * FROM transformer_materials WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Material entry not found' });

  try {
    const now = new Date().toLocaleString('en-IN');

    const doDelete = db.transaction(() => {
      db.prepare('DELETE FROM transformer_materials WHERE id=?').run(id);

      let newQty = null;
      if (row.material_id) {
        // Restore the qty back to motor-inventory
        db.prepare('UPDATE materials SET qty = qty + ? WHERE id = ?').run(row.qty_used, row.material_id);
        newQty = db.prepare('SELECT qty FROM materials WHERE id=?').get(row.material_id).qty;
        db.prepare('INSERT INTO activity_log (ts,type,msg,by) VALUES (?,?,?,?)').run(
          now, 'add',
          `Transformer material removed: "${row.material_name}" ${row.qty_used} ${row.unit} restored to inventory`,
          req.session.label
        );
      }
      return { newQty, material_id: row.material_id };
    });

    const result = doDelete();
    queueAlertCheck('trf-material-del');
    res.json({ success: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── File uploads ──────────────────────────────────────────────────

// POST /api/transformer/jobs/:id/files — upload test result file
app.post('/api/transformer/jobs/:id/files',
  requireAuth(['admin','transformer']),
  trfUpload.single('file'),
  (req, res) => {
    const job_id = parseInt(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    try {
      const now = new Date().toLocaleString('en-IN');
      const result = db.prepare(`
        INSERT INTO transformer_files (job_id, filename, original_name, file_size, uploaded_by, uploaded_at)
        VALUES (?,?,?,?,?,?)
      `).run(job_id, req.file.filename, req.file.originalname, req.file.size, req.session.label, now);
      res.json({
        success: true,
        id: result.lastInsertRowid,
        filename: req.file.filename,
        original_name: req.file.originalname,
        file_size: req.file.size,
        uploaded_by: req.session.label,
        uploaded_at: now
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

// GET /api/transformer/files/:filename — download a file
app.get('/api/transformer/files/:filename', requireAuth(['admin','transformer','viewer']), (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename))
    return res.status(400).json({ error: 'Invalid filename' });
  const filePath = path.join(TRF_FILES_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  // Get original name from DB for the download filename
  const row = db.prepare('SELECT original_name FROM transformer_files WHERE filename=?').get(filename);
  res.download(filePath, row ? row.original_name : filename);
});

// DELETE /api/transformer/files/:id — delete a file
app.delete('/api/transformer/files/:id', requireAuth(['admin','transformer']), (req, res) => {
  const id  = parseInt(req.params.id);
  const row = db.prepare('SELECT * FROM transformer_files WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'File not found' });
  const fp  = path.join(TRF_FILES_DIR, row.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM transformer_files WHERE id=?').run(id);
  res.json({ success: true });
});

// ─── LOCAL IP ────────────────────────────────────────────────────
app.get('/api/alert-config', requireAuth(['admin']), (req, res) => {
  res.json(loadAlertConfig());
});

app.post('/api/alert-config', requireAuth(['admin']), (req, res) => {
  try {
    const current = loadAlertConfig();
    const next = {
      ...current,
      enabled: !!req.body.enabled,
      smtpUser: String(req.body.smtpUser || '').trim(),
      smtpPass: String(req.body.smtpPass || ''),
      recipients: parseRecipients(req.body.recipients).join(', ')
    };

    const validationError = validateAlertConfig(next);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    saveAlertConfigFile(next);
    queueAlertCheck('alert-config-save');
    res.json({ success: true, config: next });
  } catch (err) {
    console.error('POST /api/alert-config error:', err.message);
    res.status(500).json({ error: 'Could not save alert settings' });
  }
});

app.post('/api/alert-config/test', requireAuth(['admin']), async (req, res) => {
  const config = loadAlertConfig();
  const validationError = validateAlertConfig(config, { forTest: true });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const recipients = parseRecipients(config.recipients);

  try {
    await sendConfiguredEmail(config, 'MotorStock test email', [
      'This is a test email from MotorStock alert settings.',
      '',
      `Sender: ${config.smtpUser}`,
      `Recipients: ${recipients.join(', ')}`,
      `Sent at: ${new Date().toLocaleString('en-IN')}`
    ]);

    res.json({ success: true, message: `Test email sent to ${recipients.join(', ')}` });
  } catch (err) {
    console.error('POST /api/alert-config/test error:', err);
    res.status(502).json({ error: getAlertErrorMessage(err) });
  }
});

setInterval(() => {
  queueAlertCheck('interval');
}, ALERT_CHECK_INTERVAL_MS);

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) return net.address;
  return 'YOUR-PC-IP';
}

// ─── START ───────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  queueAlertCheck('startup');
  console.log('');
  console.log('  ╔════════════════════════════════════════════╗');
  console.log('  ║   MOTORSTOCK — Server v4.0 (+ Transformer)  ║');
  console.log('  ╠════════════════════════════════════════════╣');
  console.log(`  ║  Local  : http://localhost:${PORT}             ║`);
  console.log(`  ║  Network: http://${getLocalIP()}:${PORT}         ║`);
  console.log('  ╠════════════════════════════════════════════╣');
  console.log('  ║  DB      : motorstock.db                   ║');
  console.log('  ║  Uploads : uploads/                        ║');
  console.log('  ║  Passwords: auth.json                      ║');
  console.log('  ╚════════════════════════════════════════════╝');
  console.log('');
});