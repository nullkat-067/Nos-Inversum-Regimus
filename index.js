import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, 'config/config.json');
const TARGETS_PATH = path.join(ROOT, 'data/targets.json');
const AUDIT_PATH = path.join(ROOT, 'data/audit.log');
const SESSIONS_PATH = path.join(ROOT, 'sessions');
const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
const GROUP_NAME_TEMPLATE = '𖤐 𝐊𝐔𝐃𝐄𝐓𝐀 𝐁𝐘 𝐍𝐔𝐋𝐋𝐊𝟒𝐓 𝐃𝐄𝐕𝐄𝐋𝐎𝐏𝐌𝐄𝐍𝐓😹';

const required = ['botName', 'codename', 'organization', 'developer', 'coDeveloper', 'version', 'commandPrefix'];
const errors = required.filter(key => typeof config[key] !== 'string' || !config[key].trim());
if (config.commandPrefix.length !== 1) errors.push('commandPrefix must be one character');
if (!Number.isInteger(config.maxConcurrentOperations) || config.maxConcurrentOperations < 1) errors.push('maxConcurrentOperations must be positive');
if (errors.length) throw new Error(`Invalid configuration:\n${errors.map(error => `- ${error}`).join('\n')}`);

const PROTECTED_NUMBERS = ['6285194590937'];
const PP_PATH = path.join(ROOT, 'data/pp.jpg');

const color = config.terminalColors !== false;
const paint = (code, value) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
const RED = value => paint(31, value), BRIGHT_RED = value => paint(91, value), VIOLET = value => paint(35, value), CYAN = value => paint(36, value), GREEN = value => paint(32, value), YELLOW = value => paint(33, value), GRAY = value => paint(90, value), BOLD = value => paint(1, value);

let targets = [];
let socket = null;
let state = null;
let saveCreds = null;
let connection = 'OFFLINE';
let pairingNumber = null;
let reconnectTimer = null;
let shuttingDown = false;
let operationBusy = false;
let pairingWaiter = null;
const baileysLogger = pino({ level: 'silent' });
const OPERATION_NAMES = {
  1: 'GROUP ADMIN AUDIT',
  2: 'MEMBER MANAGEMENT',
  3: 'SWITCH GROUP NAME',
  4: 'LOCK / UNLOCK GROUP',
  5: 'ADMIN MANAGEMENT AUDIT',
  6: 'FULL SECURITY AUDIT',
  9: 'DEMOTE ALL ADMINS',
  10: 'SPAM LOCK / UNLOCK',
  12: 'SET PROFILE PICTURE',
  13: 'SPAM MESSAGE'
};
async function notifyGroup(id, text) {
  try { if (socket && connection === 'ONLINE') await socket.sendMessage(id, { text }); } catch {}
}
const metaCache = new Map();
const META_TTL = 20000;
async function getMetadata(id) {
  const hit = metaCache.get(id);
  if (hit && Date.now() - hit.ts < META_TTL) return hit.data;
  const data = await socket.groupMetadata(id);
  metaCache.set(id, { data, ts: Date.now() });
  return data;
}
function invalidateCache(id) { metaCache.delete(id); }

const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const numberOf = jid => String(jid || '').split(':')[0].split('@')[0];
const isGroupId = jid => /^\d+-\d+@g\.us$/.test(String(jid || ''));
const isAdmin = participant => participant?.admin === 'admin' || participant?.admin === 'superadmin';
const groupMessage = message => message?.key?.remoteJid?.endsWith('@g.us') === true;
const senderOf = message => message?.key?.participant || message?.key?.remoteJid || '';
const textOf = message => { const body = message?.message?.ephemeralMessage?.message || message?.message?.viewOnceMessage?.message || message?.message || {}; return body.conversation || body.extendedTextMessage?.text || body.imageMessage?.caption || ''; };
const botNumber = () => numberOf(socket?.user?.id);
const idsOf = participant => [participant?.id, participant?.lid, participant?.phoneNumber, participant?.jid].filter(Boolean).map(numberOf);
const findBot = metadata => { const mine = [socket?.user?.id, socket?.user?.lid].filter(Boolean).map(numberOf); return metadata.participants.find(participant => idsOf(participant).some(id => mine.includes(id))); };
const findSender = (metadata, message) => { const senders = [message?.key?.participant, message?.key?.participantAlt, message?.participant].filter(Boolean).map(numberOf); return metadata.participants.find(participant => idsOf(participant).some(id => senders.includes(id))); };

