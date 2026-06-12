const assert = require('assert/strict');

const {
  buildCustomerContact,
  extractMessageTextAndAction,
  parseCurrencyInput,
  parseMessage,
  resultText,
  sendButtonMessage,
  textToActionForSession,
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

assert.deepEqual(parseMessage('18x'), {
  amount: undefined,
  installments: 18,
  type: undefined,
});

assert.deepEqual(parseMessage('1000 18x'), {
  amount: 1000,
  installments: 18,
  type: 'unleashed',
});

assert.deepEqual(parseMessage('tenho 3 mil de limite em 18x quanto recebo?'), {
  amount: 3000,
  installments: 18,
  type: 'limit',
});

assert.deepEqual(parseMessage('quero receber 2000 em 12 vezes'), {
  amount: 2000,
  installments: 12,
  type: 'unleashed',
});

assert.deepEqual(textToActionForSession({}, '1'), {
  field: 'type',
  value: 'limit',
});

assert.deepEqual(textToActionForSession({ type: 'limit' }, '2'), {
  field: 'amount',
  value: '2000',
});

assert.deepEqual(textToActionForSession({ type: 'limit', amount: 2000 }, '10'), {
  field: 'installments',
  value: '10',
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

const renderedResult = resultText({
  type: 'unleashed',
  amount: 1000,
  total: 1188,
  installments: 10,
  installmentValue: 118.8,
}, {
  cardName: 'Card',
  installmentName: '1-18x',
});

assert.equal(renderedResult.includes('Cartao:'), false);
assert.equal(renderedResult.includes('Parcelamento:'), false);

async function runAsyncChecks() {
  const contact = await buildCustomerContact({
    signalRepository: {
      lidMapping: {
        getPNForLID(jid) {
          assert.equal(jid, '123456789@lid');
          return Promise.resolve('5527999998888:0@s.whatsapp.net');
        },
      },
    },
  }, '123456789@lid', {
    messageKey: { remoteJid: '123456789@lid' },
    pushName: 'Cliente Teste',
  });

  assert.equal(contact.display, 'Cliente Teste - +5527999998888');
  assert.equal(contact.link, 'https://wa.me/5527999998888');

  const unresolvedContact = await buildCustomerContact({}, '12345678912345@lid', {
    messageKey: { remoteJid: '12345678912345@lid' },
  });

  assert.equal(unresolvedContact.display.includes('@lid'), false);
  assert.equal(unresolvedContact.display.includes('12345678912345'), false);

  const relayed = [];
  await sendButtonMessage({
    user: { id: 'bot@s.whatsapp.net' },
    relayMessage(jid, message, options) {
      relayed.push({ jid, message, options });
      return Promise.resolve();
    },
  }, 'customer@s.whatsapp.net', 'Escolha:', [
    { buttonId: 'sim:type:limit', buttonText: { displayText: 'Tenho limite' }, type: 1 },
  ]);

  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].jid, 'customer@s.whatsapp.net');
  assert.ok(relayed[0].message.buttonsMessage);
  assert.equal(relayed[0].message.buttonsMessage.buttons[0].buttonId, 'sim:type:limit');
  assert.ok(relayed[0].options.messageId);
}

runAsyncChecks().then(() => {
  console.log('WhatsApp bot regression test passed.');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
