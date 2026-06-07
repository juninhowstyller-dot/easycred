const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function roundCurrency(value) {
  return +Number(value || 0).toFixed(2);
}

function formatCurrency(value) {
  return `R$ ${roundCurrency(value).toFixed(2).replace('.', ',')}`;
}

function toAbsolute(amount, fee) {
  const feeValue = Number(fee?.fee ?? fee?.value ?? 0) || 0;
  if ((fee?.unit || 'percentage') === 'percentage') {
    return roundCurrency(amount * feeValue / 100);
  }
  return roundCurrency(feeValue);
}

function calculateSimulation(amount, installments, type, creditCardFee, installmentFee) {
  const parsedAmount = Number(amount) || 0;
  const parsedInstallments = Number(installments) || 1;
  const simulationType = type || 'unleashed';
  const installmentAbsoluteFee = toAbsolute(parsedAmount, installmentFee);
  let creditCardAbsoluteFee;
  let total;

  if (simulationType === 'limit') {
    creditCardAbsoluteFee = toAbsolute(parsedAmount, creditCardFee);
    total = Math.max(0, parsedAmount - creditCardAbsoluteFee - installmentAbsoluteFee);
  } else if ((creditCardFee?.unit || 'percentage') === 'percentage') {
    const rate = (Number(creditCardFee?.fee ?? creditCardFee?.value ?? 0) || 0) / 100;
    total = rate >= 1
      ? parsedAmount + installmentAbsoluteFee
      : (parsedAmount + installmentAbsoluteFee) / (1 - rate);
    creditCardAbsoluteFee = total * rate;
  } else {
    creditCardAbsoluteFee = toAbsolute(parsedAmount, creditCardFee);
    total = parsedAmount + installmentAbsoluteFee + creditCardAbsoluteFee;
  }

  total = Math.round(roundCurrency(total));
  creditCardAbsoluteFee = roundCurrency(creditCardAbsoluteFee);

  return {
    amount: parsedAmount,
    installments: parsedInstallments,
    type: simulationType,
    total,
    installmentValue: roundCurrency(
      (simulationType === 'limit' ? parsedAmount : total) / parsedInstallments
    ),
    profit: roundCurrency(installmentAbsoluteFee),
    grossProfit: roundCurrency(
      simulationType === 'limit' ? parsedAmount - total : total - parsedAmount
    ),
    creditCardAbsoluteFee,
  };
}

function getFirstRow(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row || null);
    });
  });
}

async function getConfiguredFees(installments) {
  const db = new sqlite3.Database('./data.db');
  try {
    const card = await getFirstRow(db, 'SELECT name,fees FROM credit_cards ORDER BY id LIMIT 1');
    const installment = await getFirstRow(db, 'SELECT name,data FROM installments ORDER BY id LIMIT 1');
    if (!card) throw new Error('Nenhum cartao configurado.');
    if (!installment) throw new Error('Nenhum parcelamento configurado.');

    const cardFees = parseJson(card.fees, []);
    const installmentFees = parseJson(installment.data, []);
    const creditCardFee = cardFees.find(item => Number(item.installment) === installments)
      || { fee: 0, value: 0, unit: 'percentage' };
    const installmentFee = installmentFees.find(item => Number(item.installment) === installments)
      || { fee: 0, value: 0, unit: 'percentage' };

    return {
      cardName: card.name,
      installmentName: installment.name,
      creditCardFee: {
        fee: Number(creditCardFee.fee ?? creditCardFee.value ?? 0) || 0,
        unit: creditCardFee.unit || 'percentage',
      },
      installmentFee: {
        fee: Number(installmentFee.fee ?? installmentFee.value ?? 0) || 0,
        unit: installmentFee.unit || 'percentage',
      },
    };
  } finally {
    db.close();
  }
}

function parseMessage(text) {
  const normalized = String(text || '').toLowerCase().trim();
  const match = normalized.match(/(?:simular\s+)?(\d+(?:[.,]\d+)?)\s+(?:em\s+)?(\d+)x?(?:\s+(limite|com limite|sem limite))?/);
  if (!match) return null;

  const typeText = match[3] || '';
  return {
    amount: Number(match[1].replace(',', '.')),
    installments: Number(match[2]),
    type: typeText.includes('limite') && !typeText.includes('sem') ? 'limit' : 'unleashed',
  };
}

function menuText() {
  return [
    'Ola! Bem-vindo a Junior Cred.',
    '',
    'Para simular, envie assim:',
    'simular 1000 em 10x',
    'simular 1000 em 10x limite',
    '1000 10',
  ].join('\n');
}

function resultText(result, fees) {
  const lines = [
    result.type === 'limit' ? 'Simulacao com limite' : 'Simulacao sem limite',
    '',
  ];

  if (result.type === 'limit') {
    lines.push(`Valor liberado: ${formatCurrency(result.total)}`);
    lines.push(`Total a pagar: ${formatCurrency(result.amount)}`);
  } else {
    lines.push(`Valor solicitado: ${formatCurrency(result.amount)}`);
    lines.push(`Total a pagar: ${formatCurrency(result.total)}`);
  }

  lines.push(`Parcelas: ${result.installments}x`);
  lines.push(`Valor da parcela: ${formatCurrency(result.installmentValue)}`);
  lines.push('');
  lines.push(`Cartao: ${fees.cardName}`);
  lines.push(`Parcelamento: ${fees.installmentName}`);

  return lines.join('\n');
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
      const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (reconnect) startBot();
    }

    if (connection === 'open') {
      console.log('WhatsApp conectado.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      const normalizedText = text.toLowerCase();

      if (normalizedText === 'oi' || normalizedText === 'menu' || normalizedText === 'ajuda') {
        await sock.sendMessage(msg.key.remoteJid, { text: menuText() });
        return;
      }

      const simulation = parseMessage(text);
      if (!simulation) return;

      if (simulation.installments < 1 || simulation.installments > 18) {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Parcelas permitidas: 1x ate 18x.' });
        return;
      }

      const fees = await getConfiguredFees(simulation.installments);
      const result = calculateSimulation(
        simulation.amount,
        simulation.installments,
        simulation.type,
        fees.creditCardFee,
        fees.installmentFee
      );

      await sock.sendMessage(msg.key.remoteJid, {
        text: resultText(result, fees),
      });
    } catch (error) {
      console.error(error);
      await sock.sendMessage(messages[0].key.remoteJid, {
        text: 'Nao consegui simular agora. Tente novamente em instantes.',
      });
    }
  });
}

startBot();
