// server.js
// Mini CRM: WhatsApp Web (whatsapp-web.js) + Express + Socket.IO
// Bot: SOLO se activa si el remitente NO está en tus contactos (contact.isMyContact === false).
// Se activa UNA SOLA VEZ por chat y guarda estado en disco (./data/bot_triggers.json).
// “Olvidar” un chat = quitarlo del panel (soft-delete) + limpiar trigger, SIN tocar WhatsApp.

"use strict";

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// ---------- PERSISTENCIA (definiciones ANTES de uso) ----------
const DATA_DIR = path.join(__dirname, 'data');
const TRIGGERS_FILE = path.join(DATA_DIR, 'bot_triggers.json');
const HIDDEN_CHATS_FILE = path.join(DATA_DIR, 'hidden_chats.json'); // soft-delete

function ensureDataDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR); } catch {}
}

function loadTriggers() {
  try {
    ensureDataDir();
    if (fs.existsSync(TRIGGERS_FILE)) {
      const raw = fs.readFileSync(TRIGGERS_FILE, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (e) {
    console.error('No se pudieron cargar triggers previos:', e.message || e);
  }
  return new Set();
}

function saveTriggers(set) {
  try {
    ensureDataDir();
    fs.writeFileSync(TRIGGERS_FILE, JSON.stringify(Array.from(set), null, 2), 'utf8');
  } catch (e) {
    console.error('No se pudieron guardar triggers:', e?.message || e);
  }
}

function loadHidden() {
  try {
    ensureDataDir();
    if (fs.existsSync(HIDDEN_CHATS_FILE)) {
      const raw = fs.readFileSync(HIDDEN_CHATS_FILE, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (e) {
    console.error('No se pudieron cargar ocultos:', e.message || e);
  }
  return new Set();
}

function saveHidden(set) {
  try {
    ensureDataDir();
    fs.writeFileSync(HIDDEN_CHATS_FILE, JSON.stringify(Array.from(set), null, 2), 'utf8');
  } catch (e) {
    console.error('No se pudieron guardar ocultos:', e?.message || e);
  }
}

// Normaliza un número a WID MX (c.us)
function normalizeToMXWid(raw, defaultCountry = '52') {
  const digits = String(raw || '').replace(/\D+/g, '');
  if (!digits) return null;
  const full = digits.startsWith(defaultCountry) ? digits : defaultCountry + digits;
  return `${full}@c.us`;
}

// ---------- Estado de “una sola vez” y ocultos ----------
const botTriggeredOnce = loadTriggers();  // chats ya activados una vez
const hiddenChats = loadHidden();         // chats ocultos (soft-delete)

// ---------- App web ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const visibleChatsArray = () => Array.from(state.chats.values()).filter(c => !hiddenChats.has(c.id));

// Ping
app.get('/api/ping', (_req, res) => res.json({ ok: true, t: Date.now() }));

// ---------- Estado en memoria ----------
const state = {
  chats: new Map(),     // chatId -> { id, name, isGroup }
  messages: new Map(),  // chatId -> [ { id, from, body, t, fromMe } ]
  assignments: new Map()
};

function ensureChat(chat) {
  const id = chat.id._serialized;
  if (!state.chats.has(id)) {
    state.chats.set(id, {
      id,
      name: chat.name || chat.formattedTitle || chat.id.user || id,
      isGroup: !!chat.isGroup
    });
  }
}

function pushMessage(chatId, msg) {
  if (!state.messages.has(chatId)) state.messages.set(chatId, []);
  const arr = state.messages.get(chatId);
  arr.push({
    id: msg.id?._serialized || ('local-' + Date.now()),
    from: msg.from,
    body: msg.body,
    t: (msg.timestamp ? msg.timestamp * 1000 : Date.now()),
    fromMe: !!msg.fromMe,
  });
  if (arr.length > 200) arr.splice(0, arr.length - 200); // cap 200
}

// ---------- Estado del bot (reglas en memoria) ----------
const botState = {
  enabled: false, // se habilita al subir reglas
  welcome: null,
  rules: [] // { type: 'equals'|'includes'|'regex', match: string, reply: string, actions?: [] }
};

// === MOTOR DE ACCIONES (typing, delay, text, audio) ===
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function setTyping(chat, ms = 800) {
  try {
    await chat.sendStateTyping();
    await sleep(Number(ms || 0));
    await chat.clearState();
  } catch (e) {
    console.error('setTyping error:', e?.message || e);
  }
}

function findRule(rules = [], text = '') {
  const s = String(text || '').trim();
  for (const r of rules) {
    if (!r) continue;
    const type = (r.type || 'includes').toLowerCase();
    const m = String(r.match || '');
    try {
      if (type === 'equals'   && s.toLowerCase() === m.toLowerCase()) return r;
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

    if (a.do === 'delay') { await sleep(Number(a.ms || 0)); continue; }
    if (a.do === 'typing') { await setTyping(chat, Number(a.ms || 800)); continue; }

    if (a.do === 'text') {
      await client.sendMessage(chatId, String(a.text || ''));
      continue;
    }

    if (a.do === 'audio') {
      try {
        let media = null;

        if (a.file && path.isAbsolute(a.file) && fs.existsSync(a.file)) {
          media = MessageMedia.fromFilePath(a.file);
          console.log('🎧 Audio desde ruta absoluta:', a.file);
        } else if (a.file) {
          const local = path.join(__dirname, 'public', 'media', a.file);
          if (fs.existsSync(local)) {
            media = MessageMedia.fromFilePath(local);
            console.log('🎧 Audio desde /public/media:', local);
          } else {
            console.error('❌ Archivo no encontrado:', local);
          }
        } else if (a.url) {
          if (a.url.includes('localhost')) {
            const filename = path.basename(a.url);
            const local = path.join(__dirname, 'public', 'media', filename);
            if (fs.existsSync(local)) {
              media = MessageMedia.fromFilePath(local);
              console.log('🎧 URL localhost; usando archivo local:', local);
            } else {
              console.warn('⚠️ No existe archivo local; intentando descarga por URL:', a.url);
              media = await MessageMedia.fromUrl(a.url);
            }
          } else {
            media = await MessageMedia.fromUrl(a.url);
            console.log('🎧 Audio desde URL externa:', a.url);
          }
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

// ---------- Cliente de WhatsApp ----------
const wa = new Client({
  authStrategy: new LocalAuth({ clientId: 'crm-panel' }),
  puppeteer: {
    headless: false, // ver ventana (útil en debug)
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
    ],
    // executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS (opcional)
    timeout: 0,
  },
});

// ---------- Eventos WhatsApp ----------
wa.on('qr', (qr) => {
  console.log('\n📲 Escanea este QR en WhatsApp > Dispositivos vinculados > Vincular dispositivo:');
  qrcode.generate(qr, { small: true });
  io.emit('qr', qr);
});

wa.on('ready', async () => {
  console.log('✅ WhatsApp listo.');
  io.emit('ready');

  setTimeout(async () => {
    try {
      const chats = await wa.getChats();
      // Seedeo solo de NO-ocultos
      chats.slice(0, 100).forEach(ch => {
        const id = ch.id._serialized;
        if (!hiddenChats.has(id)) ensureChat(ch);
      });
      io.emit('chats', visibleChatsArray());
      console.log(`📒 Cargados ${state.chats.size} chats (filtrando ocultos).`);
    } catch (e) {
      console.error('Error al cargar chats:', e);
    }
  }, 1200);
});

// Listener de mensajes (único)
wa.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    const chatId = chat.id._serialized;

    // Si estaba oculto por “soft-delete” y volvieron a escribir, dejar de ocultarlo
    if (hiddenChats.has(chatId)) {
      hiddenChats.delete(chatId);
      saveHidden(hiddenChats);
    }

    const wasNew = !state.chats.has(chatId);

    ensureChat(chat);
    pushMessage(chatId, msg);

    // Notifica mensaje nuevo al room del chat
    io.to(chatId).emit('new-message', {
      chatId,
      id: msg.id._serialized,
      from: msg.from,
      body: msg.body,
      t: msg.timestamp * 1000,
      fromMe: msg.fromMe,
    });

    if (wasNew) {
      io.emit('chats', visibleChatsArray());
    }

    // LÓGICA: Solo NUEVO CONTACTO (no en agenda) y UNA sola vez por chat
    const contact = await msg.getContact();
    const isMyContact = !!(contact && contact.isMyContact);

if (botState.enabled && !msg.fromMe && !botTriggeredOnce.has(chatId)) {
      const rules = Array.isArray(botState.rules) ? botState.rules : [];
      const rule = findRule(rules, msg.body || '');

      if (rule) {
        // Marca activado y persiste
        botTriggeredOnce.add(chatId);
        saveTriggers(botTriggeredOnce);

        // 1) Reply obligatorio (texto)
        if (typeof rule.reply === 'string' && rule.reply.trim()) {
          await wa.sendMessage(chatId, rule.reply.trim());
          const local = { id: 'bot-' + Date.now(), from: chatId, body: rule.reply.trim(), t: Date.now(), fromMe: true };
          pushMessage(chatId, local);
          io.to(chatId).emit('new-message', { chatId, ...local });
        }

        // 2) Acciones (typing, delay, text, audio)
        if (Array.isArray(rule.actions) && rule.actions.length) {
          await runActions(wa, chatId, rule.actions);
        }
      }
    }
  } catch (e) {
    console.error('message handler error:', e?.message || e);
  }
});

wa.on('auth_failure', (m) => console.error('❌ Falló autenticación:', m));
wa.on('disconnected', (r) => console.log('⚠️ Desconectado:', r));

wa.initialize();

// ---------- API REST ----------

// Lista de chats (paginado) — filtra ocultos
app.get('/api/chats', (_req, res) => {
  const offset = Math.max(parseInt(_req.query.offset || '0', 10), 0);
  const limit  = Math.min(Math.max(parseInt(_req.query.limit || '30', 10), 1), 100);
  const arr = visibleChatsArray();
  const items = arr.slice(offset, offset + limit);
  res.json({ items, total: arr.length });
});

// Historial extendido
app.get('/api/messages/:chatId', async (req, res) => {
  const { chatId } = req.params;
  try {
    let msgs = state.messages.get(chatId);
    if (!msgs || !msgs.length) {
      const chat = await wa.getChatById(chatId);
      const history = await chat.fetchMessages({ limit: 50 });
      msgs = history.map(m => ({
        id: m.id._serialized,
        from: m.from,
        body: m.body,
        t: m.timestamp * 1000,
        fromMe: m.fromMe
      }));
      state.messages.set(chatId, msgs);
    }
    res.json(msgs.sort((a, b) => a.t - b.t));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Enviar respuesta a chat existente
app.post('/api/send', async (req, res) => {
  try {
    const { chatId, text } = req.body || {};
    if (!chatId || !text) return res.status(400).json({ error: 'Faltan parámetros' });

    await wa.sendMessage(chatId, text);

    const local = { id: 'local-' + Date.now(), from: chatId, body: text, t: Date.now(), fromMe: true };
    pushMessage(chatId, local);
    io.to(chatId).emit('new-message', { chatId, ...local });

    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/send error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Enviar primer mensaje a un contacto (sin chat previo)
app.post('/api/send-to', async (req, res) => {
  try {
    const { contactId, text } = req.body || {};
    if (!contactId || !text) return res.status(400).json({ error: 'Faltan parámetros' });
    await wa.sendMessage(contactId, text);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/send-to error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Listar contactos
app.get('/api/contacts', async (_req, res) => {
  try {
    const contacts = await wa.getContacts();
    const data = contacts.map(c => ({
      id: c.id._serialized,                  // ej. 5215551234567@c.us
      number: c.number || c.id.user,         // solo dígitos
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

// Crear contacto y abrir conversación (envía primer mensaje)
app.post('/api/new-contact', async (req, res) => {
  try {
    const { name, number, firstMessage } = req.body || {};
    if (!name || !number) return res.status(400).json({ error: 'Faltan nombre y número' });

    const onlyDigits = String(number).replace(/\D+/g, '');
    const check = await wa.getNumberId(onlyDigits.startsWith('52') ? onlyDigits : `52${onlyDigits}`);
    if (!check) return res.status(404).json({ error: 'Ese número no tiene WhatsApp' });

    const chatId = check._serialized; // p.ej. 525512345678@c.us
    const text = (firstMessage && firstMessage.trim()) || `Hola ${name}, ¡bienvenido(a)!`;

    await wa.sendMessage(chatId, text);

    if (!state.chats.has(chatId)) {
      state.chats.set(chatId, { id: chatId, name, isGroup: false });
    }

    const local = { id: 'local-' + Date.now(), from: chatId, body: text, t: Date.now(), fromMe: true };
    pushMessage(chatId, local);

    io.emit('chats', visibleChatsArray());
    io.to(chatId).emit('new-message', { chatId, ...local });

    res.json({ ok: true, chatId });
  } catch (e) {
    console.error('POST /api/new-contact error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- API Bot: subir/activar reglas, desactivar, estado ----------
app.post('/api/bot/upload', (req, res) => {
  try {
    const { welcome, rules } = req.body || {};
    if (!Array.isArray(rules)) return res.status(400).json({ error: 'El JSON debe traer "rules" como arreglo.' });

    for (const r of rules) {
      if (!r || typeof r.reply !== 'string') return res.status(400).json({ error: 'Cada regla debe tener "reply" (string).' });
      if (!r.type) r.type = 'includes';
      if (typeof r.match !== 'string') r.match = '';
      // actions opcional
    }

    botState.welcome = (typeof welcome === 'string' && welcome.trim()) ? welcome.trim() : null;
    botState.rules = rules;
    botState.enabled = true;

    saveTriggers(botTriggeredOnce); // no limpiamos historial de activados

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

// ---------- Olvidar/ocultar chat (soft-delete SIN tocar WhatsApp) ----------
app.post('/api/forget-chat', async (req, res) => {
  try {
    let { chatId, number } = req.body || {};
    if (!chatId && !number) return res.status(400).json({ error: 'Falta chatId o number' });

    if (!chatId && number) chatId = normalizeToMXWid(number);
    if (!chatId) return res.status(400).json({ error: 'Número inválido' });

    // 1) Elimina de memoria del panel
    state.chats.delete(chatId);
    state.messages.delete(chatId);

    // 2) Limpiar trigger para reactivar el bot la próxima vez
    if (botTriggeredOnce instanceof Set) {
      botTriggeredOnce.delete(chatId);
      saveTriggers(botTriggeredOnce);
    }

    // 3) Marcar como oculto (soft-delete)
    hiddenChats.add(chatId);
    saveHidden(hiddenChats);

    // 4) Refrescar panel (solo visibles)
    io.emit('chats', visibleChatsArray());

    return res.json({ ok: true, chatId, note: 'Olvidado y oculto solo en el sistema (no se tocó WhatsApp).' });
  } catch (e) {
    console.error('POST /api/forget-chat error:', e);
    return res.status(500).json({ error: e.message || 'Error al olvidar chat' });
  }
});

// ---------- Wrapper GET (prueba desde navegador): /api/forget-chat?number=... ----------
app.get('/api/forget-chat', async (req, res) => {
  try {
    let { chatId, number } = req.query || {};
    if (!chatId && !number) return res.status(400).json({ error: 'Falta chatId o number' });

    if (!chatId && number) chatId = normalizeToMXWid(number);
    if (!chatId) return res.status(400).json({ error: 'Número inválido' });

    state.chats.delete(chatId);
    state.messages.delete(chatId);

    if (botTriggeredOnce instanceof Set) {
      botTriggeredOnce.delete(chatId);
      saveTriggers(botTriggeredOnce);
    }

    hiddenChats.add(chatId);
    saveHidden(hiddenChats);

    io.emit('chats', visibleChatsArray());
    return res.json({ ok: true, chatId, note: 'Olvidado y oculto via GET (solo sistema).' });
  } catch (e) {
    console.error('GET /api/forget-chat error:', e);
    return res.status(500).json({ error: e.message || 'Error al olvidar chat (GET)' });
  }
});

// ---------- Catch-all de API inexistente (devuelve JSON, no HTML) ----------
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'Ruta de API no encontrada',
    method: req.method,
    path: req.originalUrl
  });
});

// ---------- Socket.IO (panel) ----------
io.on('connection', (socket) => {
  socket.emit('chats', visibleChatsArray());

  wa.getState().then(s => { if (s) socket.emit('ready'); }).catch(()=>{});
  console.log('👤 Panel conectado');

  socket.on('join-chat', (chatId) => socket.join(chatId));
  socket.on('leave-chat', (chatId) => socket.leave(chatId));

  socket.on('disconnect', () => {
    console.log('👤 Panel desconectado');
  });
});

// ---------- Arranque del servidor ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 CRM corriendo en http://localhost:${PORT}`));
// Eliminar cualquier número del sistema (soft-delete total)
app.post('/api/remove-number', async (req, res) => {
  try {
    const { number } = req.body || {};
    if (!number) return res.status(400).json({ error: 'Falta el número a eliminar' });

    // Normaliza número a formato WhatsApp ID (ej. 5215551234567@c.us)
    const wid = normalizeToMXWid(number);
    if (!wid) return res.status(400).json({ error: 'Número inválido' });

    // Marcar como oculto
    hiddenChats.add(wid);
    saveHidden(hiddenChats);

    // Eliminar del registro de disparo del bot
    botTriggeredOnce.delete(wid);
    saveTriggers(botTriggeredOnce);

    // Quitar del estado en memoria
    state.chats.delete(wid);
    state.messages.delete(wid);
    state.assignments.delete(wid);

    // Notificar al panel (actualiza lista de chats)
    io.emit('chats', Array.from(state.chats.values()));

    console.log(`🗑️ Número eliminado del sistema: ${wid}`);
    res.json({ ok: true, removed: wid });
  } catch (e) {
    console.error('POST /api/remove-number error:', e);
    res.status(500).json({ error: e.message });
  }
});
