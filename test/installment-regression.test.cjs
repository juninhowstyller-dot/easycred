const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(__dirname, 'installment-regression.db');
process.env.EASYCRED_DB_PATH = dbPath;
process.env.JWT_SECRET = 'installment-regression-access-secret';
process.env.JWT_REFRESH_SECRET = 'installment-regression-refresh-secret';

if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

function loadApp() {
  const serverPath = require.resolve('../server');
  delete require.cache[serverPath];
  return require('../server');
}

function decodeToken(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

async function run() {
  const email = `installment-${Date.now()}@example.test`;
  const password = 'test-password';
  let app = loadApp();
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const registration = await request(baseUrl, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Installment Test',
        email,
        password,
      }),
    });
    assert.equal(registration.response.status, 200);

    const headers = { Authorization: `Bearer ${registration.body.accessToken}` };
    const initial = await request(baseUrl, '/installments', { headers });
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.length, 1);
    assert.equal(initial.body[0].data.length, 18);
    assert.deepEqual(
      initial.body[0].data.map(item => item.value),
      Array.from({ length: 18 }, () => 0)
    );

    const installment = initial.body[0];
    installment.data[1].value = 12.34;
    installment.data[9].value = 18.75;

    const update = await request(baseUrl, `/installments/${installment.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(installment),
    });
    assert.equal(update.response.status, 200);
    assert.equal(update.body.data[1].value, 12.34);
    assert.equal(update.body.data[9].value, 18.75);

    const reloaded = await request(baseUrl, '/installments', { headers });
    assert.equal(reloaded.body[0].data[1].value, 12.34);
    assert.equal(reloaded.body[0].data[9].value, 18.75);

    const [machines, creditCards] = await Promise.all([
      request(baseUrl, '/machines', { headers }),
      request(baseUrl, '/credit-card', { headers }),
    ]);

    const simulation = await request(baseUrl, '/sale/simulation', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        amount: 1000,
        numInstallments: 10,
        type: 'unleashed',
        creditCardId: creditCards.body[0].id,
        installmentId: machines.body[0].installmentId,
        machineId: machines.body[0].id,
        sellerId: decodeToken(registration.body.accessToken).userId,
      }),
    });
    assert.equal(simulation.response.status, 200);
    assert.equal(simulation.body.appliedInstallmentFee.fee, 18.75);
    assert.equal(simulation.body.total, 1187.5);
    assert.equal(simulation.body.installmentValue, 118.75);

    const simulationWithoutCard = await request(baseUrl, '/sale/simulation', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        amount: 1000,
        numInstallments: 10,
        type: 'unleashed',
        installmentId: installment.id,
      }),
    });
    assert.equal(simulationWithoutCard.response.status, 200);
    assert.equal(simulationWithoutCard.body.appliedCreditCardFee.fee, 0);
    assert.equal(simulationWithoutCard.body.appliedInstallmentFee.fee, 18.75);
    assert.equal(simulationWithoutCard.body.total, 1187.5);

    const staleDuplicate = await request(baseUrl, '/installments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Legacy duplicate',
        data: [
          { installment: 10, value: 0, unit: 'percentage' },
        ],
      }),
    });
    assert.equal(staleDuplicate.response.status, 200);

    const SQL = await initSqlJs();
    const persistedDb = new SQL.Database(fs.readFileSync(dbPath));
    const persisted = persistedDb.exec(
      `SELECT data FROM installments WHERE id = ${Number(installment.id)}`
    )[0].values[0][0];
    persistedDb.close();

    const persistedData = JSON.parse(persisted);
    assert.equal(persistedData[1].value, 12.34);
    assert.equal(persistedData[9].value, 18.75);

    await new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });

    app = loadApp();
    const restartedServer = await new Promise(resolve => {
      const instance = app.listen(0, () => resolve(instance));
    });
    const restartedBaseUrl = `http://127.0.0.1:${restartedServer.address().port}`;

    try {
      const login = await request(restartedBaseUrl, '/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      assert.equal(login.response.status, 200);

      const restartedHeaders = { Authorization: `Bearer ${login.body.accessToken}` };
      const restartedInstallments = await request(restartedBaseUrl, '/installments', {
        headers: restartedHeaders,
      });
      assert.equal(restartedInstallments.response.status, 200);
      assert.equal(restartedInstallments.body.length, 1);
      assert.equal(restartedInstallments.body[0].data[1].value, 12.34);
      assert.equal(restartedInstallments.body[0].data[9].value, 18.75);

      const restartedMachines = await request(restartedBaseUrl, '/machines', {
        headers: restartedHeaders,
      });
      assert.equal(
        restartedMachines.body[0].installmentId,
        restartedInstallments.body[0].id
      );
    } finally {
      await new Promise((resolve, reject) => {
        restartedServer.close(error => (error ? reject(error) : resolve()));
      });
    }

    console.log('Installment regression test passed.');
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