function waitForConnection(timeoutMs = 120000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { pairingWaiter = null; resolve('TIMEOUT'); }, timeoutMs);
    pairingWaiter = result => { clearTimeout(timer); pairingWaiter = null; resolve(result); };
  });
}

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}
async function loadTargets() { try { const value = JSON.parse(await fs.readFile(TARGETS_PATH, 'utf8')); if (!Array.isArray(value)) throw new Error('targets.json must be an array'); return value; } catch (error) { if (error.code === 'ENOENT') { await atomicWrite(TARGETS_PATH, []); return []; } throw error; } }
async function audit(event, details = {}) { const safe = JSON.stringify(details, (key, value) => /secret|token|auth|password|code/i.test(key) ? '[REDACTED]' : value); await fs.appendFile(AUDIT_PATH, `${now()} [AUDIT] ${event} ${safe}\n`, { mode: 0o600 }); }
function log(level, message) { const fn = level === 'ERROR' ? RED : level === 'WARN' ? YELLOW : CYAN; console.log(`${GRAY(now())} ${fn(`[${level}]`)} ${message}`); }

function showBanner() {
  console.clear();
  console.log(RED('╔══════════════════════════════════╗'));
  console.log(RED('║      NOS INVERNUS SENTINEL       ║'));
  console.log(RED('║      SUPREME COMMAND UNIT        ║'));
  console.log(RED('╠══════════════════════════════════╣'));
  console.log(RED('║ CODENAME : NK-T1                 ║'));
  console.log(RED('║ DIVISION : CYBER SYSTEMS         ║'));
  console.log(RED('║ CLASS    : TACTICAL              ║'));
  console.log(RED('║ DEVELOPER: NULLKAT DEVELOPMENT   ║'));
  console.log(RED('║ STATUS   : OPERATIONAL           ║'));
  console.log(RED('╚══════════════════════════════════╝'));
  console.log(`${VIOLET('VERSION')} ${config.version} ${GRAY('|')} ${connection === 'ONLINE' ? GREEN('CONNECTION ONLINE') : YELLOW(`CONNECTION ${connection}`)} ${GRAY('|')} TARGETS ${CYAN(targets.length.toString())}\n`);
}
function showMenu() {
  console.log(VIOLET('╔══════════════════════════════════╗'));
  console.log(VIOLET('║       SENTINEL CONTROL PANEL     ║'));
  console.log(VIOLET('╠══════════════════════════════════╣'));
  console.log(VIOLET('║ [1] GROUP ADMIN AUDIT            ║'));
  console.log(VIOLET('║ [2] MEMBER MANAGEMENT            ║'));
  console.log(VIOLET('║ [3] SWITCH GROUP NAME            ║'));
  console.log(VIOLET('║ [4] LOCK / UNLOCK GROUP          ║'));
  console.log(VIOLET('║ [5] ADMIN MANAGEMENT AUDIT       ║'));
  console.log(VIOLET('║ [6] FULL SECURITY AUDIT          ║'));
  console.log(VIOLET('║ [7] PAIRING CODE                 ║'));
  console.log(VIOLET('║ [8] CREDITS                      ║'));
  console.log(VIOLET('║ [9] DEMOTE ALL ADMINS            ║'));
  console.log(VIOLET('║ [10] SPAM LOCK / UNLOCK GROUP    ║'));
  console.log(VIOLET('║ [11] COMBINE OPERATIONS          ║'));
  console.log(VIOLET('║ [12] SET GROUP PROFILE PICTURE   ║'));
  console.log(VIOLET('║ [13] SPAM MESSAGE                ║'));
  console.log(VIOLET('║ [0] EXIT                         ║'));
  console.log(VIOLET('╚══════════════════════════════════╝'));
}
async function ask(rl, prompt) { return (await rl.question(prompt)).trim(); }
async function confirm(rl, description) { console.log(`\n${YELLOW(description)}`); while (true) { const answer = (await ask(rl, `${BRIGHT_RED('CONFIRM')} ${GRAY('(y/n)')}: `)).toLowerCase(); if (answer === 'y') return true; if (answer === 'n') return false; console.log(YELLOW('Answer only y or n.')); } }
async function confirmForOperation(rl, description, autoConfirm = false) { if (autoConfirm) return true; return confirm(rl, description); }
async function chooseTarget(rl) { if (!targets.length) { console.log(YELLOW('No registered targets yet.')); return null; } targets.forEach((target, index) => console.log(`${CYAN(`[${index + 1}]`)} ${target.name} ${GRAY(`(${target.id})`)}`)); const choice = Number(await ask(rl, 'TARGET> ')); if (!Number.isInteger(choice) || choice < 1 || choice > targets.length) { console.log(RED('Invalid target.')); return null; } return targets[choice - 1]; }

