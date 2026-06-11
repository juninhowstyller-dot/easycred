const assert = require('assert/strict');

const {
  extractMessageTextAndAction,
  parseCurrencyInput,
  parseMessage,
} = require('../whatsapp-bot');

assert.equal(parseCurrencyInput('1.500,00'), 1500);
assert.equal(parseCurrencyInput('3.000'), 3000);

assert.deepEqual(parseMessage('tenho 3 mil de limite quanto recebo?'), {
  amount: 3000,
  installments: undefined,
  type: 'limit',
});

assert.deepEqual(parseMessage('R$ 1.500,00 12 sem limite'), {
  amount: 1500,
  installments: 12,
  type: 'unleashed',
});

assert.deepEqual(parseMessage('simular 1000 em 10x limite'), {
  amount: 1000,
  installments: 10,
  type: 'limit',
});

assert.deepEqual(parseMessage('quero receber 2000 em 12 vezes'), {
  amount: 2000,
  installments: 12,
  type: 'unleashed',
});

assert.deepEqual(
  extractMessageTextAndAction({
    buttonsResponseMessage: {
      selectedButtonId: 'sim:amount:2000',
      selectedDisplayText: 'R$ 2.000',
    },
  }),
  {
    text: 'R$ 2.000',
    action: { field: 'amount', value: '2000' },
  }
);

console.log('WhatsApp bot regression test passed.');
