// server.js
// Mini CRM + LOGIN BÁSICO (usuario: admin / pass: admin)
// Basado en tu server actual
"use strict";

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const cookieParser = require('cookie-parser'); // 👈 NUEVO

// ---------- CONFIG LOGIN ----------
const SESSION_SECRET = 'cambia-esto-por-algo-mas-largo';
const VALID_USER = 'admin';
const VALID_PASS = 'admin';

// ---------- RUTAS Y ARCHIVOS ----------
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const TRIGGERS_FILE = path.join(DATA_DIR, 'bot_triggers.json');
const HIDDEN_CHATS_FILE = path.join(DATA_DIR, 'hidden_chats.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'strangers_override.json');
const KANBAN_LANES_FILE = path.join(DATA_DIR, 'kanban_lanes.json');
const KANBAN_ASSIGNMENTS_FILE = path.join(DATA_DIR, 'kanban_assignments.json');
const EXCEL_CONTACTS_FILE = path.join(DATA_DIR, 'excel_contacts.json');

const PUBLIC_DIR = path.join(__dirname, 'public');
const INBOX_DIR = path.join(PUBLIC_DIR, 'inbox');

// ---------- DIRECTORIOS ----------
function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  } catch {}
}
function ensureDataDir() {
  ensureDir(DATA_DIR);
  ensureDir(UPLOADS_DIR);
  ensureDir(TMP_DIR);
  ensureDir(PUBLIC_DIR);
  ensureDir(INBOX_DIR);
}
ensureDataDir();

// ---------- MULTER ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safe = `${Date.now()}-${(file.originalname || 'upload')}`.replace(/[^\w.\- ]+/g, '_');
    cb(null, safe);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// ---------- UTILS ----------
