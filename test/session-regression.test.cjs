const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const dbPath = path.join(__dirname, 'session-regression.db');
process.env.EASYCRED_DB_PATH = dbPath;
process.env.JWT_SECRET = 'session-regression-access-secret';
process.env.JWT_REFRESH_SECRET = 'session-regression-refresh-secret';
delete process.env.JWT_ACCESS_EXPIRES_IN;

const app = require('../server');

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
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const email = `session-${Date.now()}@example.test`;
    const registration = await request(baseUrl, '/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'Session Test', email, password: 'test-password' }),
    });

    assert.equal(registration.response.status, 200);
    assert.equal(jwt.decode(registration.body.accessToken).exp, undefined);

    const company = await request(baseUrl, '/company/get-by-user', {
      headers: { Authorization: `Bearer ${registration.body.accessToken}` },
    });
    assert.equal(company.response.status, 200);

    const refreshes = await Promise.all(
      Array.from({ length: 5 }, () => request(baseUrl, '/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: registration.body.refreshToken }),
      }))
    );

    refreshes.forEach(refresh => {
      assert.equal(refresh.response.status, 200);
      assert.equal(jwt.decode(refresh.body.accessToken).exp, undefined);
    });

    const invalidRefresh = await request(baseUrl, '/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: 'invalid' }),
    });
    assert.equal(invalidRefresh.response.status, 401);

    console.log('Session regression test passed.');
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