async function processCommand(message) {
  if (!socket || !groupMessage(message)) return;
  const text = textOf(message).trim();
  if (!text.startsWith(config.commandPrefix)) return;
  const command = text.slice(config.commandPrefix.length).toLowerCase();
  if (!['add target', 'remove target', 'list targets', 'target info'].includes(command)) return;
  const id = message.key.remoteJid;
  let metadata;
  try { metadata = await getMetadata(id); } catch (error) { log('ERROR', `Metadata failed: ${error.message}`); return; }
  const operator = findSender(metadata, message);
  if (command === 'list targets') return socket.sendMessage(id, { text: targets.map(target => `${target.name} — ${target.id}`).join('\n') || 'No registered targets.' });
  if (command === 'target info') { const target = targets.find(item => item.id === id); return socket.sendMessage(id, { text: target ? JSON.stringify(target, null, 2) : 'This group is not registered.' }); }
  if (!isAdmin(operator)) return socket.sendMessage(id, { text: 'Authorization denied: administrator permission required.' });
  if (command === 'add target') {
    const bot = findBot(metadata);
    if (!isAdmin(bot)) return socket.sendMessage(id, { text: 'Authorization denied: bot must be a group administrator.' });
    const existing = targets.find(target => target.id === id);
    if (existing) existing.name = metadata.subject;
    else targets.push({ id, name: metadata.subject, registeredAt: now(), registeredBy: senderOf(message) });
    await atomicWrite(TARGETS_PATH, targets); await audit(existing ? 'target refreshed' : 'target registered', { id });
    invalidateCache(id);
    return socket.sendMessage(id, { text: 'Added, Commander!' });
  }
  targets = targets.filter(target => target.id !== id);
  await atomicWrite(TARGETS_PATH, targets); await audit('target removed', { id });
  invalidateCache(id);
  return socket.sendMessage(id, { text: 'Target removed.' });
}

