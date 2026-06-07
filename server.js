const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dotenv = require('dotenv');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = Boolean(process.env.VERCEL);
const DEFAULT_OWNER_EMAIL = 'admin@easycred';
const DEFAULT_OWNER_PASSWORD_HASH = '$2a$10$vZa0KGBj3BVj7LCNAlFYv.vChbQabmXTdS6lf/sGDd9cFNjbMKA/6';
const LEGACY_DEFAULT_OWNER_EMAIL = 'admin@easycred.test';
const STATIC_ROOT = path.join(__dirname, 'public');
const DB_PATH = process.env.EASYCRED_DB_PATH
  || (IS_VERCEL ? path.join(os.tmpdir(), 'easycred-data.db') : path.join(__dirname, 'data.db'));
const RAW_DATABASE_URL = process.env.DATABASE_URL
  || process.env.POSTGRES_URL
  || process.env.POSTGRES_PRISMA_URL
  || process.env.DATABASE_URL_UNPOOLED
  || process.env.POSTGRES_URL_NON_POOLING;
const DATABASE_URL = RAW_DATABASE_URL ? normalizePostgresUrl(RAW_DATABASE_URL) : '';
const USE_POSTGRES = Boolean(DATABASE_URL);
const SQLJS_WASM = require.resolve('sql.js/dist/sql-wasm.wasm');
const DEFAULT_COMPANY_ICON = '/images/logo.svg';

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-company-id');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(STATIC_ROOT, {
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'index.html' || path.extname(filePath) === '.js') {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

let db;
let SQL;
let pgPool;
let initializationPromise;

app.use((req, res, next) => {
  if (!initializationPromise) return next();
  initializationPromise.then(() => next()).catch(next);
});

function normalizeJson(value) {
  if (value == null || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeCompanyIcon(icon) {
  if (typeof icon !== 'string') return DEFAULT_COMPANY_ICON;
  const trimmedIcon = icon.trim();
  return trimmedIcon || DEFAULT_COMPANY_ICON;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();

  const text = String(value);
  const sqliteUtc = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/);
  if (sqliteUtc) {
    return `${sqliteUtc[1]}T${sqliteUtc[2]}${sqliteUtc[3] || ''}Z`;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function normalizeUser(user) {
  if (!user) return user;
  return {
    ...user,
    createdAt: normalizeTimestamp(user.createdAt ?? user.created_at),
  };
}

function toPostgresSql(sql, params = []) {
  let paramIndex = 0;
  let text = sql.replace(/\?/g, () => `$${++paramIndex}`);
  text = text.replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ');
  return { text, params };
}

function normalizePostgresUrl(value) {
  const url = new URL(value);
  url.searchParams.delete('channel_binding');
  url.searchParams.delete('sslmode');
  return url.toString();
}

function postgresSslOptions() {
  if (process.env.PGSSLMODE === 'disable') return false;
  return { rejectUnauthorized: false };
}

async function retryAsync(fn, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function queryAll(sql, params = []) {
  if (USE_POSTGRES) {
    const prepared = toPostgresSql(sql, params);
    const result = await retryAsync(() => pgPool.query(prepared.text, prepared.params));
    return result.rows;
  }

  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

async function queryOne(sql, params = []) {
  return (await queryAll(sql, params))[0] || null;
}

async function run(sql, params = []) {
  if (USE_POSTGRES) {
    let preparedSql = sql;
    if (
      /^\s*INSERT\s+INTO\s+/i.test(sql)
      && !/\bINSERT\s+INTO\s+app_settings\b/i.test(sql)
      && !/\bRETURNING\b/i.test(sql)
    ) {
      preparedSql = `${sql} RETURNING id`;
    }
    const prepared = toPostgresSql(preparedSql, params);
    const result = await retryAsync(() => pgPool.query(prepared.text, prepared.params));
    const insertedId = result.rows?.[0]?.id;
    return insertedId == null ? undefined : Number(insertedId);
  }

  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  if (/^\s*INSERT\s+INTO\s+/i.test(sql)) {
    return db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  }
}

async function readPersistedDb() {
  return fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
}

async function persistDb() {
  if (USE_POSTGRES) return true;

  const data = Buffer.from(db.export());
  try {
    fs.writeFileSync(DB_PATH, data);
    return true;
  } catch (error) {
    console.error('Failed to persist DB:', error);
    return false;
  }
}

async function persistOrError(res) {
  if (await persistDb()) return true;
  res.status(500).json({ message: 'Não foi possível salvar os dados. Tente novamente.' });
  return false;
}

function toAbsolute(value, fee) {
  const amount = Number(value) || 0;
  if (!fee || fee.fee == null) return 0;
  const feeValue = Number(fee.fee) || 0;
  if (fee.unit === 'percentage') return +(amount * feeValue / 100).toFixed(2);
  return +feeValue.toFixed(2);
}

function roundCurrency(value) {
  return +Number(value || 0).toFixed(2);
}

function buildInstallmentData(value = 0) {
  return Array.from({ length: 18 }, (_, index) => ({
    installment: index + 1,
    value,
    unit: 'percentage',
  }));
}

function calculateSimulation(amount, numInstallments, type, creditCardFeeConfig, installmentFeeConfig) {
  const parsedAmount = Number(amount) || 0;
  const parsedInstallments = Number(numInstallments) || 1;
  const simulationType = type || 'unleashed';
  const installmentFee = toAbsolute(parsedAmount, installmentFeeConfig || {});
  let creditCardFee;
  let total;

  if (simulationType === 'limit') {
    creditCardFee = toAbsolute(parsedAmount, creditCardFeeConfig || {});
    total = Math.max(0, parsedAmount - creditCardFee - installmentFee);
  } else if (creditCardFeeConfig?.unit === 'percentage') {
    const rate = (Number(creditCardFeeConfig.fee) || 0) / 100;
    total = rate >= 1 ? parsedAmount + installmentFee : (parsedAmount + installmentFee) / (1 - rate);
    creditCardFee = total * rate;
  } else {
    creditCardFee = toAbsolute(parsedAmount, creditCardFeeConfig || {});
    total = parsedAmount + installmentFee + creditCardFee;
  }

  total = Math.round(roundCurrency(total));
  creditCardFee = roundCurrency(creditCardFee);
  const grossProfit = roundCurrency(
    simulationType === 'limit' ? parsedAmount - total : total - parsedAmount
  );

  return {
    amount: parsedAmount,
    numInstallments: parsedInstallments,
    type: simulationType,
    total,
    installmentValue: roundCurrency(
      (simulationType === 'limit' ? parsedAmount : total) / parsedInstallments
    ),
    profit: roundCurrency(installmentFee),
    grossProfit,
    creditCardAbsoluteFeeValue: creditCardFee,
  };
}

function createAccessToken(user) {
  const secret = process.env.JWT_SECRET || 'devsecret';
  const expiresIn = process.env.JWT_ACCESS_EXPIRES_IN;
  const options = expiresIn ? { expiresIn } : {};
  return jwt.sign({ userId: user.id, role: user.role, email: user.email }, secret, options);
}

function createRefreshToken(user) {
  const secret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'devsecret';
  return jwt.sign({ userId: user.id, type: 'refresh' }, secret, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '10y',
  });
}

function verifySignedRefreshToken(token) {
  const secret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'devsecret';
  const payload = jwt.verify(token, secret);
  if (payload.type !== 'refresh' || !payload.userId) {
    throw new Error('Invalid refresh token');
  }
  return payload;
}

async function ensureCompanyMembership(userId, companyId) {
  const row = await queryOne('SELECT 1 FROM company_users WHERE user_id = ? AND company_id = ?', [userId, companyId]);
  return !!row;
}

async function enrichCreditCard(card) {
  const fees = normalizeJson(card.fees) || [];
  if (card.company_id == null) {
    return { ...card, fees };
  }

  const configuredInstallments = await getConfiguredInstallmentNumbers(card.company_id);
  const feesByInstallment = new Map(fees.map(fee => [
    Number(fee.installment),
    { ...fee, value: Number(fee.value) || 0 },
  ]));

  return {
    ...card,
    fees: configuredInstallments.map(installment => (
      feesByInstallment.get(installment) || { installment, value: 0, unit: 'percentage' }
    )),
  };
}

async function getConfiguredInstallmentNumbers(companyId) {
  const installments = await queryAll(
    'SELECT name,data FROM installments WHERE company_id = ? ORDER BY id',
    [companyId]
  );
  const numbers = new Set();

  installments.forEach(installment => {
    const data = normalizeJson(installment.data) || [];
    const namedInstallment = /^(\d+)x$/i.exec(String(installment.name).trim());

    data.forEach(item => {
      const number = namedInstallment && data.length === 1
        ? Number(namedInstallment[1])
        : Number(item.installment);
      if (number) numbers.add(number);
    });
  });

  return [...numbers].sort((a, b) => a - b);
}

async function findInstallmentForNumber(companyId, preferredInstallmentId, numInstallments) {
  const installmentNumber = Number(numInstallments);
  const installments = await queryAll(
    'SELECT id,data FROM installments WHERE company_id = ? ORDER BY id',
    [companyId]
  );
  const preferred = installments.find(item => Number(item.id) === Number(preferredInstallmentId));
  const orderedInstallments = preferred
    ? [preferred, ...installments.filter(item => item.id !== preferred.id)]
    : installments;

  for (const installment of orderedInstallments) {
    const fee = (normalizeJson(installment.data) || []).find(
      item => Number(item.installment) === installmentNumber
    );
    if (fee) return { installmentId: Number(installment.id), fee };
  }

  return { installmentId: Number(preferredInstallmentId) || null, fee: null };
}

async function resolveSimulationFees(companyId, creditCardId, installmentId, numInstallments) {
  const installmentNumber = Number(numInstallments);
  const numericCreditCardId = Number(creditCardId);
  const card = Number.isFinite(numericCreditCardId)
    ? await queryOne(
      'SELECT fees FROM credit_cards WHERE id = ? AND company_id = ?',
      [numericCreditCardId, companyId]
    )
    : null;
  const installment = await findInstallmentForNumber(companyId, installmentId, installmentNumber);
  const cardFee = (normalizeJson(card?.fees) || []).find(
    fee => Number(fee.installment) === installmentNumber
  );

  return {
    installmentId: installment.installmentId,
    creditCardFee: {
      fee: Number(cardFee?.value) || 0,
      unit: cardFee?.unit || 'percentage',
    },
    installmentFee: {
      fee: Number(installment.fee?.value) || 0,
      unit: installment.fee?.unit || 'percentage',
    },
  };
}

async function buildFallbackInstallment(machine) {
  if (machine.company_id == null) return null;

  const installments = await queryAll(
    'SELECT id,company_id,name,data FROM installments WHERE company_id = ? ORDER BY id',
    [machine.company_id]
  );
  const dataByInstallment = new Map();

  installments.forEach(installment => {
    const data = normalizeJson(installment.data) || [];
    const namedInstallment = /^(\d+)x$/i.exec(String(installment.name).trim());

    data.forEach(item => {
      const number = namedInstallment && data.length === 1
        ? Number(namedInstallment[1])
        : Number(item.installment);

      if (number && !dataByInstallment.has(number)) {
        dataByInstallment.set(number, { ...item, installment: number });
      }
    });
  });

  const data = [...dataByInstallment.values()].sort((a, b) => a.installment - b.installment);
  if (data.length === 0 || installments.length === 0) return null;

  return {
    ...installments[0],
    name: 'Parcelamento automático',
    data,
  };
}

async function enrichMachine(machine) {
  const linkedInstallment = machine.installment_id != null
    ? await queryOne('SELECT id,name,data FROM installments WHERE id = ?', [machine.installment_id])
    : null;
  const installment = linkedInstallment || await buildFallbackInstallment(machine);

  return {
    ...machine,
    installmentId: installment ? Number(installment.id) : null,
    installment: installment ? [enrichInstallment(installment)] : [],
    employees: normalizeJson(machine.employees) || [],
  };
}

function enrichInstallment(installment) {
  return {
    ...installment,
    data: normalizeJson(installment.data) || [],
  };
}

function normalizeInstallmentData(data) {
  return (Array.isArray(data) ? data : []).map(item => ({
    installment: Number(item.installment) || 1,
    value: Number(item.value) || 0,
    unit: item.unit || 'percentage',
  }));
}

async function enrichSale(row) {
  const sale = {
    ...row,
    appliedCreditCardFee: normalizeJson(row.applied_credit_card_fee) || null,
    appliedInstallmentFee: normalizeJson(row.applied_installment_fee) || null,
  };

  const [machine, creditCard, installment, seller] = await Promise.all([
    queryOne('SELECT id,company_id,name,icon,installment_id,employees FROM machines WHERE id = ?', [sale.machine_id]),
    queryOne('SELECT id,company_id,name,icon,fees FROM credit_cards WHERE id = ?', [sale.credit_card_id]),
    queryOne('SELECT id,company_id,name,data FROM installments WHERE id = ?', [sale.installment_id]),
    queryOne('SELECT id,name,email,role FROM users WHERE id = ?', [sale.seller_id]),
  ]);

  return {
    ...sale,
    machine: machine ? [await enrichMachine(machine)] : [],
    creditCard: creditCard ? [await enrichCreditCard(creditCard)] : [],
    installment: installment ? [enrichInstallment(installment)] : [],
    seller: seller ? [seller] : [],
  };
}

function buildSaleFilters(query) {
  const filters = [];
  const params = [];

  if (query.startDate) {
    filters.push('created_at >= ?');
    params.push(query.startDate);
  }
  if (query.endDate) {
    filters.push('created_at <= ?');
    params.push(query.endDate);
  }

  const listParam = (value, column) => {
    if (!value) return;
    const ids = String(value).split(',').map(id => id.trim()).filter(Boolean);
    if (ids.length === 0) return;
    filters.push(`${column} IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  };

  listParam(query.machinesIds, 'machine_id');
  listParam(query.sellerIds, 'seller_id');
  listParam(query.creditCardIds, 'credit_card_id');
  listParam(query.installmentIds, 'installment_id');

  if (query.type && query.type !== 'all') {
    filters.push('type = ?');
    params.push(query.type);
  }

  return { filters, params };
}

async function getSales(companyId, query = {}) {
  const { filters, params } = buildSaleFilters(query);
  filters.unshift('company_id = ?');
  params.unshift(companyId);
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sales = await queryAll(`SELECT * FROM sales ${whereClause} ORDER BY created_at DESC`, params);
  return Promise.all(sales.map(enrichSale));
}

function groupSalesByPeriod(sales, period) {
  const groups = {};

  for (const sale of sales) {
    const createdAt = new Date(sale.created_at);
    const key = period === 'monthly'
      ? `${createdAt.getFullYear()}-${createdAt.getMonth() + 1}`
      : period === 'weekly'
        ? `${createdAt.getFullYear()}-${getWeekNumber(createdAt)}`
        : `${createdAt.getFullYear()}-${createdAt.getMonth() + 1}-${createdAt.getDate()}`;

    const row = groups[key] || { total: 0, count: 0, profit: 0, grossProfit: 0, _id: {} };
    row.total += Number(sale.total || 0);
    row.count += 1;
    row.profit += Number(sale.profit || 0);
    row.grossProfit += Number(sale.gross_profit || 0);
    row._id = period === 'daily'
      ? { day: createdAt.getDate(), month: createdAt.getMonth() + 1, year: createdAt.getFullYear() }
      : period === 'monthly'
        ? { month: createdAt.getMonth() + 1, year: createdAt.getFullYear() }
        : { week: getWeekNumber(createdAt), year: createdAt.getFullYear() };
    groups[key] = row;
  }

  return Object.values(groups).map(item => ({
    ...item,
    total: +item.total.toFixed(2),
    profit: +item.profit.toFixed(2),
    grossProfit: +item.grossProfit.toFixed(2),
  }));
}

function getWeekNumber(date) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  return Math.ceil((((copy - yearStart) / 86400000) + 1) / 7);
}

function buildCompanySeed(companyId, ownerId) {
  const creditCards = [{
    name: 'Cartão',
    icon: 'https://e7.pngegg.com/pngimages/517/985/png-clipart-logo-debit-mastercard-graphics-debit-card-mastercard-text-orange.png',
    fees: [{ installment: 1, value: 0, unit: 'percentage' }],
  }];

  const installments = [{
    name: '1-18x',
    data: buildInstallmentData(),
  }];

  const machines = [{
    name: 'Moderninha Pro 2',
    icon: '/images/moderninha-pro2.png',
    installment_id: 1,
    employees: [ownerId],
  }];

  return { creditCards, installments, machines };
}

async function seedCompanyData(companyId, ownerId) {
  const seed = buildCompanySeed(companyId, ownerId);

  for (const item of seed.installments) {
    await run('INSERT INTO installments (company_id,name,data) VALUES (?,?,?)', [
      companyId,
      item.name,
      JSON.stringify(item.data),
    ]);
  }

  for (const item of seed.creditCards) {
    await run('INSERT INTO credit_cards (company_id,name,icon,fees) VALUES (?,?,?,?)', [
      companyId,
      item.name,
      item.icon,
      JSON.stringify(item.fees),
    ]);
  }

  const firstInstallment = await queryOne(
    'SELECT id FROM installments WHERE company_id = ? ORDER BY id LIMIT 1',
    [companyId]
  );
  for (const item of seed.machines) {
    await run('INSERT INTO machines (company_id,name,icon,installment_id,employees) VALUES (?,?,?,?,?)', [
      companyId,
      item.name,
      item.icon,
      firstInstallment.id,
      JSON.stringify(item.employees),
    ]);
  }
}

async function initializePostgresSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT,
      role TEXT DEFAULT 'employee',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name TEXT,
      identifier TEXT,
      icon TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS company_users (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      user_id INTEGER,
      role TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS credit_cards (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      name TEXT,
      icon TEXT,
      fees TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS machines (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      name TEXT,
      icon TEXT,
      installment_id INTEGER,
      employees TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS installments (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      name TEXT,
      data TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      seller_id INTEGER,
      machine_id INTEGER,
      credit_card_id INTEGER,
      installment_id INTEGER,
      type TEXT,
      amount REAL,
      num_installments INTEGER,
      installment_value REAL,
      total REAL,
      profit REAL,
      gross_profit REAL,
      applied_credit_card_fee TEXT,
      applied_installment_fee TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      token TEXT,
      expires_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
  ];

  for (const statement of statements) {
    await retryAsync(() => pgPool.query(statement), 8);
  }
  await retryAsync(() => pgPool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS icon TEXT'), 8);
}

async function startServer() {
  if (USE_POSTGRES) {
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      max: 1,
      ssl: postgresSslOptions(),
    });
    await initializePostgresSchema();
  } else {
    SQL = await initSqlJs({ locateFile: () => SQLJS_WASM });
    const persistedDb = await readPersistedDb();
    db = persistedDb ? new SQL.Database(persistedDb) : new SQL.Database();

    if (IS_VERCEL) {
      console.warn(
        'DATABASE_URL/POSTGRES_URL is not configured. Persistent writes are disabled on Vercel.'
      );
    }

    db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'employee',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

    const userColumns = (await queryAll("PRAGMA table_info('users')")).map(column => column.name);
    if (!userColumns.includes('role') || !userColumns.includes('created_at')) {
      db.run(`CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT,
      role TEXT DEFAULT 'employee',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`);

      const roleSelect = userColumns.includes('role') ? 'COALESCE(role,\'employee\')' : "'employee'";
      const createdAtSelect = userColumns.includes('created_at') ? 'COALESCE(created_at,CURRENT_TIMESTAMP)' : 'CURRENT_TIMESTAMP';

      db.run(`INSERT INTO users_new (id,name,email,password,role,created_at)
      SELECT id,name,email,password,${roleSelect},${createdAtSelect}
      FROM users;`);
      db.run('DROP TABLE users;');
      db.run('ALTER TABLE users_new RENAME TO users;');
    }

    db.run(`CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    identifier TEXT,
    icon TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);
    const companyColumns = (await queryAll("PRAGMA table_info('companies')")).map(column => column.name);
    if (!companyColumns.includes('icon')) {
      db.run('ALTER TABLE companies ADD COLUMN icon TEXT;');
    }

    db.run(`CREATE TABLE IF NOT EXISTS company_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    user_id INTEGER,
    role TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

    db.run(`CREATE TABLE IF NOT EXISTS credit_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    name TEXT,
    icon TEXT,
    fees TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

    db.run(`CREATE TABLE IF NOT EXISTS machines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    name TEXT,
    icon TEXT,
    installment_id INTEGER,
    employees TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

    db.run(`CREATE TABLE IF NOT EXISTS installments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    name TEXT,
    data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

    db.run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    seller_id INTEGER,
    machine_id INTEGER,
    credit_card_id INTEGER,
    installment_id INTEGER,
    type TEXT,
    amount REAL,
    num_installments INTEGER,
    installment_value REAL,
    total REAL,
    profit REAL,
    gross_profit REAL,
    applied_credit_card_fee TEXT,
    applied_installment_fee TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

    db.run(`CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    token TEXT,
    expires_at DATETIME
  );`);

    db.run(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );`);
  }

  let defaultOwner = await queryOne(
    'SELECT * FROM users WHERE email = ? AND role = ?',
    [DEFAULT_OWNER_EMAIL, 'owner']
  );
  if (!defaultOwner) {
    const legacyDefaultOwner = await queryOne(
      'SELECT * FROM users WHERE email = ? AND role = ?',
      [LEGACY_DEFAULT_OWNER_EMAIL, 'owner']
    );
    if (legacyDefaultOwner) {
      await run('UPDATE users SET email = ?, password = ? WHERE id = ?', [
        DEFAULT_OWNER_EMAIL,
        DEFAULT_OWNER_PASSWORD_HASH,
        legacyDefaultOwner.id,
      ]);
      defaultOwner = await queryOne('SELECT * FROM users WHERE id = ?', [legacyDefaultOwner.id]);
    }
  } else {
    await run('UPDATE users SET password = ? WHERE id = ?', [DEFAULT_OWNER_PASSWORD_HASH, defaultOwner.id]);
  }

  const duplicateLegacyDefaultOwner = await queryOne(
    'SELECT id FROM users WHERE email = ? AND role = ?',
    [LEGACY_DEFAULT_OWNER_EMAIL, 'owner']
  );
  if (defaultOwner && duplicateLegacyDefaultOwner) {
    const legacyMemberships = await queryAll(
      'SELECT company_id,role FROM company_users WHERE user_id = ?',
      [duplicateLegacyDefaultOwner.id]
    );
    for (const membership of legacyMemberships) {
      const existingMembership = await queryOne(
        'SELECT id FROM company_users WHERE company_id = ? AND user_id = ?',
        [membership.company_id, defaultOwner.id]
      );
      if (!existingMembership) {
        await run('INSERT INTO company_users (company_id,user_id,role) VALUES (?,?,?)', [
          membership.company_id,
          defaultOwner.id,
          membership.role,
        ]);
      }
    }
    await run('UPDATE sales SET seller_id = ? WHERE seller_id = ?', [
      defaultOwner.id,
      duplicateLegacyDefaultOwner.id,
    ]);
    await run('DELETE FROM refresh_tokens WHERE user_id = ?', [duplicateLegacyDefaultOwner.id]);
    await run('DELETE FROM company_users WHERE user_id = ?', [duplicateLegacyDefaultOwner.id]);
    await run('DELETE FROM users WHERE id = ?', [duplicateLegacyDefaultOwner.id]);
  }

  if (!defaultOwner) {
    const ownerId = await run('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)', [
      'Administrator',
      DEFAULT_OWNER_EMAIL,
      DEFAULT_OWNER_PASSWORD_HASH,
      'owner',
    ]);

    const companyId = await run('INSERT INTO companies (name,identifier,icon) VALUES (?,?,?)', ['Junior Cred', 'junior-cred', DEFAULT_COMPANY_ICON]);
    await run('INSERT INTO company_users (company_id,user_id,role) VALUES (?,?,?)', [companyId, ownerId, 'owner']);

    await seedCompanyData(companyId, ownerId);
  }

  async function ensureCombinedInstallments() {
    const companies = await queryAll('SELECT id FROM companies');
    for (const company of companies) {
      const installments = await queryAll(
        'SELECT id,name,data FROM installments WHERE company_id = ? ORDER BY id',
        [company.id]
      );
      let combinedInstallment = installments.find(item => item.name === '1-18x');
      const sourceInstallments = combinedInstallment
        ? [
          ...installments.filter(item => item.id !== combinedInstallment.id),
          combinedInstallment,
        ]
        : installments;
      const configuredFees = new Map();

      sourceInstallments.forEach(installment => {
        const data = normalizeJson(installment.data) || [];
        const namedInstallment = /^(\d+)x$/i.exec(String(installment.name).trim());

        data.forEach(item => {
          const installmentNumber = namedInstallment && data.length === 1
            ? Number(namedInstallment[1])
            : Number(item.installment);
          if (installmentNumber >= 1 && installmentNumber <= 18) {
            configuredFees.set(installmentNumber, {
              value: Number(item.value) || 0,
              unit: item.unit || 'percentage',
            });
          }
        });
      });

      const data = Array.from({ length: 18 }, (_, index) => {
        const installmentNumber = index + 1;
        const fee = configuredFees.get(installmentNumber) || {
          value: 0,
          unit: 'percentage',
        };
        return {
          installment: installmentNumber,
          value: fee.value,
          unit: fee.unit,
        };
      });

      if (combinedInstallment) {
        await run(
          'UPDATE installments SET name = ?, data = ? WHERE id = ? AND company_id = ?',
          ['1-18x', JSON.stringify(data), combinedInstallment.id, company.id]
        );
      } else if (installments.length > 0) {
        combinedInstallment = installments[0];
        await run(
          'UPDATE installments SET name = ?, data = ? WHERE id = ? AND company_id = ?',
          ['1-18x', JSON.stringify(data), combinedInstallment.id, company.id]
        );
      } else {
        const newInstallmentId = await run(
          'INSERT INTO installments (company_id,name,data) VALUES (?,?,?)',
          [company.id, '1-18x', JSON.stringify(data)]
        );
        combinedInstallment = {
          id: newInstallmentId,
        };
      }

      const obsoleteIds = installments
        .filter(item => item.id !== combinedInstallment.id)
        .map(item => item.id);

      await run(
        'UPDATE machines SET installment_id = ? WHERE company_id = ?',
        [combinedInstallment.id, company.id]
      );
      for (const id of obsoleteIds) {
        await run(
          'UPDATE sales SET installment_id = ? WHERE company_id = ? AND installment_id = ?',
          [combinedInstallment.id, company.id, id]
        );
        await run('DELETE FROM installments WHERE id = ? AND company_id = ?', [id, company.id]);
      }
    }
  }

  async function zeroInstallmentsOnce() {
    const migrationKey = 'zero_installments_default_20260606';
    const existingMigration = await queryOne(
      'SELECT value FROM app_settings WHERE key = ?',
      [migrationKey]
    );
    if (existingMigration) return;

    const zeroData = JSON.stringify(buildInstallmentData(0));
    const companies = await queryAll('SELECT id FROM companies');
    for (const company of companies) {
      const installments = await queryAll(
        'SELECT id,name FROM installments WHERE company_id = ? ORDER BY id',
        [company.id]
      );
      let combinedInstallment = installments.find(item => item.name === '1-18x') || installments[0];

      if (combinedInstallment) {
        await run(
          'UPDATE installments SET name = ?, data = ? WHERE id = ? AND company_id = ?',
          ['1-18x', zeroData, combinedInstallment.id, company.id]
        );
      } else {
        const id = await run(
          'INSERT INTO installments (company_id,name,data) VALUES (?,?,?)',
          [company.id, '1-18x', zeroData]
        );
        combinedInstallment = { id };
      }

      const obsoleteIds = installments
        .filter(item => item.id !== combinedInstallment.id)
        .map(item => item.id);

      await run(
        'UPDATE machines SET installment_id = ? WHERE company_id = ?',
        [combinedInstallment.id, company.id]
      );
      for (const id of obsoleteIds) {
        await run(
          'UPDATE sales SET installment_id = ? WHERE company_id = ? AND installment_id = ?',
          [combinedInstallment.id, company.id, id]
        );
        await run('DELETE FROM installments WHERE id = ? AND company_id = ?', [id, company.id]);
      }
    }

    await run('INSERT INTO app_settings (key,value) VALUES (?,?)', [
      migrationKey,
      new Date().toISOString(),
    ]);
  }

  const defaultOwnerUser = await queryOne(
    'SELECT id FROM users WHERE email = ? AND role = ?',
    [DEFAULT_OWNER_EMAIL, 'owner']
  );
  const primaryCompany = await queryOne('SELECT id FROM companies ORDER BY id LIMIT 1');
  if (defaultOwnerUser && primaryCompany) {
    const primaryMembership = await queryOne(
      'SELECT id FROM company_users WHERE user_id = ? AND company_id = ?',
      [defaultOwnerUser.id, primaryCompany.id]
    );
    if (!primaryMembership) {
      await run(
        'INSERT INTO company_users (company_id,user_id,role) VALUES (?,?,?)',
        [primaryCompany.id, defaultOwnerUser.id, 'owner']
      );
    }
    await run(
      'DELETE FROM company_users WHERE user_id = ? AND company_id <> ?',
      [defaultOwnerUser.id, primaryCompany.id]
    );
  }

  await ensureCombinedInstallments();
  await zeroInstallmentsOnce();

  if (!(await persistDb())) {
    throw new Error('Failed to persist the initialized database');
  }

  app.use((req, res, next) => {
    const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const nonPersistentPosts = new Set(['/auth/login', '/auth/refresh', '/sale/simulation']);
    if (
      IS_VERCEL
      && !USE_POSTGRES
      && writeMethods.has(req.method)
      && !nonPersistentPosts.has(req.path)
    ) {
      return res.status(503).json({
        message: 'Configure DATABASE_URL ou POSTGRES_URL na Vercel para salvar alteracoes.',
      });
    }
    return next();
  });

  function authenticate(req, res, next) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Missing Bearer token' });
    }
    const token = authHeader.split(' ')[1];
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'devsecret');
      req.user = payload;
      return next();
    } catch (error) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
  }

  async function requireCompany(req, res, next) {
    const companyId = req.headers['x-company-id'];
    const numericCompanyId = Number(companyId);
    if (numericCompanyId && await ensureCompanyMembership(req.user.userId, numericCompanyId)) {
      req.companyId = numericCompanyId;
      return next();
    }

    const fallbackMembership = await queryOne(
      'SELECT company_id FROM company_users WHERE user_id = ? ORDER BY id LIMIT 1',
      [req.user.userId]
    );
    if (!fallbackMembership) {
      return res.status(403).json({ message: 'User does not belong to a company' });
    }

    req.companyId = Number(fallbackMembership.company_id);
    res.header('x-company-id', String(req.companyId));
    return next();
  }

  app.post('/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email and password are required' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) {
      return res.status(400).json({ message: 'Email is already registered' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const userId = await run('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)', [name, normalizedEmail, hash, 'owner']);
    const companyId = await run('INSERT INTO companies (name,identifier,icon) VALUES (?,?,?)', [`${name} Company`, `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`, DEFAULT_COMPANY_ICON]);
    await run('INSERT INTO company_users (company_id,user_id,role) VALUES (?,?,?)', [companyId, userId, 'owner']);
    await seedCompanyData(companyId, userId);
    if (!(await persistOrError(res))) return;

    const accessToken = createAccessToken({ id: userId, role: 'owner', email: normalizedEmail });
    const refreshToken = createRefreshToken({ id: userId });

    return res.json({ accessToken, refreshToken });
  });

  app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'email and password required' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await queryOne('SELECT id,name,email,password,role FROM users WHERE email = ?', [normalizedEmail]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user);

    return res.json({ accessToken, refreshToken });
  });

  app.post('/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ message: 'refreshToken required' });
    }
    let userId;
    let legacyTokenRow = null;
    try {
      userId = verifySignedRefreshToken(refreshToken).userId;
    } catch {
      legacyTokenRow = await queryOne(
        'SELECT id,user_id,expires_at FROM refresh_tokens WHERE token = ?',
        [refreshToken]
      );
      if (!legacyTokenRow) {
        return res.status(401).json({ message: 'Invalid refresh token' });
      }
      if (new Date(legacyTokenRow.expires_at) < new Date()) {
        await run('DELETE FROM refresh_tokens WHERE id = ?', [legacyTokenRow.id]);
        if (!(await persistOrError(res))) return;
        return res.status(401).json({ message: 'Refresh token expired' });
      }
      userId = legacyTokenRow.user_id;
    }

    const user = await queryOne('SELECT id,email,role FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    if (legacyTokenRow) {
      await run('DELETE FROM refresh_tokens WHERE id = ?', [legacyTokenRow.id]);
      if (!(await persistOrError(res))) return;
    }

    return res.json({ accessToken: createAccessToken(user), refreshToken: createRefreshToken(user) });
  });

  app.get('/company/get-by-user', authenticate, async (req, res) => {
    const companies = await queryAll(
      'SELECT c.id,c.name,c.identifier,c.icon FROM companies c JOIN company_users cu ON cu.company_id = c.id WHERE cu.user_id = ?',
      [req.user.userId]
    );
    res.json(companies.map(company => ({
      ...company,
      icon: normalizeCompanyIcon(company.icon),
    })));
  });

  app.put('/company/profile', authenticate, requireCompany, async (req, res) => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Only owner may update company profile' });
    }

    const company = await queryOne(
      'SELECT id,name,identifier,icon FROM companies WHERE id = ?',
      [req.companyId]
    );
    if (!company) {
      return res.status(404).json({ message: 'Company not found' });
    }

    const body = req.body || {};
    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : company.name;
    const icon = normalizeCompanyIcon(body.icon);

    await run('UPDATE companies SET name = ?, icon = ? WHERE id = ?', [name, icon, req.companyId]);
    if (!(await persistOrError(res))) return;

    const updatedCompany = await queryOne(
      'SELECT id,name,identifier,icon FROM companies WHERE id = ?',
      [req.companyId]
    );
    res.json({
      ...updatedCompany,
      icon: normalizeCompanyIcon(updatedCompany.icon),
    });
  });

  app.get('/user/find-by-company', authenticate, requireCompany, async (req, res) => {
    const users = await queryAll(
      'SELECT u.id,u.name,u.email,u.role,u.created_at AS "createdAt" FROM users u JOIN company_users cu ON cu.user_id = u.id WHERE cu.company_id = ?',
      [req.companyId]
    );
    res.json(users.map(normalizeUser));
  });

  app.post('/user/employee', authenticate, requireCompany, async (req, res) => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Only owner may add employees' });
    }
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email and password are required' });
    }
    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ message: 'Email is already registered' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const userId = await run('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)', [name, email, hash, 'employee']);
    await run('INSERT INTO company_users (company_id,user_id,role) VALUES (?,?,?)', [req.companyId, userId, 'employee']);
    if (!(await persistOrError(res))) return;
    const user = await queryOne('SELECT id,name,email,role,created_at AS "createdAt" FROM users WHERE id = ?', [userId]);
    res.json(normalizeUser(user));
  });

  app.put('/user/employee/:id', authenticate, requireCompany, async (req, res) => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Only owner may update employees' });
    }

    const userId = Number(req.params.id);
    const existingUser = await queryOne(
      `SELECT u.id,u.name,u.email,u.password,u.role
       FROM users u
       JOIN company_users cu ON cu.user_id = u.id
       WHERE u.id = ? AND cu.company_id = ?`,
      [userId, req.companyId]
    );
    if (!existingUser) return res.status(404).json({ message: 'Employee not found' });

    const { name, email, password } = req.body;
    const normalizedEmail = email || existingUser.email;
    const emailOwner = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [normalizedEmail, userId]);
    if (emailOwner) return res.status(400).json({ message: 'Email is already registered' });

    const passwordHash = password ? bcrypt.hashSync(password, 10) : existingUser.password;
    await run(
      'UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?',
      [name || existingUser.name, normalizedEmail, passwordHash, userId]
    );
    if (!(await persistOrError(res))) return;
    res.json(normalizeUser(await queryOne('SELECT id,name,email,role,created_at AS "createdAt" FROM users WHERE id = ?', [userId])));
  });

  app.delete('/user/employee/:id', authenticate, requireCompany, async (req, res) => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Only owner may remove employees' });
    }
    const userId = Number(req.params.id);
    if (!userId || userId === req.user.userId) {
      return res.status(400).json({ message: 'Invalid user' });
    }
    await run('DELETE FROM company_users WHERE company_id = ? AND user_id = ?', [req.companyId, userId]);
    if (!(await persistOrError(res))) return;
    res.json({ success: true });
  });

  app.get('/credit-card', authenticate, requireCompany, async (req, res) => {
    const cards = await queryAll('SELECT id,company_id,name,icon,fees FROM credit_cards WHERE company_id = ?', [req.companyId]);
    res.json(await Promise.all(cards.map(enrichCreditCard)));
  });

  app.post('/credit-card', authenticate, requireCompany, async (req, res) => {
    const { name, icon, fees } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required' });
    const id = await run('INSERT INTO credit_cards (company_id,name,icon,fees) VALUES (?,?,?,?)', [req.companyId, name, icon || '', JSON.stringify(fees || [])]);
    if (!(await persistOrError(res))) return;
    const card = await queryOne('SELECT id,company_id,name,icon,fees FROM credit_cards WHERE id = ?', [id]);
    res.json(await enrichCreditCard(card));
  });

  app.put('/credit-cards/:id', authenticate, requireCompany, async (req, res) => {
    const cardId = Number(req.params.id);
    const { name, icon, fees } = req.body;
    await run('UPDATE credit_cards SET name = ?, icon = ?, fees = ? WHERE id = ? AND company_id = ?', [name, icon || '', JSON.stringify(fees || []), cardId, req.companyId]);
    const card = await queryOne('SELECT id,company_id,name,icon,fees FROM credit_cards WHERE id = ? AND company_id = ?', [cardId, req.companyId]);
    if (!card) return res.status(404).json({ message: 'Credit card not found' });
    if (!(await persistOrError(res))) return;
    res.json(await enrichCreditCard(card));
  });

  app.delete('/credit-card/:id', authenticate, requireCompany, async (req, res) => {
    const cardId = Number(req.params.id);
    await run('DELETE FROM credit_cards WHERE id = ? AND company_id = ?', [cardId, req.companyId]);
    if (!(await persistOrError(res))) return;
    res.json({ success: true });
  });

  app.get('/machines', authenticate, requireCompany, async (req, res) => {
    const machines = await queryAll('SELECT id,company_id,name,icon,installment_id,employees FROM machines WHERE company_id = ?', [req.companyId]);
    res.json(await Promise.all(machines.map(enrichMachine)));
  });

  app.post('/machines', authenticate, requireCompany, async (req, res) => {
    const { name, icon, installmentId, employees } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required' });
    const id = await run('INSERT INTO machines (company_id,name,icon,installment_id,employees) VALUES (?,?,?,?,?)', [req.companyId, name, icon || '', installmentId || null, JSON.stringify(employees || [])]);
    if (!(await persistOrError(res))) return;
    const machine = await queryOne('SELECT id,company_id,name,icon,installment_id,employees FROM machines WHERE id = ?', [id]);
    res.json(await enrichMachine(machine));
  });

  app.put('/machines/:id', authenticate, requireCompany, async (req, res) => {
    const machineId = Number(req.params.id);
    const { name, icon, installmentId, employees } = req.body;
    const existingMachine = await queryOne(
      'SELECT name,icon,installment_id,employees FROM machines WHERE id = ? AND company_id = ?',
      [machineId, req.companyId]
    );
    if (!existingMachine) return res.status(404).json({ message: 'Machine not found' });

    await run(
      'UPDATE machines SET name = ?, icon = ?, installment_id = ?, employees = ? WHERE id = ? AND company_id = ?',
      [
        name ?? existingMachine.name,
        icon ?? existingMachine.icon,
        installmentId ?? existingMachine.installment_id,
        JSON.stringify(employees ?? normalizeJson(existingMachine.employees) ?? []),
        machineId,
        req.companyId,
      ]
    );
    const machine = await queryOne('SELECT id,company_id,name,icon,installment_id,employees FROM machines WHERE id = ? AND company_id = ?', [machineId, req.companyId]);
    if (!(await persistOrError(res))) return;
    res.json(await enrichMachine(machine));
  });

  app.delete('/machines/:id', authenticate, requireCompany, async (req, res) => {
    const machineId = Number(req.params.id);
    await run('DELETE FROM machines WHERE id = ? AND company_id = ?', [machineId, req.companyId]);
    if (!(await persistOrError(res))) return;
    res.json({ success: true });
  });

  app.get('/installments', authenticate, requireCompany, async (req, res) => {
    const installments = await queryAll('SELECT id,company_id,name,data FROM installments WHERE company_id = ?', [req.companyId]);
    res.json(installments.map(enrichInstallment));
  });

  app.post('/installments', authenticate, requireCompany, async (req, res) => {
    const { name, data } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required' });
    const id = await run('INSERT INTO installments (company_id,name,data) VALUES (?,?,?)', [req.companyId, name, JSON.stringify(normalizeInstallmentData(data))]);
    if (!(await persistOrError(res))) return;
    const installment = await queryOne('SELECT id,company_id,name,data FROM installments WHERE id = ?', [id]);
    res.json(enrichInstallment(installment));
  });

  app.put('/installments/:id', authenticate, requireCompany, async (req, res) => {
    const installmentId = Number(req.params.id);
    const { name, data } = req.body;
    await run('UPDATE installments SET name = ?, data = ? WHERE id = ? AND company_id = ?', [name, JSON.stringify(normalizeInstallmentData(data)), installmentId, req.companyId]);
    const installment = await queryOne('SELECT id,company_id,name,data FROM installments WHERE id = ? AND company_id = ?', [installmentId, req.companyId]);
    if (!installment) return res.status(404).json({ message: 'Installment not found' });
    if (!(await persistOrError(res))) return;
    res.json(enrichInstallment(installment));
  });

  app.delete('/installments/:id', authenticate, requireCompany, async (req, res) => {
    const installmentId = Number(req.params.id);
    await run('DELETE FROM installments WHERE id = ? AND company_id = ?', [installmentId, req.companyId]);
    if (!(await persistOrError(res))) return;
    res.json({ success: true });
  });

  app.post('/sale/simulation', authenticate, requireCompany, async (req, res) => {
    const {
      amount,
      numInstallments,
      type,
      creditCardId,
      installmentId,
      machineId,
      sellerId,
      appliedCreditCardFee,
      appliedInstallmentFee,
    } = req.body;

    const resolvedFees = await resolveSimulationFees(
      req.companyId,
      creditCardId,
      installmentId,
      numInstallments
    );
    const calculation = calculateSimulation(
      amount,
      numInstallments,
      type,
      resolvedFees.creditCardFee,
      resolvedFees.installmentFee
    );

    return res.json({
      ...calculation,
      appliedCreditCardFee: resolvedFees.creditCardFee,
      appliedInstallmentFee: resolvedFees.installmentFee,
      machineId,
      creditCardId,
      installmentId: resolvedFees.installmentId,
      sellerId,
    });
  });

  app.get('/sale', authenticate, requireCompany, async (req, res) => {
    res.json(await getSales(req.companyId, req.query));
  });

  app.post('/sale', authenticate, requireCompany, async (req, res) => {
    const {
      amount,
      numInstallments,
      type,
      creditCardId,
      installmentId,
      machineId,
      sellerId,
      appliedCreditCardFee,
      appliedInstallmentFee,
      total,
      installmentValue,
      profit,
      grossProfit,
    } = req.body;

    const resolvedInstallment = await findInstallmentForNumber(
      req.companyId,
      installmentId,
      numInstallments
    );
    const parsedAmount = Number(amount) || 0;
    const parsedInstallments = Number(numInstallments) || 1;
    if (!creditCardId || !resolvedInstallment.installmentId || !machineId || !sellerId) {
      return res.status(400).json({ message: 'Missing sale required fields' });
    }

    const id = await run(
      'INSERT INTO sales (company_id,seller_id,machine_id,credit_card_id,installment_id,type,amount,num_installments,installment_value,total,profit,gross_profit,applied_credit_card_fee,applied_installment_fee) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        req.companyId,
        sellerId,
        machineId,
        creditCardId,
        resolvedInstallment.installmentId,
        type || 'unleashed',
        parsedAmount,
        parsedInstallments,
        Number(installmentValue) || 0,
        Number(total) || 0,
        Number(profit) || 0,
        Number(grossProfit) || 0,
        JSON.stringify(appliedCreditCardFee || {}),
        JSON.stringify(appliedInstallmentFee || {}),
      ]
    );
    if (!(await persistOrError(res))) return;
    const sale = await queryOne('SELECT * FROM sales WHERE id = ?', [id]);
    return res.json(await enrichSale(sale));
  });

  app.delete('/sale/:id', authenticate, requireCompany, async (req, res) => {
    const saleId = Number(req.params.id);
    await run('DELETE FROM sales WHERE id = ? AND company_id = ?', [saleId, req.companyId]);
    if (!(await persistOrError(res))) return;
    res.json({ success: true });
  });

  app.get('/sale/sellers-rank', authenticate, requireCompany, async (req, res) => {
    const sales = await getSales(req.companyId, req.query);
    const countBySeller = {};
    for (const sale of sales) {
      const seller = sale.seller[0];
      if (!seller) continue;
      const key = seller.id;
      countBySeller[key] = countBySeller[key] || { _id: { seller }, value: 0, count: 0 };
      countBySeller[key].count += 1;
      countBySeller[key].value += 1;
    }
    res.json(Object.values(countBySeller));
  });

  app.get('/sale/by-day-of-week', authenticate, requireCompany, async (req, res) => {
    const sales = await getSales(req.companyId, req.query);
    const groups = {};
    for (const sale of sales) {
      const day = new Date(sale.created_at).getDay() + 1;
      groups[day] = groups[day] || { _id: { day }, total: 0, count: 0, profit: 0, grossProfit: 0 };
      groups[day].total += Number(sale.total || 0);
      groups[day].count += 1;
      groups[day].profit += Number(sale.profit || 0);
      groups[day].grossProfit += Number(sale.gross_profit || 0);
    }
    res.json(Object.values(groups).map(item => ({
      ...item,
      total: +item.total.toFixed(2),
      profit: +item.profit.toFixed(2),
      grossProfit: +item.grossProfit.toFixed(2),
    })));
  });

  app.get('/sale/growth', authenticate, requireCompany, async (req, res) => {
    const sales = await getSales(req.companyId, req.query);
    const groups = {};
    for (const sale of sales) {
      const date = new Date(sale.created_at);
      const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
      groups[key] = groups[key] || { _id: { date: key }, total: 0, count: 0 };
      groups[key].total += Number(sale.total || 0);
      groups[key].count += 1;
    }
    res.json(Object.values(groups).map(item => ({
      ...item,
      total: +item.total.toFixed(2),
    })));
  });

  app.get('/sale/by-period', authenticate, requireCompany, async (req, res) => {
    const period = req.query.period || 'daily';
    const sales = await getSales(req.companyId, req.query);
    res.json(groupSalesByPeriod(sales, period));
  });

  app.get('/sale/by-machine', authenticate, requireCompany, async (req, res) => {
    const sales = await getSales(req.companyId, req.query);
    const groups = {};
    for (const sale of sales) {
      const machine = sale.machine[0];
      if (!machine) continue;
      const key = machine.id;
      groups[key] = groups[key] || { _id: { machine }, total: 0, count: 0, profit: 0, grossProfit: 0 };
      groups[key].total += Number(sale.total || 0);
      groups[key].count += 1;
      groups[key].profit += Number(sale.profit || 0);
      groups[key].grossProfit += Number(sale.gross_profit || 0);
    }
    res.json(Object.values(groups).map(item => ({
      ...item,
      total: +item.total.toFixed(2),
      profit: +item.profit.toFixed(2),
      grossProfit: +item.grossProfit.toFixed(2),
    })));
  });

  app.get('/sale/by-installment', authenticate, requireCompany, async (req, res) => {
    const sales = await getSales(req.companyId, req.query);
    const groups = {};
    for (const sale of sales) {
      const installment = sale.installment[0];
      if (!installment) continue;
      const key = installment.id;
      groups[key] = groups[key] || { _id: { installment }, total: 0, count: 0, profit: 0, grossProfit: 0 };
      groups[key].total += Number(sale.total || 0);
      groups[key].count += 1;
      groups[key].profit += Number(sale.profit || 0);
      groups[key].grossProfit += Number(sale.gross_profit || 0);
    }
    res.json(Object.values(groups).map(item => ({
      ...item,
      total: +item.total.toFixed(2),
      profit: +item.profit.toFixed(2),
      grossProfit: +item.grossProfit.toFixed(2),
    })));
  });

  app.get('*', async (req, res) => {
    const indexPath = path.join(STATIC_ROOT, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.sendFile(indexPath);
    }
    return res.status(404).send('Not found');
  });
}

initializationPromise = startServer();

if (require.main === module) {
  initializationPromise
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
      });
    })
    .catch(error => {
      console.error('Failed to start server:', error);
      process.exit(1);
    });
}

module.exports = app;
