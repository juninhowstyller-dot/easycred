const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'vercel-storage-regression.db');
process.env.EASYCRED_DB_PATH = dbPath;
process.env.VERCEL = '1';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;

if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const app = require('../server');

async function run() {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/installments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Should not save', data: [] }),
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.match(body.message, /DATABASE_URL|POSTGRES_URL/);
    console.log('Vercel storage regression test passed.');
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