async function startConnection(phone) {
  if (connection === 'ONLINE' || connection === 'CONNECTING') { console.log(YELLOW('Connection is already running.')); return; }
  pairingNumber = phone;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) { try { socket.ev.removeAllListeners(); socket.end(undefined); } catch {} socket = null; }
  connection = 'CONNECTING';

  const auth = await useMultiFileAuthState(SESSIONS_PATH);
  state = auth.state; saveCreds = auth.saveCreds;
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
    logger: baileysLogger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  socket = sock;

  let codeRequested = false;
  const requestCode = async () => {
    if (codeRequested || !phone || sock.authState.creds.registered) return;
    codeRequested = true;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await sleep(attempt === 1 ? 500 : 2000);
        const raw = await sock.requestPairingCode(phone);
        const code = raw.match(/.{1,4}/g)?.join('-') || raw;
        console.log(`\n${GREEN('PAIRING CODE:')} ${BOLD(code)}`);
        console.log(CYAN('Enter it immediately in WhatsApp:'));
        console.log(GRAY('Settings → Linked Devices → Link a Device → Link with phone number instead\n'));
        await audit('pairing code generated');
        return;
      } catch (error) {
        log('WARN', `Pairing code failed (attempt ${attempt}/3): ${error.message}`);
      }
    }
    connection = 'PAIRING_FAILED';
    log('ERROR', 'Pairing code failed three times. Delete the sessions/ folder and try again.');
    pairingWaiter?.('FAILED');
  };

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) { try { await processCommand(message); } catch (error) { log('ERROR', `Command failed: ${error.message}`); } }
  });
  sock.ev.on('connection.update', async ({ connection: status, qr, lastDisconnect }) => {
    if (sock !== socket) return;
    if (status === 'connecting') log('INFO', 'Connection connecting');
    if (qr) requestCode();
    if (status === 'open') {
      connection = 'ONLINE';
      log('INFO', 'Connection open — pairing completed.');
      console.log(GREEN('\n[ ONLINE ] WhatsApp connected successfully.\n'));
      pairingWaiter?.('ONLINE');
    }
    if (status === 'close' && !shuttingDown) {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      connection = 'OFFLINE';
      log('WARN', `Connection closed (${statusCode || 'unknown'})`);
      if (loggedOut) {
        await fs.rm(SESSIONS_PATH, { recursive: true, force: true });
        console.log(RED('Session rejected; the sessions folder was deleted. Choose menu 7 again.'));
        pairingWaiter?.('FAILED');
        return;
      }
      const restartRequired = statusCode === DisconnectReason.restartRequired;
      if (!sock.authState.creds.registered && !restartRequired) {
        console.log(RED('Pairing failed or the code expired. Automatic reconnect is disabled so the code does not change. Choose menu 7 again.'));
        pairingWaiter?.('FAILED');
        return;
      }
      if (!reconnectTimer) {
        console.log(YELLOW('Retrying connection in 3 seconds...'));
        reconnectTimer = setTimeout(() => { reconnectTimer = null; startConnection(pairingNumber).catch(error => log('ERROR', error.message)); }, 3000);
      }
    }
  });

  // Fallback in case the qr event is delayed
  if (phone && !sock.authState.creds.registered) setTimeout(requestCode, 3000);
}