function loadSetFrom(file) {
  try {
    ensureDataDir();
    if (fs.existsSync(file)) {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (e) {
    console.error(`No se pudo cargar ${path.basename(file)}:`, e?.message || e);
  }
  return new Set();
}
function saveSetTo(file, set) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(Array.from(set), null, 2), 'utf8');
  } catch (e) {
    console.error(`No se pudo guardar ${path.basename(file)}:`, e?.message || e);
  }
}
function loadJsonArray(file) {
  try {
    ensureDataDir();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('No se pudo cargar', file, e?.message || e);
  }
  return [];
}
function saveJsonArray(file, arr) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.error('No se pudo guardar', file, e?.message || e);
  }
}
function loadExcelContacts() {
  try {
    ensureDataDir();
    if (fs.existsSync(EXCEL_CONTACTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(EXCEL_CONTACTS_FILE, 'utf8'));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error('No se pudo leer excel_contacts.json:', e?.message || e);
  }
  return [];
}
function saveExcelContacts(list) {
  try {
    ensureDataDir();
    fs.writeFileSync(EXCEL_CONTACTS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (e) {
    console.error('No se pudo guardar excel_contacts.json:', e?.message || e);
  }
}

function normalizeToMXWid(raw, defaultCountry = '52') {
  const digits = String(raw || '').replace(/\D+/g, '');
  if (!digits) return null;
  const full = digits.startsWith(defaultCountry) ? digits : defaultCountry + digits;
  return `${full}@c.us`;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fileToMessageMedia(file, forceOgg = false) {
  if (!file || !file.path) throw new Error('Archivo inválido');
  const filename = file.originalname || path.basename(file.path);
  let mimetype = file.mimetype || 'application/octet-stream';
  const base64 = fs.readFileSync(file.path, { encoding: 'base64' });

  if (forceOgg) {
    mimetype = 'audio/ogg; codecs=opus';
  }

  return new MessageMedia(mimetype, base64, filename);
}
function makeTmpName(ext = '.ogg') {
  return path.join(TMP_DIR, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
}
function convertWebmToOggStrict(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(48000)
      .audioCodec('libopus')
      .audioBitrate('32k')
      .outputOptions('-vn')
      .outputOptions('-compression_level 10')
      .outputOptions('-application voip')
      .format('ogg')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}
let _sendMutex = Promise.resolve();
function withSendMutex(task) {
  _sendMutex = _sendMutex.then(() => task()).catch((e) => { throw e; });
  return _sendMutex;
}
async function waitForReady(client, { tries = 40, delayMs = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const st = await client.getState();
      if (st === 'CONNECTED') return true;
    } catch {}
    await sleep(delayMs);
  }
  throw new Error('WhatsApp no está CONNECTED');
}
async function materializeChat(client, chatId, { tries = 10, delayMs = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const chat = await client.getChatById(chatId);
      if (chat) return chat;
    } catch {}
    await sleep(delayMs);
  }
  return null;
}
async function sendWithRetry(sendFn, client, chatId, { retries = 5, delayMs = 700 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      await waitForReady(client, { tries: 20, delayMs: 300 });
      await materializeChat(client, chatId, { tries: 6, delayMs: 300 });
      return await sendFn();
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      const retryable =
        /Evaluation failed/i.test(msg) ||
        /Execution context was destroyed/i.test(msg) ||
        /not CONNECTED/i.test(msg) ||
        /reload/i.test(msg);
      if (retryable && i < retries) {
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}
function normalizeChatIdInput(chatIdOrNumber) {
  if (!chatIdOrNumber) return null;
  const s = String(chatIdOrNumber);
  if (s.endsWith('@c.us')) return s;
  return normalizeToMXWid(s);
}

// ---------- ESTADOS ----------
const botTriggeredOnce = loadSetFrom(TRIGGERS_FILE);
const hiddenChats = loadSetFrom(HIDDEN_CHATS_FILE);
const strangerOverride = loadSetFrom(OVERRIDES_FILE);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser(SESSION_SECRET)); // 👈 para leer cookies firmadas

// ====== MIDDLEWARE DE AUTENTICACIÓN ======
function requireAuth(req, res, next) {
  // dejamos pasar el login y archivos estáticos del login
  if (req.path === '/login' || req.path === '/login.html' || req.path.startsWith('/public/login')) {
    return next();
  }
  // permitimos también el QR del inicio de WA? → NO, solo para autenticados
  const token = req.signedCookies && req.signedCookies['auth'];
  if (token === 'ok') {
    return next();
  }
  // si no está logueado, redirigimos a login
  return res.redirect('/login.html');
}

// === RUTA DE LOGIN (POST) ===
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === VALID_USER && password === VALID_PASS) {
    // guardamos cookie firmada
    res.cookie('auth', 'ok', {
      httpOnly: true,
      signed: true,
      sameSite: 'lax'
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
});

// === RUTA DE LOGOUT ===
app.post('/logout', (req, res) => {
  res.clearCookie('auth');
  res.json({ ok: true });
});

// ⚠️ A PARTIR DE AQUÍ TODO LO PRIVADO
app.use(requireAuth);

// Servimos /public SOLO si está logueado
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/tmp', express.static(TMP_DIR));

// ---------- ESTADO GLOBAL ----------
const state = {
  chats: new Map(),
  messages: new Map(),
  assignments: new Map(),
  kanbanLanes: loadJsonArray(KANBAN_LANES_FILE)
};

// ... ⬇️ AQUI SIGUE TODO TU CÓDIGO COMO LO TENÍAS
// (eventos WhatsApp, /api/chats, /api/messages, /api/send, /api/excel-contacts, /api/kanban/...)
// No lo reescribo completo porque es larguísimo, pero lo que cambia
// es SOLO la parte de arriba (login + requireAuth + static después del middleware).
// Asegúrate de pegar todo tu código original luego de esta parte.
// :contentReference[oaicite:0]{index=0}


// cargar tarjetas desde archivo
const savedAssignments = loadJsonArray(KANBAN_ASSIGNMENTS_FILE); // [{id,title,lane}]
for (const it of savedAssignments) {
  if (it && it.id) {
    state.assignments.set(it.id, {
      id: it.id,
      title: it.title || it.id,
      lane: it.lane || null
    });
  }
}

// helper para guardar tarjetas
function persistAssignments() {
  const arr = Array.from(state.assignments.values());
  saveJsonArray(KANBAN_ASSIGNMENTS_FILE, arr);
}

// helper para guardar lanes
function persistLanes() {
  saveJsonArray(KANBAN_LANES_FILE, state.kanbanLanes || []);
}

function ensureChat(chat) {
  const id = chat.id._serialized;
  if (!state.chats.has(id)) {
    state.chats.set(id, {
      id,
      name: chat.name || chat.formattedTitle || chat.id?.user || id,
      isGroup: !!chat.isGroup
    });
  }
}
function ensureChatLite(chatId, name = '') {
  if (!state.chats.has(chatId)) {
    state.chats.set(chatId, { id: chatId, name: name || chatId, isGroup: false });
  }
}
function pushMessage(chatId, msg) {
  if (!state.messages.has(chatId)) state.messages.set(chatId, []);
  const arr = state.messages.get(chatId);
  arr.push({
    id: msg.id?._serialized || msg.id || ('local-' + Date.now()),
    from: msg.from,
    body: msg.body,
    t: (msg.t || (msg.timestamp ? msg.timestamp * 1000 : Date.now())),
    fromMe: !!msg.fromMe,
    media: msg.media ? msg.media : null
  });
  if (arr.length > 200) arr.splice(0, arr.length - 200);
}
const visibleChatsArray = () => Array.from(state.chats.values()).filter(c => !hiddenChats.has(c.id));

const botState = { enabled: false, welcome: null, rules: [] };

// ---------- CLIENTE WHATSAPP ----------
const wa = new Client({
  authStrategy: new LocalAuth({ clientId: 'crm-panel' }),
  puppeteer: {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
    ],
    timeout: 0,
  },
});

wa.on('qr', (qr) => {
  console.log('\n📲 Escanea este QR en tu WhatsApp:');
  qrcode.generate(qr, { small: true });
  io.emit('qr', qr);
});
wa.on('authenticated', () => console.log('🔐 Autenticado.'));
wa.on('auth_failure', (m) => console.error('❌ Falló autenticación:', m));
wa.on('ready', async () => {
  console.log('✅ WhatsApp listo.');
  io.emit('ready');
  setTimeout(async () => {
    try {
      const chats = await wa.getChats();
      chats.slice(0, 200).forEach(ch => {
        const id = ch.id._serialized;
        if (!hiddenChats.has(id)) {
          ensureChat(ch);
        }
      });
      io.emit('chats', visibleChatsArray());
      // enviamos también el kanban y las columnas actuales
      io.emit('kanban:lanes', state.kanbanLanes || []);
      io.emit('kanban:full', Array.from(state.assignments.values()));
      console.log(`📒 Cargados ${state.chats.size} chats (filtrando ocultos).`);
    } catch (e) {
      console.error('Error al cargar chats:', e?.message || e);
    }
  }, 1200);
});

// ---------- MENSAJES ENTRANTES DE WHATSAPP ----------
wa.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    const chatId = chat.id._serialized;

    const contact = await msg.getContact();
    const isMyContact = !!(contact && contact.isMyContact);
    const treatAsStranger = strangerOverride.has(chatId);

    if (hiddenChats.has(chatId)) {
      hiddenChats.delete(chatId);
      saveSetTo(HIDDEN_CHATS_FILE, hiddenChats);
    }

    const wasNew = !state.chats.has(chatId);
    ensureChat(chat);

    // ---- DESCARGAR MEDIA SI LA HAY ----
    let mediaInfo = null;
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const mime = media.mimetype || 'application/octet-stream';
          let ext = '';
          if (mime.startsWith('image/')) ext = '.' + mime.split('/')[1];
          else if (mime.startsWith('audio/')) ext = '.' + (mime.split('/')[1] || 'ogg');
          else if (mime === 'application/pdf') ext = '.pdf';
          else if (mime.startsWith('video/')) ext = '.' + (mime.split('/')[1] || 'mp4');
          else ext = '.bin';

          const fname = `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
          const fullPath = path.join(INBOX_DIR, fname);
          fs.writeFileSync(fullPath, media.data, { encoding: 'base64' });

          mediaInfo = {
            hasMedia: true,
            mimetype: mime,
            filename: fname,
            url: `/inbox/${fname}`
          };
        }
      } catch (err) {
        console.error('No se pudo descargar media entrante:', err?.message || err);
      }
    }

    pushMessage(chatId, {
      id: msg.id._serialized,
      from: msg.from,
      body: msg.body,
      t: (msg.timestamp ? msg.timestamp * 1000 : Date.now()),
      fromMe: !!msg.fromMe,
      media: mediaInfo
    });

    const payload = {
      chatId,
      id: msg.id._serialized,
      from: msg.from,
      body: msg.body,
      t: (msg.timestamp ? msg.timestamp * 1000 : Date.now()),
      fromMe: !!msg.fromMe,
      media: mediaInfo
    };
    io.to(chatId).emit('new-message', payload);
    io.emit('chat-updated', {
      id: chatId,
      name: chat.name || chat.formattedTitle || chat.id.user || chatId,
      body: msg.body || (mediaInfo ? '[Adjunto]' : ''),
      fromMe: !!msg.fromMe,
      t: payload.t
    });
    if (wasNew) {
      io.emit('chat-created', state.chats.get(chatId));
      io.emit('chats', visibleChatsArray());
    }

    // ---------- BOT ----------
    const eligible =
      botState.enabled &&
      !msg.fromMe &&
      !botTriggeredOnce.has(chatId) &&
      (!isMyContact || treatAsStranger);

    if (eligible) {
      const rules = Array.isArray(botState.rules) ? botState.rules : [];
      const rule = findRule(rules, msg.body || '');

      botTriggeredOnce.add(chatId);
      saveSetTo(TRIGGERS_FILE, botTriggeredOnce);

      if (rule && typeof rule.reply === 'string' && rule.reply.trim()) {
        await wa.sendMessage(chatId, rule.reply.trim());
        const local = { id: 'bot-' + Date.now(), from: chatId, body: rule.reply.trim(), t: Date.now(), fromMe: true };
        pushMessage(chatId, local);
        io.to(chatId).emit('new-message', { chatId, ...local });
        if (Array.isArray(rule.actions) && rule.actions.length) {
          await runActions(wa, chatId, rule.actions);
        }
      } else if (botState.welcome) {
        await wa.sendMessage(chatId, botState.welcome);
        const local = { id: 'bot-' + Date.now(), from: chatId, body: botState.welcome, t: Date.now(), fromMe: true };
        pushMessage(chatId, local);
        io.to(chatId).emit('new-message', { chatId, ...local });
      }
    }
  } catch (e) {
    console.error('message handler error:', e?.message || e);
  }
});

wa.on('disconnected', (reason) => {
  console.log('⚠️ Desconectado:', reason, '→ re-inicializando…');
  setTimeout(() => {
    try { wa.initialize(); } catch (e) { console.error('Reinit error:', e?.message || e); }
  }, 1000);
});
wa.initialize();

// ---------- API BÁSICA ----------
app.get('/api/ping', (_req, res) => res.json({ ok: true, t: Date.now() }));
app.get('/api/chats', (_req, res) => res.json(visibleChatsArray()));

async function waitForChat(client, chatId, { tries = 12, delayMs = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const chat = await client.getChatById(chatId);
      if (chat) return chat;
    } catch {}
    await sleep(delayMs);
  }
  throw new Error('Chat aún no disponible');
}

// IMPORTANTE: arriba en tu server.js asegúrate de tener algo así:
// const path = require('path');
// const fs   = require('fs');
// const DATA_DIR    = path.join(__dirname, 'data');
// const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
// if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
// if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ... y también sirves estático:
// app.use('/data/uploads', express.static(UPLOADS_DIR));

app.get('/api/messages/:chatId', async (req, res) => {
  const { chatId } = req.params;

  try {
    // 1) ¿ya lo teníamos en memoria?
    let msgs = state.messages.get(chatId);

    // 2) Si no hay en memoria, vamos a WhatsApp y los construimos
    if (!msgs || !msgs.length) {
      let chat = null;
      try {
        chat = await wa.getChatById(chatId);
      } catch {
        // tu helper de espera
        try {
          chat = await waitForChat(wa, chatId, { tries: 6, delayMs: 300 });
        } catch {}
      }

      if (chat) {
        ensureChat(chat);

        // Trae últimos 50 (puedes subirlo a 100 si quieres)
        const history = await chat.fetchMessages({ limit: 50 });

        // Vamos mensaje por mensaje y si tiene media la descargamos
        const built = [];
        for (const m of history) {
          const baseMsg = {
            id: m.id._serialized,
            from: m.from,
            body: m.body,
            t: (m.timestamp ? m.timestamp * 1000 : Date.now()),
            fromMe: m.fromMe
          };

          // ¿tiene media?
          if (m.hasMedia) {
            try {
              const media = await m.downloadMedia();
              if (media && media.data) {
                // ejemplo: image/jpeg -> jpeg
                const ext =
                  (media.mimetype && media.mimetype.includes('/'))
                    ? media.mimetype.split('/')[1]
                    : 'bin';

                const filename = `${Date.now()}-${m.id.id}.${ext}`;
                const filepath = path.join(UPLOADS_DIR, filename);

                // guardamos el archivo binario
                fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));

                baseMsg.media = {
                  mimetype: media.mimetype,
                  url: `/data/uploads/${filename}`,
                  filename
                };
              }
            } catch (e) {
              // si falla la descarga, igual mandamos el mensaje sin media
              console.warn('No se pudo descargar media antigua de', m.id._serialized, e.message);
            }
          }

          built.push(baseMsg);
        }

        // Guardamos en memoria ya enriquecido
        msgs = built.sort((a, b) => a.t - b.t);
        state.messages.set(chatId, msgs);
      } else {
        msgs = [];
      }
    }

    // 3) Respondemos lo que tengamos (ya con media si la había)
    res.json(msgs.sort((a, b) => a.t - b.t));
  } catch (e) {
    console.error('GET /api/messages error', e);
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/send', async (req, res) => {
  try {
    const { chatId, text } = req.body || {};
    if (!chatId || !text) return res.status(400).json({ error: 'Faltan parámetros' });

    await withSendMutex(() =>
      sendWithRetry(() => wa.sendMessage(chatId, text), wa, chatId)
    );

    const local = { id: 'local-' + Date.now(), from: chatId, body: text, t: Date.now(), fromMe: true };
    pushMessage(chatId, local);
    ensureChatLite(chatId);
    io.to(chatId).emit('new-message', { chatId, ...local });
    io.emit('chat-updated', {
      id: chatId,
      name: state.chats.get(chatId)?.name || chatId,
      body: text,
      fromMe: true,
      t: local.t
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/send error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send-to', async (req, res) => {
  try {
    const { contactId, text } = req.body || {};
    if (!contactId || !text) return res.status(400).json({ error: 'Faltan parámetros' });

    await withSendMutex(() =>
      sendWithRetry(() => wa.sendMessage(contactId, text), wa, contactId)
    );

    strangerOverride.add(contactId);
    saveSetTo(OVERRIDES_FILE, strangerOverride);

    let chat = null;
    try {
      chat = await waitForChat(wa, contactId, { tries: 12, delayMs: 300 });
    } catch {}

    if (chat) ensureChat(chat);
    else ensureChatLite(contactId);
    io.emit('chat-created', state.chats.get(contactId));
    io.emit('chats', visibleChatsArray());

    const local = { id: 'local-' + Date.now(), from: contactId, body: text, t: Date.now(), fromMe: true };
    pushMessage(contactId, local);
    io.to(contactId).emit('new-message', { chatId: contactId, ...local });

    res.json({ ok: true, chatId: contactId, chat: state.chats.get(contactId) });
  } catch (e) {
    console.error('POST /api/send-to error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/contacts', async (_req, res) => {
  try {
    const contacts = await wa.getContacts();
    const data = contacts.map(c => ({
      id: c.id._serialized,
      number: c.number || c.id.user,
      name: c.name || c.pushname || c.number || c.id.user,
      isBusiness: !!c.isBusiness,
      isGroup: false,
      isMyContact: !!c.isMyContact
    }));
    res.json(data);
  } catch (e) {
    console.error('GET /api/contacts error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ========= EXCEL CONTACTS API =========
// Estructura: { id, nombre, numero, proyecto, porcentaje, dia, luis, estatus }
app.get('/api/excel-contacts', (_req, res) => {
  const list = loadExcelContacts();
  return res.json({ ok: true, items: list });
});

app.post('/api/excel-contacts', (req, res) => {
  const body = req.body || {};
  const {
    id,
    nombre = '',
    numero = '',
    proyecto = '',
    porcentaje = '',
    dia = '',
    luis = 'FALSE',
    estatus = ''
  } = body;

  if (!id) {
    return res.status(400).json({ ok: false, error: 'Falta id' });
  }

  const list = loadExcelContacts();
  const idx = list.findIndex(it => String(it.id) === String(id));

  const record = {
    id,
    nombre,
    numero,
    proyecto,
    porcentaje,
    dia,
    luis: (luis === 'TRUE' || luis === true) ? 'TRUE' : 'FALSE',
    estatus
  };

  if (idx === -1) {
    list.push(record);
  } else {
    list[idx] = record;
  }

  saveExcelContacts(list);
  return res.json({ ok: true, item: record });
});

app.delete('/api/excel-contacts/:id', (req, res) => {
  const { id } = req.params;
  const list = loadExcelContacts();
  const newList = list.filter(it => String(it.id) !== String(id));
  saveExcelContacts(newList);
  return res.json({ ok: true });
});

app.delete('/api/excel-contacts', (_req, res) => {
  saveExcelContacts([]);
  return res.json({ ok: true });
});

// ========= MEDIA =========
app.post('/api/send-media', upload.array('files', 10), async (req, res) => {
  try {
    const { chatId, caption } = req.body || {};
    if (!chatId) return res.status(400).json({ error: 'Falta chatId' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No se recibieron archivos' });

    for (const f of req.files) {
      const media = fileToMessageMedia(f);
      await withSendMutex(async () => {
        await wa.sendMessage(chatId, media, { caption: caption || undefined });
      });

      io.to(chatId).emit('new-message', {
        chatId,
        fromMe: true,
        body: caption || '',
        t: Date.now(),
        media: {
          hasMedia: true,
          mimetype: f.mimetype || 'application/octet-stream',
          filename: f.originalname,
          url: `/uploads/${path.basename(f.path)}`
        }
      });
    }

    ensureChatLite(chatId);
    io.emit('chat-updated', {
      id: chatId,
      name: state.chats.get(chatId)?.name || chatId,
      body: caption ? `[Adjunto] ${caption}` : '[Adjunto]',
      fromMe: true,
      t: Date.now()
    });

    res.json({ ok: true, sent: req.files.length });
  } catch (e) {
    console.error('POST /api/send-media error:', e);
    const msg = String(e?.message || e);
    if (/Evaluation failed/i.test(msg) || /Execution context was destroyed/i.test(msg)) {
      return res.status(503).json({ error: 'WhatsApp Web se está recargando. Intenta de nuevo.', detail: msg });
    }
    res.status(500).json({ error: msg });
  }
});

// ========= AUDIO (webm -> ogg) =========
app.post('/api/send-audio', upload.single('audio'), async (req, res) => {
  try {
    let { chatId, number } = req.body || {};
    const resolvedId = normalizeChatIdInput(chatId || number);
    if (!resolvedId) {
      return res.status(400).json({ error: 'chatId/number inválido' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió audio' });
    }

    const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
    if (req.file.size > MAX_AUDIO_BYTES) {
      return res.status(400).json({ error: 'Audio demasiado grande (>16MB) para WhatsApp' });
    }

    const originalPath = req.file.path;
    const originalMime = (req.file.mimetype || '').toLowerCase();
    let finalPath = originalPath;
    let finalMime = originalMime;
    let finalName = 'ptt.ogg';
    let cleanup = false;

    const needsConvert =
      originalMime.includes('webm') ||
      originalMime.includes('video/') ||
      originalMime.includes('audio/mp4') ||
      /\.webm$/i.test(req.file.originalname || '');

    if (needsConvert) {
      const outPath = makeTmpName('.ogg');
      await new Promise((resolve, reject) => {
        ffmpeg(originalPath)
          .noVideo()
          .audioChannels(1)
          .audioFrequency(48000)
          .audioCodec('libopus')
          .audioBitrate('32k')
          .outputOptions('-vn')
          .outputOptions('-application', 'voip')
          .format('ogg')
          .on('end', resolve)
          .on('error', reject)
          .save(outPath);
      });

      const st = fs.statSync(outPath);
      if (!st || st.size < 4096) {
        finalPath = originalPath;
        finalMime = originalMime || 'application/octet-stream';
        finalName = req.file.originalname || path.basename(originalPath);
      } else {
        finalPath = outPath;
        finalMime = 'audio/ogg; codecs=opus';
        finalName = 'ptt.ogg';
        cleanup = true;
      }
    } else if (!originalMime.startsWith('audio/ogg')) {
      finalMime = originalMime || 'application/octet-stream';
      finalName = req.file.originalname || path.basename(originalPath);
    } else {
      finalMime = 'audio/ogg; codecs=opus';
      finalName = 'ptt.ogg';
    }

    await withSendMutex(async () => {
      const base64 = fs.readFileSync(finalPath, { encoding: 'base64' });
      const media = new MessageMedia(finalMime, base64, finalName);
      await wa.sendMessage(resolvedId, media, { sendAudioAsVoice: true });
    });

    if (cleanup) {
      fs.unlink(finalPath, () => {});
    }

    ensureChatLite(resolvedId);
    io.emit('chat-updated', {
      id: resolvedId,
      name: state.chats.get(resolvedId)?.name || resolvedId,
      body: finalMime.startsWith('audio/ogg') ? '[Nota de voz]' : '[Audio]',
      fromMe: true,
      t: Date.now(),
    });

    const finalUrl = cleanup
      ? `/tmp/${path.basename(finalPath)}`
      : `/uploads/${path.basename(finalPath)}`;

    io.to(resolvedId).emit('new-message', {
      chatId: resolvedId,
      fromMe: true,
      body: '[Nota de voz]',
      t: Date.now(),
      media: {
        hasMedia: true,
        mimetype: finalMime,
        filename: finalName,
        url: finalUrl
      }
    });

    return res.json({ ok: true, chatId: resolvedId });
  } catch (e) {
    console.error('POST /api/send-audio error:', e);
    const msg = String(e?.message || e);
    if (/Evaluation failed/i.test(msg) || /reload/i.test(msg)) {
      return res.status(503).json({
        error: 'WhatsApp Web se está recargando. Intenta de nuevo.',
        detail: msg,
      });
    }
    return res.status(500).json({ error: msg });
  }
});

// ---------- BOT API ----------
function findRule(rules = [], text = '') {
  const s = String(text || '').trim();
  for (const r of rules) {
    if (!r) continue;
    const type = (r.type || 'includes').toLowerCase();
    const m = String(r.match || '');
    try {
      if (type === 'equals' && s.toLowerCase() === m.toLowerCase()) return r;
      if (type === 'includes' && s.toLowerCase().includes(m.toLowerCase())) return r;
      if (type === 'regex') {
        const re = new RegExp(m, 'i');
        if (re.test(s)) return r;
      }
    } catch (e) {
      console.error('Regla inválida:', r, e?.message || e);
    }
  }
  return null;
}
async function runActions(client, chatId, actions = []) {
  const chat = await client.getChatById(chatId);
  for (const a of (actions || [])) {
    if (!a || !a.do) continue;
    if (a.do === 'delay') {
      await sleep(Number(a.ms || 0));
      continue;
    }
    if (a.do === 'typing') {
      try {
        await chat.sendStateTyping();
        await sleep(Number(a.ms || 800));
        await chat.clearState();
      } catch (e) {}
      continue;
    }
    if (a.do === 'text') {
      await client.sendMessage(chatId, String(a.text || ''));
      continue;
    }
    if (a.do === 'audio') {
      try {
        let media = null;
        if (a.file && path.isAbsolute(a.file) && fs.existsSync(a.file)) media = MessageMedia.fromFilePath(a.file);
        else if (a.file) {
          const local = path.join(__dirname, 'public', 'media', a.file);
          if (fs.existsSync(local)) media = MessageMedia.fromFilePath(local);
        } else if (a.url) {
          media = await MessageMedia.fromUrl(a.url);
        }
        if (!media) {
          console.error('❌ No se pudo preparar el media de audio:', a);
          continue;
        }
        await client.sendMessage(chatId, media, { sendAudioAsVoice: !!a.asVoice });
      } catch (err) {
        console.error('❌ Error enviando audio:', err?.message || err);
      }
    }
  }
}
app.post('/api/bot/upload', (req, res) => {
  try {
    const { welcome, rules } = req.body || {};
    if (!Array.isArray(rules)) return res.status(400).json({ error: 'El JSON debe traer "rules" como arreglo.' });
    for (const r of rules) {
      if (!r || typeof r.reply !== 'string') return res.status(400).json({ error: 'Cada regla debe tener "reply" (string).' });
      if (!r.type) r.type = 'includes';
      if (typeof r.match !== 'string') r.match = '';
    }
    botState.welcome = (typeof welcome === 'string' && welcome.trim()) ? welcome.trim() : null;
    botState.rules = rules;
    botState.enabled = true;
    return res.json({ ok: true, count: rules.length, enabled: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error procesando JSON' });
  }
});
app.post('/api/bot/disable', (_req, res) => {
  botState.enabled = false;
  return res.json({ ok: true, enabled: false });
});
app.get('/api/bot/status', (_req, res) => {
  res.json({ enabled: botState.enabled, rules: botState.rules?.length || 0, welcome: botState.welcome || null });
});

// ---------- Olvidar/ocultar ----------
function resolveChatIdFromInput({ chatId, number, name }) {
  if (chatId && chatId.endsWith('@c.us')) return chatId;
  if (number) {
    const wid = normalizeToMXWid(number);
    if (wid) return wid;
  }
  if (name) {
    const n = String(name).toLowerCase().trim();
    if (n) {
      const matches = Array.from(state.chats.values()).filter(c => (c.name || '').toLowerCase().includes(n));
      if (matches.length === 1) return matches[0].id;
      const exact = matches.find(c => (c.name || '').toLowerCase() === n);
      if (exact) return exact.id;
      if (matches.length === 0) {
        const byId = Array.from(state.chats.values()).find(c => String(c.id || '').toLowerCase().includes(n));
        if (byId) return byId.id;
      }
    }
  }
  return null;
}

app.post('/api/forget-chat', async (req, res) => {
  try {
    const body = req.body || {};
    let targetId = resolveChatIdFromInput(body);
    if (!targetId && body.chatId && body.chatId.endsWith('@c.us')) targetId = body.chatId;
    if (!targetId && body.number) targetId = normalizeToMXWid(body.number);
    if (!targetId) return res.status(404).json({ error: 'No se encontró ningún contacto con ese nombre, número o chatId' });

    hiddenChats.add(targetId); saveSetTo(HIDDEN_CHATS_FILE, hiddenChats);
    botTriggeredOnce.delete(targetId); saveSetTo(TRIGGERS_FILE, botTriggeredOnce);
    strangerOverride.add(targetId); saveSetTo(OVERRIDES_FILE, strangerOverride);

    state.chats.delete(targetId);
    state.messages.delete(targetId);
    state.assignments.delete(targetId);
    persistAssignments();

    io.emit('chats', visibleChatsArray());
    io.emit('kanban:full', Array.from(state.assignments.values()));

    return res.json({ ok: true, chatId: targetId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/forget-chat', async (req, res) => {
  try {
    let { chatId, number } = req.query || {};
    if (!chatId && !number) return res.status(400).json({ error: 'Falta chatId o number' });
    if (!chatId && number) chatId = normalizeToMXWid(number);
    if (!chatId) return res.status(400).json({ error: 'Número inválido' });

    state.chats.delete(chatId);
    state.messages.delete(chatId);
    botTriggeredOnce.delete(chatId); saveSetTo(TRIGGERS_FILE, botTriggeredOnce);
    hiddenChats.add(chatId); saveSetTo(HIDDEN_CHATS_FILE, hiddenChats);
    strangerOverride.add(chatId); saveSetTo(OVERRIDES_FILE, strangerOverride);
    state.assignments.delete(chatId);
    persistAssignments();

    io.emit('chats', visibleChatsArray());
    io.emit('kanban:full', Array.from(state.assignments.values()));

    return res.json({ ok: true, chatId, note: 'Olvidado y oculto via GET (solo sistema).' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error al olvidar chat (GET)' });
  }
});
app.post('/api/remove-number', async (req, res) => {
  try {
    const { number } = req.body || {};
    if (!number) return res.status(400).json({ error: 'Falta el número a eliminar' });

    const wid = normalizeToMXWid(number);
    if (!wid) return res.status(400).json({ error: 'Número inválido' });

    hiddenChats.add(wid); saveSetTo(HIDDEN_CHATS_FILE, hiddenChats);
    botTriggeredOnce.delete(wid); saveSetTo(TRIGGERS_FILE, botTriggeredOnce);
    strangerOverride.add(wid); saveSetTo(OVERRIDES_FILE, strangerOverride);

    state.chats.delete(wid);
    state.messages.delete(wid);
    state.assignments.delete(wid);
    persistAssignments();

    io.emit('chats', visibleChatsArray());
    io.emit('kanban:full', Array.from(state.assignments.values()));

    res.json({ ok: true, removed: wid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Overrides ----------
app.post('/api/mark-stranger', (req, res) => {
  try {
    const targetId = resolveChatIdFromInput(req.body || {});
    if (!targetId) return res.status(404).json({ error: 'No se encontró el contacto' });
    strangerOverride.add(targetId);
    saveSetTo(OVERRIDES_FILE, strangerOverride);
    return res.json({ ok: true, chatId: targetId, status: 'marked' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
app.post('/api/unmark-stranger', (req, res) => {
  try {
    const targetId = resolveChatIdFromInput(req.body || {});
    if (!targetId) return res.status(404).json({ error: 'No se encontró el contacto' });
    strangerOverride.delete(targetId);
    saveSetTo(OVERRIDES_FILE, strangerOverride);
    return res.json({ ok: true, chatId: targetId, status: 'unmarked' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
app.get('/api/overrides', (_req, res) => {
  res.json({ count: strangerOverride.size, list: Array.from(strangerOverride) });
});

// ====== KANBAN API (tarjetas) ======
app.get('/api/kanban', (_req, res) => {
  res.json({ ok: true, items: Array.from(state.assignments.values()) });
});
app.post('/api/kanban/upsert', (req, res) => {
  const { id, title, lane } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Falta id' });
  const item = {
    id,
    title: title || id,
    lane: lane || null
  };
  state.assignments.set(id, item);
  persistAssignments();
  io.emit('kanban:upsert', item);
  return res.json({ ok: true, item });
});
app.post('/api/kanban/delete', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Falta id' });
  state.assignments.delete(id);
  persistAssignments();
  io.emit('kanban:delete', { id });
  return res.json({ ok: true });
});

// ====== KANBAN API (columnas) ======
app.get('/api/kanban/lanes', (_req, res) => {
  return res.json({ ok: true, lanes: state.kanbanLanes || [] });
});
app.post('/api/kanban/lanes/upsert', (req, res) => {
  try {
    const { id, label, order } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Falta id de la columna' });

    const lanes = state.kanbanLanes || [];
    const idx = lanes.findIndex(l => l.id === id);
    const laneObj = {
      id,
      label: label && label.trim() ? label.trim() : id,
      order: typeof order === 'number' ? order : (idx !== -1 ? lanes[idx].order : lanes.length)
    };

    if (idx === -1) lanes.push(laneObj);
    else lanes[idx] = laneObj;

    state.kanbanLanes = lanes;
    persistLanes();

    io.emit('kanban:lanes', lanes);
    return res.json({ ok: true, lane: laneObj });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
app.post('/api/kanban/lanes/delete', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Falta id' });

    // 1) quitar columna
    const lanes = (state.kanbanLanes || []).filter(l => l.id !== id);
    state.kanbanLanes = lanes;
    persistLanes();

    // 2) quitar tarjetas que estaban en esa columna
    for (const [key, val] of state.assignments.entries()) {
      if (val.lane === id) {
        state.assignments.delete(key);
      }
    }
    persistAssignments();

    io.emit('kanban:lanes', lanes);
    io.emit('kanban:full', Array.from(state.assignments.values()));

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------- Catch-all API ----------
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta de API no encontrada', method: req.method, path: req.originalUrl });
});

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  console.log('👤 Panel conectado');
  socket.emit('chats', visibleChatsArray());
  socket.emit('kanban:lanes', state.kanbanLanes || []);
  socket.emit('kanban:full', Array.from(state.assignments.values()));
  wa.getState().then(s => {
    if (s) socket.emit('ready');
  }).catch(() => {});
  socket.on('join-chat', (chatId) => socket.join(chatId));
  socket.on('leave-chat', (chatId) => socket.leave(chatId));

  // kanban: mover tarjeta (drag & drop)
  socket.on('kanban:move', (payload) => {
    const { id, lane } = payload || {};
    if (!id || !lane) return;
    const item = state.assignments.get(id);
    if (!item) return;
    item.lane = lane;
    state.assignments.set(id, item);
    persistAssignments();
    io.emit('kanban:upsert', item);
  });

  socket.on('disconnect', () => console.log('👤 Panel desconectado'));
});

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 CRM corriendo en http://localhost:${PORT}`));
