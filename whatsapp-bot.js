require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.EASYCRED_DB_PATH || './data.db';
const WHATSAPP_AUTH_DIR = process.env.WHATSAPP_AUTH_DIR || 'auth_info';
const BOT_FOOTER = process.env.WHATSAPP_BOT_FOOTER || 'Junior Cred';
const DEFAULT_AMOUNT_PRESETS = [1000, 2000, 3000];
const DEFAULT_INSTALLMENT_PRESETS = [3, 6, 10, 12, 18];
const SESSION_TTL_MS = (Number(process.env.WHATSAPP_SESSION_TTL_MINUTES) || 30) * 60 * 1000;
const HUMAN_PAUSE_HOURS = process.env.WHATSAPP_HUMAN_PAUSE_HOURS == null
  ? 12
  : Number(process.env.WHATSAPP_HUMAN_PAUSE_HOURS);
const HUMAN_PAUSE_MS = Math.max(0, Number.isFinite(HUMAN_PAUSE_HOURS) ? HUMAN_PAUSE_HOURS : 12) * 60 * 60 * 1000;
const BOT_SENT_TTL_MS = 2 * 60 * 1000;

const pendingSessions = new Map();
const botSentMessages = new Map();
const seenGroupJids = new Set();
let dailyArtSock = null;
let dailyArtTimer = null;
let lastDailyArtDate = '';

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

function formatAmountButton(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
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

function getRows(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows || []);
    });
  });
}

function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

async function withDb(callback) {
  const db = new sqlite3.Database(DB_PATH);
  try {
    return await callback(db);
  } finally {
    db.close();
  }
}

async function ensurePauseTable(db) {
  await runSql(db, `
    CREATE TABLE IF NOT EXISTS whatsapp_human_pauses (
      jid TEXT PRIMARY KEY,
      paused_at TEXT NOT NULL,
      expires_at TEXT
    )
  `);
  const columns = await getRows(db, 'PRAGMA table_info(whatsapp_human_pauses)');
  if (!columns.some(column => column.name === 'expires_at')) {
    await runSql(db, 'ALTER TABLE whatsapp_human_pauses ADD COLUMN expires_at TEXT');
  }
}

async function pauseHumanChat(jid) {
  await withDb(async db => {
    await ensurePauseTable(db);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + HUMAN_PAUSE_MS);
    await runSql(
      db,
      'INSERT OR REPLACE INTO whatsapp_human_pauses (jid, paused_at, expires_at) VALUES (?, ?, ?)',
      [jid, now.toISOString(), expiresAt.toISOString()]
    );
  });
}

async function clearHumanPause(jid) {
  await withDb(async db => {
    await ensurePauseTable(db);
    await runSql(db, 'DELETE FROM whatsapp_human_pauses WHERE jid = ?', [jid]);
  });
}