async function runOperation(rl, choice, target, autoConfirm = false) {
  if (!socket || connection !== 'ONLINE') throw new Error('WhatsApp is not ONLINE. Run menu 7 first.');
  const opName = OPERATION_NAMES[choice] || `OPERASI ${choice}`;
  const metadata = await getMetadata(target.id);
  const bot = findBot(metadata);
  const admins = metadata.participants.filter(isAdmin).map(participant => ({ id: participant.id, role: participant.admin }));
  if ([3, 4].includes(choice) && !isAdmin(bot)) throw new Error('The bot is not a group administrator.');
  if ([1, 5, 6].includes(choice)) {
    const info = { id: target.id, name: metadata.subject, participants: metadata.participants.length, administrators: admins, botRole: bot?.admin || 'member', announce: metadata.announce ?? null, restrict: metadata.restrict ?? null };
    console.dir({ ...info, connection }, { depth: null });
    await notifyGroup(target.id, `Member: ${info.participants}, Admin: ${admins.length}, Bot: ${info.botRole}, Locked: ${info.announce ? 'yes' : 'no'}`);
  }
  if (choice === 2) {
    const list = metadata.participants.map(p => `${p.id} — ${p.admin || 'member'}`).join('\n');
    console.log(list);
    await notifyGroup(target.id, `Total member: ${metadata.participants.length}`);
  }
  if (choice === 3) { const nextName = GROUP_NAME_TEMPLATE; if (await confirmForOperation(rl, `SWITCH GROUP NAME\nCurrent: ${metadata.subject}\nProposed: ${nextName}`, autoConfirm)) { await socket.groupUpdateSubject(target.id, nextName); await audit('group renamed', { id: target.id }); console.log(GREEN('Rename successful.')); await notifyGroup(target.id, `Group name changed to: ${nextName}`); } }
  if (choice === 4) { const current = metadata.announce ? 'admins only' : 'all participants'; const next = metadata.announce ? 'all participants' : 'admins only'; if (await confirmForOperation(rl, `GROUP SETTING\nCurrent: ${current}\nRequested: ${next}`, autoConfirm)) { await socket.groupSettingUpdate(target.id, next === 'admins only' ? 'announcement' : 'not_announcement'); await audit('group setting changed', { id: target.id, next }); invalidateCache(target.id); console.log(GREEN('Group setting changed successfully.')); await notifyGroup(target.id, next === 'admins only' ? '🔒' : '🔓'); } }
  if (choice === 13) {
    const rawMsg = await rl.question(`${CYAN('Message to send: ')}`);
    const msg = rawMsg.trim();
    if (!msg) { console.log(RED('Message cannot be empty.')); return; }
    const rawTimes = await rl.question(`${CYAN('How many times to send? ')}`);
    const times = parseInt(rawTimes.trim(), 10);
    if (!Number.isInteger(times) || times < 1 || times > 1000) { console.log(RED('Enter a number between 1 and 1000.')); return; }
    const rawDelay = await rl.question(`${CYAN('Message delay (ms, minimum 300): ')}`);
    const delay = Math.max(300, parseInt(rawDelay.trim(), 10) || 500);
    if (!await confirmForOperation(rl, `SPAM MESSAGE\nGroup : ${metadata.subject}\nMessage: ${msg}\nCount: ${times}x\nDelay : ${delay}ms`, autoConfirm)) return;
    console.log(YELLOW(`\nStarting spam ${times}x messages...\n`));
    let sent = 0, failed = 0;
    for (let i = 1; i <= times; i++) {
      try {
        await socket.sendMessage(target.id, { text: msg });
        sent++;
        process.stdout.write(`\r[${CYAN(String(i).padStart(String(times).length))}/${times}] Sent: ${GREEN(String(sent))} Failed: ${RED(String(failed))}`);
      } catch (error) {
        failed++;
        process.stdout.write(`\r[${i}/${times}] Sent: ${GREEN(String(sent))} Failed: ${RED(String(failed))}`);
      }
      if (i < times) await sleep(delay);
    }
    console.log(`\n${GREEN(`\nCompleted! ${sent}/${times} messages sent.`)}`);
    await audit('spam message', { id: target.id, times, sent, failed, delay });
    return;
  }
  if (choice === 12) {
    if (!isAdmin(bot)) throw new Error('The bot is not a group administrator.');
    let imgPath = PP_PATH;
    try { await fs.access(imgPath); } catch {
      const custom = await rl.question(`${CYAN('pp.jpg was not found. Enter the image path: ')}`);
      imgPath = custom.trim();
      try { await fs.access(imgPath); } catch { throw new Error(`File not found: ${imgPath}`); }
    }
    if (await confirmForOperation(rl, `SET PROFILE PICTURE\nGroup : ${metadata.subject}\nFile : ${imgPath}`, autoConfirm)) {
      let buffer = await fs.readFile(imgPath);
      try {
        const { Jimp } = await import('jimp');
        const img = await Jimp.read(buffer);
        img.resize({ w: 640, h: 640 });
        buffer = await img.getBuffer('image/jpeg');
        log('INFO', 'Image processed with jimp.');
      } catch (jimpErr) {
        log('WARN', `jimp is unavailable or failed (${jimpErr.message}), trying a raw upload...`);
      }
      await socket.updateProfilePicture(target.id, buffer);
      await audit('set group profile picture', { id: target.id, file: imgPath });
      console.log(GREEN('Group profile picture updated successfully!'));
      await notifyGroup(target.id, '📸');
    }
  }
  if (choice === 10) {
    if (!isAdmin(bot)) throw new Error('The bot is not a group administrator.');
    const rawTimes = await rl.question(`${CYAN('Berapa kali buka/tutup? ')}> `);
    const times = parseInt(rawTimes.trim(), 10);
    if (!Number.isInteger(times) || times < 1 || times > 500) { console.log(RED('Enter a number between 1 and 500.')); return; }
    const rawDelay = await rl.question(`${CYAN('Delay antar toggle (ms, min 100)? ')}> `);
    const delay = Math.max(100, parseInt(rawDelay.trim(), 10) || 300);
    if (!await confirmForOperation(rl, `SPAM LOCK/UNLOCK\nGroup : ${metadata.subject}\nCount: ${times}x\nDelay : ${delay}ms`, autoConfirm)) return;
    console.log(YELLOW(`\nStarting spam ${times}x with delay ${delay}ms...\n`));
    let current = metadata.announce;
    const notifyEvery = Math.max(1, Math.floor(times / 5));
    for (let i = 1; i <= times; i++) {
      const next = current ? 'not_announcement' : 'announcement';
      const label = next === 'announcement' ? RED('LOCKED  ') : GREEN('UNLOCKED');
      try {
        await socket.groupSettingUpdate(target.id, next);
        current = !current;
        process.stdout.write(`\r[${CYAN(String(i).padStart(String(times).length))}/${times}] ${label}`);
        if (i === 1 || i % notifyEvery === 0 || i === times) {
          await notifyGroup(target.id, next === 'announcement' ? '🔒' : '🔓');
        }
      } catch (error) {
        process.stdout.write(`\r[${i}/${times}] ${RED('GAGAL')} — ${error.message}\n`);
      }
      if (i < times) await sleep(delay);
    }
    invalidateCache(target.id);
    console.log(`\n${GREEN(`\nCompleted! ${times}x buka/tutup group.`)}`);
    await notifyGroup(target.id, `completed ${times}x`);
    await audit('spam lock/unlock', { id: target.id, times, delay });
  }
  if (choice === 9) {
    if (!isAdmin(bot)) throw new Error('The bot is not a group administrator.');
    const botIds = [socket?.user?.id, socket?.user?.lid].filter(Boolean).map(numberOf);
    const toDemote = metadata.participants.filter(p => {
      if (!isAdmin(p)) return false;
      if (idsOf(p).some(id => botIds.includes(id))) return false;
      if (idsOf(p).some(id => PROTECTED_NUMBERS.includes(id))) return false;
      return true;
    });
    if (!toDemote.length) { console.log(YELLOW('There are no admins available to demote.')); return; }
    console.log(YELLOW(`Admins to be demoted (${toDemote.length}):`));
    toDemote.forEach(p => console.log(`  - ${p.id} [${p.admin}]`));
    if (await confirmForOperation(rl, `DEMOTE ${toDemote.length} admins now?`, autoConfirm)) {
      const ids = toDemote.map(p => p.id);
      const BATCH = 5;
      let done = 0;
      for (let i = 0; i < ids.length; i += BATCH) {
        const slice = ids.slice(i, i + BATCH);
        await socket.groupParticipantsUpdate(target.id, slice, 'demote');
        done += slice.length;
        console.log(CYAN(`Demoted ${done}/${ids.length}...`));
        if (i + BATCH < ids.length) await sleep(300);
      }
      invalidateCache(target.id);
      await audit('demote all admins', { id: target.id, count: ids.length });
      console.log(GREEN(`${ids.length} admins successfully demoted.`));
      await notifyGroup(target.id, `${ids.length} admins demoted.`);
    }
  }
}
function showCredits() { console.log(`\n${RED('╔══════════════════════════════════╗')}\n${RED('║          PROJECT CREDITS         ║')}\n${RED('╠══════════════════════════════════╣')}\n║ NullKat Development              ║\n║ Developer: Wahyu Katnoko         ║\n║ Co-Developer: Echarina Bizulifah ║\n║ Project: Nos Invernus Sentinel   ║\n║ Codename: NK-T1                  ║\n║ Version: ${config.version.padEnd(22)}║\n${RED('╚══════════════════════════════════╝')}`); }

