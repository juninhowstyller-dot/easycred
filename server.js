const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const dotenv = require('dotenv');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const IS_VERCEL = Boolean(process.env.VERCEL);
const STATIC_ROOT = IS_VERCEL ? path.join(__dirname, 'public') : __dirname;
const DB_PATH = process.env.EASYCRED_DB_PATH
  || (IS_VERCEL ? path.join(os.tmpdir(), 'easycred-data.db') : path.join(__dirname, 'data.db'));
const SQLJS_WASM = require.resolve('sql.js/dist/sql-wasm.wasm');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-company-id');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(STATIC_ROOT));

let db;
let SQL;
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

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  return queryAll(sql, params)[0] || null;
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}

function persistDb() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (error) {
    console.error('Failed to persist DB:', error);
  }
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

  total = roundCurrency(total);
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
  return jwt.sign({ userId: user.id, role: user.role, email: user.email }, secret, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  });
}

function createRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

function ensureCompanyMembership(userId, companyId) {
  const row = queryOne('SELECT 1 FROM company_users WHERE user_id = ? AND company_id = ?', [userId, companyId]);
  return !!row;
}

function enrichCreditCard(card) {
  const fees = normalizeJson(card.fees) || [];
  if (card.company_id == null) {
    return { ...card, fees };
  }

  const configuredInstallments = getConfiguredInstallmentNumbers(card.company_id);
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

function getConfiguredInstallmentNumbers(companyId) {
  const installments = queryAll(
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

function findInstallmentForNumber(companyId, preferredInstallmentId, numInstallments) {
  const installmentNumber = Number(numInstallments);
  const installments = queryAll(
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

function resolveSimulationFees(companyId, creditCardId, installmentId, numInstallments) {
  const installmentNumber = Number(numInstallments);
  const card = queryOne(
    'SELECT fees FROM credit_cards WHERE id = ? AND company_id = ?',
    [Number(creditCardId), companyId]
  );
  const installment = findInstallmentForNumber(companyId, installmentId, installmentNumber);
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

function buildFallbackInstallment(machine) {
  if (machine.company_id == null) return null;

  const installments = queryAll(
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

function enrichMachine(machine) {
  const linkedInstallment = machine.installment_id != null
    ? queryOne('SELECT id,name,data FROM installments WHERE id = ?', [machine.installment_id])
    : null;
  const installment = linkedInstallment || buildFallbackInstallment(machine);

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

function enrichSale(row) {
  const sale = {
    ...row,
    appliedCreditCardFee: normalizeJson(row.applied_credit_card_fee) || null,
    appliedInstallmentFee: normalizeJson(row.applied_installment_fee) || null,
  };

  const machine = queryOne('SELECT id,company_id,name,icon,installment_id,employees FROM machines WHERE id = ?', [sale.machine_id]);
  const creditCard = queryOne('SELECT id,name,icon,fees FROM credit_cards WHERE id = ?', [sale.credit_card_id]);
  const installment = queryOne('SELECT id,name,data FROM installments WHERE id = ?', [sale.installment_id]);
  const seller = queryOne('SELECT id,name,email,role FROM users WHERE id = ?', [sale.seller_id]);

  return {
    ...sale,
    machine: machine ? [enrichMachine(machine)] : [],
    creditCard: creditCard ? [enrichCreditCard(creditCard)] : [],
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

function getSales(companyId, query = {}) {
  const { filters, params } = buildSaleFilters(query);
  filters.unshift('company_id = ?');
  params.unshift(companyId);
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const sales = queryAll(`SELECT * FROM sales ${whereClause} ORDER BY created_at DESC`, params);
  return sales.map(enrichSale);
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
    data: Array.from({ length: 18 }, (_, index) => ({
      installment: index + 1,
      value: index + 1 === 10 ? 16 : 0,
      unit: 'percentage',
    })),
  }];

  const machines = [{
    name: 'Moderninha Pro 2',
    icon: '/images/moderninha-pro2.png',
    installment_id: 1,
    employees: [ownerId],
  }];

  return { creditCards, installments, machines };
}

async function startServer() {
  SQL = await initSqlJs({ locateFile: () => SQLJS_WASM });
  if (fs.existsSync(DB_PATH)) {
    const filebuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'employee',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  const userColumns = queryAll("PRAGMA table_info('users')").map(column => column.name);
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

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

  const defaultOwner = queryOne(
    'SELECT * FROM users WHERE email = ? AND role = ?',
    ['admin@easycred.test', 'owner']
  );
  if (!defaultOwner) {
    const ownerPassword = bcrypt.hashSync('Password123!', 10);
    run('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)', [
      'Administrator',
      'admin@easycred.test',
      ownerPassword,
      'owner',
    ]);

    const ownerId = queryOne('SELECT last_insert_rowid() AS id').id;
    run('INSERT INTO companies (name,identifier) VALUES (?,?)', ['Junior Cred', 'junior-cred']);
    const companyId = queryOne('SELECT last_insert_rowid() AS id').id;
    run('INSERT INTO company_users (company_id,user_id,role) VALUES (?,?,?)', [companyId, ownerId, 'owner']);

    const seed = buildCompanySeed(companyId, ownerId);
    seed.installments.forEach(item => {
      run('INSERT INTO installments (company_id,name,data) VALUES (?,?,?)', [companyId, item.name, JSON.stringify(item.data)]);
    });

    seed.creditCards.forEach(item => {
      run('INSERT INTO credit_cards (company_id,name,icon,fees) VALUES (?,?,?,?)', [companyId, item.name, item.icon, JSON.stringify(item.fees)]);
    });

    const firstInstallment = queryOne('SELECT id FROM installments WHERE company_id = ? ORDER BY id LIMIT 1', [companyId]);
    seed.machines.forEach(item => {
      run('INSERT INTO machines (company_id,name,icon,installment_id,employees) VALUES (?,?,?,?,?)', [companyId, item.name, item.icon, firstInstallment.id, JSON.stringify(item.employees)]);
    });
  }

  function ensureCombinedInstallments() {
    const companies = queryAll('SELECT id FROM companies');
    companies.forEach(company => {
      const installments = queryAll(
        'SELECT id,name,data FROM installments WHERE company_id = ? ORDER BY id',
        [company.id]
      );
      const configuredFees = new Map();

      installments.forEach(installment => {
        (normalizeJson(installment.data) || []).forEach(item => {
          const installmentNumber = Number(item.installment);
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

      let combinedInstallment = installments.find(item => item.name === '1-18x');
      if (combinedInstallment) {
        run(
          'UPDATE installments SET data = ? WHERE id = ? AND company_id = ?',
          [JSON.stringify(data), combinedInstallment.id, company.id]
        );
      } else if (installments.length > 0) {
        combinedInstallment = installments[0];
        run(
          'UPDATE installments SET name = ?, data = ? WHERE id = ? AND company_id = ?',
          ['1-18x', JSON.stringify(data), combinedInstallment.id, company.id]
        );
      } else {
        run(
          'INSERT INTO installments (company_id,name,data) VALUES (?,?,?)',
          [company.id, '1-18x', JSON.stringify(data)]
        );
        combinedInstallment = {
          id: queryOne('SELECT last_insert_rowid() AS id').id,
        };
      }

      const obsoleteIds = installments
        .filter(item => item.id !== combinedInstallment.id)
        .map(item => item.id);

      run(
        'UPDATE machines SET installment_id = ? WHERE company_id = ?',
        [combinedInstallment.id, company.id]
      );
      obsoleteIds.forEach(id => {
        run(
          'UPDATE sales SET installment_id = ? WHERE company_id = ? AND installment_id = ?',
          [combinedInstallment.id, company.id, id]
        );
        run('DELETE FROM installments WHERE id = ? AND company_id = ?', [id, company.id]);
      });
    });
  }

  const defaultOwnerUser = queryOne(
    'SELECT id FROM users WHERE email = ? AND role = ?',
    ['admin@easycred.test', 'owner']
  );
  const primaryCompany = queryOne('SELECT id FROM companies ORDER BY id LIMIT 1');
  if (defaultOwnerUser && primaryCompany) {
    const primaryMembership = queryOne(
      'SELECT id FROM company_users WHERE user_id = ? AND company_id = ?',
      [defaultOwnerUser.id, primaryCompany.id]
    );
    if (!primaryMembership) {
      run(
        'INSERT INTO company_users (company_id,user_id,role) VALUES (?,?,?)',
        [primaryCompany.id, defaultOwnerUser.id, 'owner']
      );
    }
    run(
      'DELETE FROM company_users WHERE user_id = ? AND company_id <> ?',
      [defaultOwnerUser.id, primaryCompany.id]
    );
  }

  ensureCombinedInstallments();

  persistDb();

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

  function requireCompany(req, res, next) {
    const companyId = req.headers['x-company-id'];
    const numericCompanyId = Number(companyId);
    if (numericCompanyId && ensureCompanyMembership(req.user.userId, numericCompanyId)) {
      req.companyId = numericCompanyId;
      return next();
    }

    const fallbackMembership = queryOne(
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

  app.post('/auth/register', (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email and password are required' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = queryOne('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existing) {
      return res.status(400).json({ message: 'Email is already registered' });
    }

    const hash = bcrypt.hashSync(password, 10);
    run('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)', [name, normalizedEmail, hash, 'owner']);
    const userId = queryOne('SELECT last_insert_rowid() AS id').id;
    run('INSERT INTO companies (name,identifier) VALUES (?,?)', [`${name} Company`, `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`]);
    const companyId = queryOne('SELECT last_insert_rowid() AS id').id;
    run('INSERT INTO company_users (company_id,user_id,role) VALUES (?,?,?)', [companyId, userId, 'owner']);
    persistDb();

    const accessToken = createAccessToken({ id: userId, role: 'owner', email: normalizedEmail });
    const refreshToken = createRefreshToken();
    const expiresAt = new Date(Date.now() + (Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 7) * 24 * 60 * 60 * 1000)).toISOString();
    run('INSERT INTO refresh_tokens (user_id,token,expires_at) VALUES (?,?,?)', [userId, refreshToken, expiresAt]);
    persistDb();

    return res.json({ accessToken, refreshToken });
  });

  app.post('/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'email and password required' });
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = queryOne('SELECT id,name,email,password,role FROM users WHERE email = ?', [normalizedEmail]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken();
    const expiresAt = new Date(Date.now() + (Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 7) * 24 * 60 * 60 * 1000)).toISOString();
    run('INSERT INTO refresh_tokens (user_id,token,expires_at) VALUES (?,?,?)', [user.id, refreshToken, expiresAt]);
    persistDb();

    return res.json({ accessToken, refreshToken });
  });

  app.post('/auth/refresh', (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ message: 'refreshToken required' });
    }
    const tokenRow = queryOne('SELECT id,user_id,expires_at FROM refresh_tokens WHERE token = ?', [refreshToken]);
    if (!tokenRow) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }
    if (new Date(tokenRow.expires_at) < new Date()) {
      run('DELETE FROM refresh_tokens WHERE id = ?', [tokenRow.id]);
      persistDb();
      return res.status(401).json({ message: 'Refresh token expired' });
    }
    const user = queryOne('SELECT id,email,role FROM users WHERE id = ?', [tokenRow.user_id]);
    if (!user) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    run('DELETE FROM refresh_tokens WHERE id = ?', [tokenRow.id]);
    const newRefreshToken = createRefreshToken();
    const expiresAt = new Date(Date.now() + (Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 7) * 24 * 60 * 60 * 1000)).toISOString();
    run('INSERT INTO refresh_tokens (user_id,token,expires_at) VALUES (?,?,?)', [user.id, newRefreshToken, expiresAt]);
    persistDb();

    return res.json({ accessToken: createAccessToken(user), refreshToken: newRefreshToken });
  });

  app.get('/company/get-by-user', authenticate, (req, res) => {
    const companies = queryAll(
      'SELECT c.id,c.name,c.identifier FROM companies c JOIN company_users cu ON cu.company_id = c.id WHERE cu.user_id = ?',
      [req.user.userId]
    );
    res.json(companies.map(company => ({
      ...company,
      icon: '/images/logo.svg',
    })));
  });

  app.get('/user/find-by-company', authenticate, requireCompany, (req, res) => {
    const users = queryAll(
      'SELECT u.id,u.name,u.email,u.role FROM users u JOIN company_users cu ON cu.user_id = u.id WHERE cu.company_id = ?',
      [req.companyId]
    );
    res.json(users);
  });

  app.post('/user/employee', authenticate, requireCompany, (req, res) => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Only owner may add employees' });
    }
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email and password are required' });
    }
    const existing = queryOne('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) {
      return res.status(400).json({ message: 'Email is already registered' });
    }
    const hash = bcrypt.hashSync(password, 10);
    run('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)', [name, email, hash, 'employee']);
    const userId = queryOne('SELECT last_insert_rowid() AS id').id;
    run('INSERT INTO company_users (company_id,user_id,role) VALUES (?,?,?)', [req.companyId, userId, 'employee']);
    persistDb();
    const user = queryOne('SELECT id,name,email,role FROM users WHERE id = ?', [userId]);
    res.json(user);
  });

  app.put('/user/employee/:id', authenticate, requireCompany, (req, res) => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Only owner may update employees' });
    }

    const userId = Number(req.params.id);
    const existingUser = queryOne(
      `SELECT u.id,u.name,u.email,u.password,u.role
       FROM users u
       JOIN company_users cu ON cu.user_id = u.id
       WHERE u.id = ? AND cu.company_id = ?`,
      [userId, req.companyId]
    );
    if (!existingUser) return res.status(404).json({ message: 'Employee not found' });

    const { name, email, password } = req.body;
    const normalizedEmail = email || existingUser.email;
    const emailOwner = queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [normalizedEmail, userId]);
    if (emailOwner) return res.status(400).json({ message: 'Email is already registered' });

    const passwordHash = password ? bcrypt.hashSync(password, 10) : existingUser.password;
    run(
      'UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?',
      [name || existingUser.name, normalizedEmail, passwordHash, userId]
    );
    persistDb();
    res.json(queryOne('SELECT id,name,email,role FROM users WHERE id = ?', [userId]));
  });

  app.delete('/user/employee/:id', authenticate, requireCompany, (req, res) => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ message: 'Only owner may remove employees' });
    }
    const userId = Number(req.params.id);
    if (!userId || userId === req.user.userId) {
      return res.status(400).json({ message: 'Invalid user' });
    }
    run('DELETE FROM company_users WHERE company_id = ? AND user_id = ?', [req.companyId, userId]);
    persistDb();
    res.json({ success: true });
  });

  app.get('/credit-card', authenticate, requireCompany, (req, res) => {
    const cards = queryAll('SELECT id,company_id,name,icon,fees FROM credit_cards WHERE company_id = ?', [req.companyId]);
    res.json(cards.map(enrichCreditCard));
  });

  app.post('/credit-card', authenticate, requireCompany, (req, res) => {
    const { name, icon, fees } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required' });
    run('INSERT INTO credit_cards (company_id,name,icon,fees) VALUES (?,?,?,?)', [req.companyId, name, icon || '', JSON.stringify(fees || [])]);
    const id = queryOne('SELECT last_insert_rowid() AS id').id;
    persistDb();
    const card = queryOne('SELECT id,company_id,name,icon,fees FROM credit_cards WHERE id = ?', [id]);
    res.json(enrichCreditCard(card));
  });

  app.put('/credit-cards/:id', authenticate, requireCompany, (req, res) => {
    const cardId = Number(req.params.id);
    const { name, icon, fees } = req.body;
    run('UPDATE credit_cards SET name = ?, icon = ?, fees = ? WHERE id = ? AND company_id = ?', [name, icon || '', JSON.stringify(fees || []), cardId, req.companyId]);
    const card = queryOne('SELECT id,company_id,name,icon,fees FROM credit_cards WHERE id = ? AND company_id = ?', [cardId, req.companyId]);
    if (!card) return res.status(404).json({ message: 'Credit card not found' });
    persistDb();
    res.json(enrichCreditCard(card));
  });

  app.delete('/credit-card/:id', authenticate, requireCompany, (req, res) => {
    const cardId = Number(req.params.id);
    run('DELETE FROM credit_cards WHERE id = ? AND company_id = ?', [cardId, req.companyId]);
    persistDb();
    res.json({ success: true });
  });

  app.get('/machines', authenticate, requireCompany, (req, res) => {
    const machines = queryAll('SELECT id,company_id,name,icon,installment_id,employees FROM machines WHERE company_id = ?', [req.companyId]);
    res.json(machines.map(enrichMachine));
  });

  app.post('/machines', authenticate, requireCompany, (req, res) => {
    const { name, icon, installmentId, employees } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required' });
    run('INSERT INTO machines (company_id,name,icon,installment_id,employees) VALUES (?,?,?,?,?)', [req.companyId, name, icon || '', installmentId || null, JSON.stringify(employees || [])]);
    const id = queryOne('SELECT last_insert_rowid() AS id').id;
    persistDb();
    const machine = queryOne('SELECT id,company_id,name,icon,installment_id,employees FROM machines WHERE id = ?', [id]);
    res.json(enrichMachine(machine));
  });

  app.put('/machines/:id', authenticate, requireCompany, (req, res) => {
    const machineId = Number(req.params.id);
    const { name, icon, installmentId, employees } = req.body;
    const existingMachine = queryOne(
      'SELECT name,icon,installment_id,employees FROM machines WHERE id = ? AND company_id = ?',
      [machineId, req.companyId]
    );
    if (!existingMachine) return res.status(404).json({ message: 'Machine not found' });

    run(
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
    const machine = queryOne('SELECT id,company_id,name,icon,installment_id,employees FROM machines WHERE id = ? AND company_id = ?', [machineId, req.companyId]);
    persistDb();
    res.json(enrichMachine(machine));
  });

  app.delete('/machines/:id', authenticate, requireCompany, (req, res) => {
    const machineId = Number(req.params.id);
    run('DELETE FROM machines WHERE id = ? AND company_id = ?', [machineId, req.companyId]);
    persistDb();
    res.json({ success: true });
  });

  app.get('/installments', authenticate, requireCompany, (req, res) => {
    const installments = queryAll('SELECT id,company_id,name,data FROM installments WHERE company_id = ?', [req.companyId]);
    res.json(installments.map(enrichInstallment));
  });

  app.post('/installments', authenticate, requireCompany, (req, res) => {
    const { name, data } = req.body;
    if (!name) return res.status(400).json({ message: 'name is required' });
    run('INSERT INTO installments (company_id,name,data) VALUES (?,?,?)', [req.companyId, name, JSON.stringify(normalizeInstallmentData(data))]);
    const id = queryOne('SELECT last_insert_rowid() AS id').id;
    persistDb();
    const installment = queryOne('SELECT id,company_id,name,data FROM installments WHERE id = ?', [id]);
    res.json(enrichInstallment(installment));
  });

  app.put('/installments/:id', authenticate, requireCompany, (req, res) => {
    const installmentId = Number(req.params.id);
    const { name, data } = req.body;
    run('UPDATE installments SET name = ?, data = ? WHERE id = ? AND company_id = ?', [name, JSON.stringify(normalizeInstallmentData(data)), installmentId, req.companyId]);
    const installment = queryOne('SELECT id,company_id,name,data FROM installments WHERE id = ? AND company_id = ?', [installmentId, req.companyId]);
    if (!installment) return res.status(404).json({ message: 'Installment not found' });
    persistDb();
    res.json(enrichInstallment(installment));
  });

  app.delete('/installments/:id', authenticate, requireCompany, (req, res) => {
    const installmentId = Number(req.params.id);
    run('DELETE FROM installments WHERE id = ? AND company_id = ?', [installmentId, req.companyId]);
    persistDb();
    res.json({ success: true });
  });

  app.post('/sale/simulation', authenticate, requireCompany, (req, res) => {
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

    const resolvedFees = resolveSimulationFees(
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

  app.get('/sale', authenticate, requireCompany, (req, res) => {
    res.json(getSales(req.companyId, req.query));
  });

  app.post('/sale', authenticate, requireCompany, (req, res) => {
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

    const resolvedInstallment = findInstallmentForNumber(
      req.companyId,
      installmentId,
      numInstallments
    );
    const parsedAmount = Number(amount) || 0;
    const parsedInstallments = Number(numInstallments) || 1;
    if (!creditCardId || !resolvedInstallment.installmentId || !machineId || !sellerId) {
      return res.status(400).json({ message: 'Missing sale required fields' });
    }

    run(
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
    const id = queryOne('SELECT last_insert_rowid() AS id').id;
    persistDb();
    const sale = queryOne('SELECT * FROM sales WHERE id = ?', [id]);
    return res.json(enrichSale(sale));
  });

  app.delete('/sale/:id', authenticate, requireCompany, (req, res) => {
    const saleId = Number(req.params.id);
    run('DELETE FROM sales WHERE id = ? AND company_id = ?', [saleId, req.companyId]);
    persistDb();
    res.json({ success: true });
  });

  app.get('/sale/sellers-rank', authenticate, requireCompany, (req, res) => {
    const sales = getSales(req.companyId, req.query);
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

  app.get('/sale/by-day-of-week', authenticate, requireCompany, (req, res) => {
    const sales = getSales(req.companyId, req.query);
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

  app.get('/sale/growth', authenticate, requireCompany, (req, res) => {
    const sales = getSales(req.companyId, req.query);
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

  app.get('/sale/by-period', authenticate, requireCompany, (req, res) => {
    const period = req.query.period || 'daily';
    const sales = getSales(req.companyId, req.query);
    res.json(groupSalesByPeriod(sales, period));
  });

  app.get('/sale/by-machine', authenticate, requireCompany, (req, res) => {
    const sales = getSales(req.companyId, req.query);
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

  app.get('/sale/by-installment', authenticate, requireCompany, (req, res) => {
    const sales = getSales(req.companyId, req.query);
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

  app.get('*', (req, res) => {
    const indexPath = path.join(STATIC_ROOT, 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
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