async function getHumanPauseStatus(jid) {
  return withDb(async db => {
    await ensurePauseTable(db);
    const row = await getFirstRow(
      db,
      'SELECT paused_at, expires_at FROM whatsapp_human_pauses WHERE jid = ?',
      [jid]
    );
    if (!row) return { paused: false };

    const expiresAt = row.expires_at
      ? new Date(row.expires_at)
      : new Date(new Date(row.paused_at).getTime() + HUMAN_PAUSE_MS);

    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      await runSql(db, 'DELETE FROM whatsapp_human_pauses WHERE jid = ?', [jid]);
      return { paused: false };
    }

    return {
      paused: true,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

async function getConfiguredFees(installments) {
  return withDb(async db => {
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
  });
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function parseCurrencyInput(value) {
  const text = String(value || '').replace(/[^\d.,-]/g, '');
  if (!text) return 0;

  if (text.includes(',')) {
    return Number(text.replace(/\./g, '').replace(',', '.')) || 0;
  }

  if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) {
    return Number(text.replace(/\./g, '')) || 0;
  }

  return Number(text) || 0;
}

function parseAmountFromText(rawText) {
  const text = String(rawText || '');
  const normalized = normalizeText(text);
  const thousandMatch = normalized.match(/(\d+(?:[.,]\d+)?)\s*(mil|k)\b/);
  if (thousandMatch) {
    return roundCurrency(parseCurrencyInput(thousandMatch[1]) * 1000);
  }

  const currencyMatch = text.match(/(?:r\$\s*)?(\d[\d.,]*)/i);
  return currencyMatch ? parseCurrencyInput(currencyMatch[1]) : 0;
}

function parseInstallmentsFromText(rawText) {
  const normalized = normalizeText(rawText);
  const explicit = normalized.match(/\b(\d{1,2})\s*(x|vezes|parcelas?|prestacoes?)\b/);
  if (explicit) return Number.parseInt(explicit[1], 10);

  const afterEm = normalized.match(/\bem\s+(\d{1,2})\b/);
  if (afterEm) return Number.parseInt(afterEm[1], 10);

  const withoutCurrency = normalized.replace(/\d+(?:[.,]\d+)?\s*(mil|k)\b/g, '');
  const numbers = withoutCurrency.match(/\d[\d.,]*/g) || [];
  if (numbers.length >= 2) return Number.parseInt(numbers[1].replace(/[.,].*$/, ''), 10);

  return undefined;
}

function parseSimulationType(rawText) {
  const normalized = normalizeText(rawText);
  if (/\b(sem\s+limite|semlimite)\b/.test(normalized)) return 'unleashed';
  if (/\b(com\s+limite|limite|quanto\s+recebo|tenho)\b/.test(normalized)) return 'limit';
  if (/\b(quero\s+receber|preciso\s+de|valor\s+solicitado|sem\s+o\s+limite)\b/.test(normalized)) {
    return 'unleashed';
  }
  return undefined;
}

function parseMessage(text) {
  const amount = parseAmountFromText(text);
  const installments = parseInstallmentsFromText(text);
  const type = parseSimulationType(text) || (amount && installments ? 'unleashed' : undefined);

  if (!amount && !installments && !type) return null;

  return {
    amount: amount || undefined,
    installments,
    type,
  };
}

function parseList(value, fallback) {
  const parsed = String(value || '')
    .split(',')
    .map(item => Number(item.trim()))
    .filter(item => Number.isFinite(item) && item > 0);
  return parsed.length ? parsed : fallback;
}

function getAmountPresets() {
  return parseList(process.env.WHATSAPP_AMOUNT_PRESETS, DEFAULT_AMOUNT_PRESETS);
}

function getInstallmentPresets() {
  return parseList(process.env.WHATSAPP_INSTALLMENT_PRESETS, DEFAULT_INSTALLMENT_PRESETS)
    .filter(item => item >= 1 && item <= 18);
}

function isMenuRequest(text) {
  return /^(oi|ola|ol[aá]|menu|ajuda|simular|simulacao|simulação)$/i.test(String(text || '').trim());
}

function isStatusRequest(text) {
  return /^(status|teste|teste bot|bot status|ping)$/i.test(String(text || '').trim());
}

function looksLikeSimulationRequest(text) {
  const normalized = normalizeText(text);
  return /\d/.test(normalized)
    || /\b(simular|simulacao|limite|recebo|receber|dinheiro|emprestimo|parcelas?|vezes)\b/.test(normalized);
}

function menuText() {
  return [
    'Ola! Bem-vindo a Junior Cred.',
    '',
    'Escolha uma opcao para simular por botoes.',
    'Se preferir, pode escrever uma frase completa, tipo:',
    'tenho 3 mil de limite quanto recebo?',
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

function button(id, text) {
  return {
    buttonId: id,
    buttonText: { displayText: text },
    type: 1,
  };
}

function rememberBotMessage(jid, message) {
  const id = message?.key?.id;
  if (!id) return;

  botSentMessages.set(id, { jid, expiresAt: Date.now() + BOT_SENT_TTL_MS });
}

function pruneBotSentMessages() {
  const now = Date.now();
  for (const [id, info] of botSentMessages.entries()) {
    if (info.expiresAt <= now) botSentMessages.delete(id);
  }
}

async function sendBotMessage(sock, jid, content) {
  const message = await sock.sendMessage(jid, content);
  rememberBotMessage(jid, message);
  return message;
}

async function sendButtons(sock, jid, text, buttons, fallbackText) {
  const chunks = [];
  for (let index = 0; index < buttons.length; index += 3) {
    chunks.push(buttons.slice(index, index + 3));
  }

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      await sendBotMessage(sock, jid, {
        text: index === 0 ? text : 'Mais opcoes:',
        footer: BOT_FOOTER,
        buttons: chunks[index],
        headerType: 1,
      });
    }
  } catch (error) {
    console.error('WhatsApp buttons failed, sending text fallback:', error.message);
    await sendBotMessage(sock, jid, { text: fallbackText || text });
  }
}

async function sendSimulationMenu(sock, jid) {
  pendingSessions.delete(jid);
  await sendButtons(sock, jid, menuText(), [
    button('sim:type:limit', 'Tenho limite'),
    button('sim:type:unleashed', 'Quero valor'),
  ], [
    menuText(),
    '',
    'Responda com "tenho limite" ou "quero valor".',
  ].join('\n'));
}

async function askType(sock, jid) {
  await sendButtons(sock, jid, 'Voce quer simular como?', [
    button('sim:type:limit', 'Tenho limite'),
    button('sim:type:unleashed', 'Quero valor'),
  ], 'Voce quer simular com limite ou sem limite?');
}

async function askAmount(sock, jid) {
  const amounts = getAmountPresets();
  await sendButtons(
    sock,
    jid,
    'Escolha o valor:',
    amounts.map(amount => button(`sim:amount:${amount}`, formatAmountButton(amount))),
    `Digite um valor. Exemplos: ${amounts.join(', ')}`
  );
}

async function askInstallments(sock, jid) {
  const installments = getInstallmentPresets();
  await sendButtons(
    sock,
    jid,
    'Em quantas parcelas?',
    installments.map(item => button(`sim:installments:${item}`, `${item}x`)),
    `Digite a quantidade de parcelas. Exemplos: ${installments.map(item => `${item}x`).join(', ')}`
  );
}

function getSession(jid) {
  const now = Date.now();
  const current = pendingSessions.get(jid);
  if (current && now - current.updatedAt <= SESSION_TTL_MS) return current;

  const fresh = { updatedAt: now };
  pendingSessions.set(jid, fresh);
  return fresh;
}

function saveSession(jid, session) {
  pendingSessions.set(jid, { ...session, updatedAt: Date.now() });
}

function parseButtonAction(id) {
  const match = String(id || '').match(/^sim:(type|amount|installments):(.+)$/);
  if (!match) return null;

  return {
    field: match[1],
    value: match[2],
  };
}

function unwrapMessage(message) {
  return message?.ephemeralMessage?.message
    || message?.viewOnceMessage?.message
    || message?.documentWithCaptionMessage?.message
    || message;
}

function extractMessageTextAndAction(message) {
  const content = unwrapMessage(message);
  const buttonId = content?.buttonsResponseMessage?.selectedButtonId
    || content?.templateButtonReplyMessage?.selectedId
    || content?.listResponseMessage?.singleSelectReply?.selectedRowId;

  if (buttonId) {
    const displayText = content?.buttonsResponseMessage?.selectedDisplayText
      || content?.templateButtonReplyMessage?.selectedDisplayText
      || content?.listResponseMessage?.singleSelectReply?.title
      || '';
    return { text: displayText, action: parseButtonAction(buttonId) };
  }

  const nativeParams = content?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (nativeParams) {
    const parsed = parseJson(nativeParams, {});
    const id = parsed.id || parsed.button_id || parsed.selectedButtonId || parsed.row_id;
    if (id) return { text: parsed.title || parsed.name || '', action: parseButtonAction(id) };
  }

  return {
    text: (
      content?.conversation
      || content?.extendedTextMessage?.text
      || content?.imageMessage?.caption
      || content?.videoMessage?.caption
      || ''
    ).trim(),
    action: null,
  };
}

function applyActionToSession(session, action) {
  if (!action) return;
  if (action.field === 'type') session.type = action.value === 'limit' ? 'limit' : 'unleashed';
  if (action.field === 'amount') session.amount = Number(action.value) || undefined;
  if (action.field === 'installments') session.installments = Number(action.value) || undefined;
}

function applyParsedToSession(session, parsed) {
  if (!parsed) return;
  if (parsed.amount) session.amount = parsed.amount;
  if (parsed.installments) session.installments = parsed.installments;
  if (parsed.type) session.type = parsed.type;
}

async function finishOrAskNext(sock, jid, session) {
  saveSession(jid, session);

  if (!session.type) {
    await askType(sock, jid);
    return;
  }

  if (!session.amount || session.amount <= 0) {
    await askAmount(sock, jid);
    return;
  }

  if (!session.installments) {
    await askInstallments(sock, jid);
    return;
  }

  if (session.installments < 1 || session.installments > 18) {
    session.installments = undefined;
    saveSession(jid, session);
    await sendBotMessage(sock, jid, { text: 'Parcelas permitidas: 1x ate 18x.' });
    await askInstallments(sock, jid);
    return;
  }

  const fees = await getConfiguredFees(session.installments);
  const result = calculateSimulation(
    session.amount,
    session.installments,
    session.type,
    fees.creditCardFee,
    fees.installmentFee
  );

  pendingSessions.delete(jid);
  await sendBotMessage(sock, jid, { text: resultText(result, fees) });
}

async function handleCustomerMessage(sock, jid, text, action) {
  if (isStatusRequest(text)) {
    await sendBotMessage(sock, jid, {
      text: 'Bot online. Recebi sua mensagem e estou pronto para simular.',
    });
    return;
  }

  if (isMenuRequest(text)) {
    await sendSimulationMenu(sock, jid);
    return;
  }

  if (!action && !looksLikeSimulationRequest(text)) return;

  const session = getSession(jid);
  applyActionToSession(session, action);
  applyParsedToSession(session, parseMessage(text));
  await finishOrAskNext(sock, jid, session);
}

async function handleOwnerPrivateMessage(sock, jid, msg, text) {
  pruneBotSentMessages();
  if (botSentMessages.has(msg.key.id)) return;

  if (text) {
    pendingSessions.delete(jid);
    await pauseHumanChat(jid);
  }
}

function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}

function rememberGroupJid(jid) {
  if (!isGroupJid(jid) || seenGroupJids.has(jid)) return;
  seenGroupJids.add(jid);
  console.log(`Grupo detectado para WHATSAPP_DAILY_GROUP_JID: ${jid}`);
}

function parseScheduleTime(value) {
  const match = String(value || '09:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 9, minute: 0 };
  return {
    hour: Math.min(23, Number(match[1]) || 0),
    minute: Math.min(59, Number(match[2]) || 0),
  };
}

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildDailyArtContent() {
  const source = String(process.env.WHATSAPP_DAILY_ART_PATH || '').trim();
  if (!source) return null;

  const caption = process.env.WHATSAPP_DAILY_ART_CAPTION || '';
  if (/^https?:\/\//i.test(source)) {
    return { image: { url: source }, caption };
  }

  const resolvedPath = path.resolve(process.cwd(), source);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Arte nao encontrada: ${resolvedPath}`);
  }

  return { image: fs.readFileSync(resolvedPath), caption };
}

async function maybeSendDailyArt() {
  const groupJid = String(process.env.WHATSAPP_DAILY_GROUP_JID || '').trim();
  if (!dailyArtSock || !groupJid) return;

  const now = new Date();
  const scheduled = parseScheduleTime(process.env.WHATSAPP_DAILY_ART_TIME);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const scheduledMinutes = scheduled.hour * 60 + scheduled.minute;
  const today = dateKey(now);

  if (currentMinutes < scheduledMinutes || lastDailyArtDate === today) return;

  try {
    const content = buildDailyArtContent();
    if (!content) return;

    await sendBotMessage(dailyArtSock, groupJid, content);
    lastDailyArtDate = today;
    console.log(`Arte diaria enviada para ${groupJid}.`);
  } catch (error) {
    lastDailyArtDate = today;
    console.error(`Falha ao enviar arte diaria: ${error.message}`);
  }
}

function startDailyArtScheduler(sock) {
  dailyArtSock = sock;
  if (dailyArtTimer) return;
  if (!process.env.WHATSAPP_DAILY_GROUP_JID || !process.env.WHATSAPP_DAILY_ART_PATH) return;

  dailyArtTimer = setInterval(() => {
    maybeSendDailyArt().catch(error => {
      console.error(`Falha no agendamento da arte: ${error.message}`);
    });
  }, 60 * 1000);
  dailyArtTimer.unref?.();
  maybeSendDailyArt().catch(error => {
    console.error(`Falha no agendamento da arte: ${error.message}`);
  });
}

async function startBot() {
  console.log(`Iniciando WhatsApp bot. DB=${DB_PATH} AUTH=${WHATSAPP_AUTH_DIR}`);
  const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);
  const sock = makeWASocket({ auth: state });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
      const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`WhatsApp desconectado. Reconectar=${reconnect}`);
      if (reconnect) startBot();
    }

    if (connection === 'open') {
      console.log(`WhatsApp conectado como ${sock.user?.id || 'numero desconhecido'}.`);
      startDailyArtScheduler(sock);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    try {
      console.log(`Evento messages.upsert recebido com ${messages.length} mensagem(ns).`);
      if (!msg?.message) {
        console.log('Evento ignorado: mensagem sem conteudo.');
        return;
      }

      const jid = msg.key.remoteJid;
      const isGroup = isGroupJid(jid);
      const { text, action } = extractMessageTextAndAction(msg.message);

      console.log(`Mensagem bruta: jid=${jid} fromMe=${Boolean(msg.key.fromMe)} tipo=${Object.keys(msg.message).join(',')}`);

      if (msg.key.fromMe) {
        if (text) console.log(`Mensagem enviada por voce em ${jid}; pausando atendimento humano.`);
        if (!isGroup) await handleOwnerPrivateMessage(sock, jid, msg, text);
        return;
      }

      if (isGroup) {
        rememberGroupJid(jid);
        return;
      }

      if (isStatusRequest(text)) {
        console.log(`Teste de status recebido em ${jid}.`);
        await handleCustomerMessage(sock, jid, text, action);
        return;
      }

      const pauseStatus = await getHumanPauseStatus(jid);
      if (pauseStatus.paused) {
        console.log(`Mensagem ignorada em ${jid}: atendimento humano pausado ate ${pauseStatus.expiresAt}.`);
        return;
      }

      console.log(`Mensagem recebida em ${jid}: ${text || '[sem texto]'}${action ? ` (${action.field}:${action.value})` : ''}`);
      await handleCustomerMessage(sock, jid, text, action);
    } catch (error) {
      console.error(error);
      const jid = msg?.key?.remoteJid;
      if (jid && !isGroupJid(jid)) {
        await sendBotMessage(sock, jid, {
          text: 'Nao consegui simular agora. Tente novamente em instantes.',
        });
      }
    }
  });
}

if (require.main === module) {
  startBot().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  calculateSimulation,
  extractMessageTextAndAction,
  parseCurrencyInput,
  parseMessage,
  parseSimulationType,
  resultText,
  startBot,
};