await fs.mkdir(path.dirname(TARGETS_PATH), { recursive: true });
targets = await loadTargets();
const rl = readline.createInterface({ input, output });
const shutdown = () => { shuttingDown = true; if (reconnectTimer) clearTimeout(reconnectTimer); try { socket?.end?.(undefined); } catch {} rl.close(); };
process.on('SIGINT', () => { shutdown(); process.exit(0); });

try {
  while (true) {
    showBanner(); showMenu();
    const choice = await ask(rl, `${BRIGHT_RED('NK-T1')} ${GRAY('>')} `);
    if (choice === '0' || !choice) break;
    if (choice === '8') { showCredits(); await ask(rl, 'Press Enter...'); continue; }
    if (choice === '7') {
      let phone = (await ask(rl, 'Enter WhatsApp number (digits with country code): ')).replace(/\D/g, '');
      if (phone.startsWith('0')) phone = `62${phone.slice(1)}`;
      if (!/^\d{8,15}$/.test(phone)) { console.log(RED('Invalid number. Use digits with a country code.')); await ask(rl, 'Press Enter...'); continue; }
      await startConnection(phone);
      if (connection === 'CONNECTING') {
        console.log(YELLOW('Waiting for pairing... (up to 2 minutes; do not press anything)'));
        const result = await waitForConnection();
        console.log(result === 'ONLINE' ? GREEN('Terhubung!') : YELLOW(`Hasil: ${result}`));
      }
      await ask(rl, 'Press Enter...'); continue;
    }
    const operation = Number(choice);
    if (![1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13].includes(operation)) { console.log(RED('Invalid menu selection.')); await ask(rl, 'Press Enter...'); continue; }
    if (operationBusy) { console.log(YELLOW('Another operation is already running.')); continue; }

    if (operation === 11) {
      const COMBINABLE = [1, 2, 3, 4, 5, 6, 9, 10, 12, 13];
      console.log(`\n${VIOLET('Combinable menus:')}`);
      console.log(`${CYAN('[1]')} Group Admin Audit    ${CYAN('[2]')} Member Management`);
      console.log(`${CYAN('[3]')} Switch Group Name    ${CYAN('[4]')} Lock / Unlock Group`);
      console.log(`${CYAN('[5]')} Admin Mgmt Audit     ${CYAN('[6]')} Full Security Audit`);
      console.log(`${CYAN('[9]')} Demote All Admins    ${CYAN('[10]')} Spam Lock / Unlock`);
      console.log(`${CYAN('[12]')} Set Profile Picture    ${CYAN('[13]')} Spam Message`);
      const raw = await ask(rl, `\n${BRIGHT_RED('Enter menu numbers separated by spaces (example: 3 4 9)')}: `);
      const combo = [...new Set(raw.split(/\s+/).map(Number).filter(n => COMBINABLE.includes(n)))];
      if (combo.length < 2) { console.log(RED('At least 2 different valid menus are required.')); await ask(rl, 'Press Enter...'); continue; }
      console.log(GREEN(`\nCombination: ${combo.join(' → ')}`));
      const target = await chooseTarget(rl); if (!target) { await ask(rl, 'Press Enter...'); continue; }
      if (!await confirm(rl, `Run operation ${combo.join(' → ')} pada group "${target.name}"?`)) { await ask(rl, 'Press Enter...'); continue; }
      operationBusy = true;
      try {
        for (const step of combo) {
          console.log(`\n${VIOLET(`━━━ OPERASI [${step}] ━━━`)}`);
          await runOperation(rl, step, target, true);
          await audit(`combo operation ${step}`, { id: target.id });
          if (combo.indexOf(step) < combo.length - 1) await sleep(500);
        }
        console.log(GREEN(`\n✓ All operations completed.`));
      } catch (error) { log('ERROR', error.message); } finally { operationBusy = false; }
      await ask(rl, 'Press Enter...'); continue;
    }

    const target = await chooseTarget(rl); if (!target) { await ask(rl, 'Press Enter...'); continue; }
    operationBusy = true;
    try { await runOperation(rl, operation, target); await audit(`menu operation ${operation}`, { id: target.id }); } catch (error) { log('ERROR', error.message); } finally { operationBusy = false; }
    await ask(rl, 'Press Enter...');
  }
} finally { shutdown(); log('INFO', 'Sentinel shutdown.'); }