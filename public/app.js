// public/app.js
// Mini CRM – WhatsApp
// Render de TEXTO + MEDIA + KANBAN de conversaciones

(() => {
  const socket = io({ transports: ['websocket'] });

  const statusEl    = document.getElementById('status');
  const qrBox       = document.getElementById('qrBox');
  const qrCanvas    = document.getElementById('qrCanvas');
  const chatList    = document.getElementById('chatList');
  const messagesEl  = document.getElementById('messages');
  const composerEl  = document.getElementById('composer');
  const welcomeEl   = document.getElementById('welcome');
  const searchInput = document.getElementById('searchChat');

  let allChats = [];
  let allContacts = [];
  let mergedList = [];
  let currentChatId = null;

  // 🔴 nuevo: aquí guardamos lo que el usuario ya eliminó/ocultó en el index
  const hiddenLocal = new Set();

  function setStatus(txt) {
    if (statusEl) statusEl.textContent = txt;
  }
  function onlyDigits(s) {
    return String(s || '').replace(/\D+/g, '');
  }
  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, m => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'
    }[m]));
  }

  // ====== MENSAJES DEL CHAT ======
  function addMessageToView(m) {
    if (!messagesEl) return;

    const side = m.fromMe ? 'out' : 'in';
    const time = m.t ? new Date(m.t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';

    let content = '';

    if (m.body) {
      content += `<div class="text">${esc(m.body)}</div>`;
    }

    if (m.media && m.media.url) {
      const mime = m.media.mimetype || '';
      const url  = esc(m.media.url);
      if (mime.startsWith('image/')) {
        content += `<img src="${url}" alt="imagen" style="max-width:260px;border-radius:8px;margin-top:4px;display:block;">`;
      } else if (mime.startsWith('video/')) {
        content += `<video src="${url}" controls style="max-width:260px;border-radius:8px;margin-top:4px;display:block;"></video>`;
      } else if (mime.startsWith('audio/')) {
        content += `<audio controls style="margin-top:4px;max-width:260px;display:block;">
          <source src="${url}" type="${mime}">
          Tu navegador no soporta audio.
        </audio>`;
      } else {
        const name = m.media.filename || 'Archivo adjunto';
        content += `<a href="${url}" target="_blank" style="display:inline-block;margin-top:4px;color:#2563eb;text-decoration:none;">📎 ${esc(name)}</a>`;
      }
    }

    if (!m.media && m.body && m.body.trim() === '[Adjunto]') {
      content += `<div style="margin-top:4px;font-size:12px;color:#64748b;">(Adjunto recibido en WhatsApp)</div>`;
    }

    const div = document.createElement('div');
    div.className = `msg ${side}`;
    div.innerHTML = `<div class="bubble">${content}<div class="meta">${time}</div></div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function getCurrentChatId() {
    const active = document.querySelector('#chatList .active');
    if (active && active.dataset.chatId) return active.dataset.chatId;
    if (window.__currentChatId) return window.__currentChatId;
    try {
      const url = new URL(window.location.href);
      const qs = url.searchParams.get('chatId');
      if (qs) return qs;
    } catch {}
    try {
      const stored = localStorage.getItem('openChatId');
      if (stored) return stored;
    } catch {}
    return '';
  }

  // ====== RENDER LISTA LATERAL ======
  function renderList(arr) {
    if (!chatList) return;
    chatList.innerHTML = arr
      .filter(c => !hiddenLocal.has(c.id)) // 🔴 no mostrar los que ya borraste
      .map(c => {
        const label = c.name || c.id;
        const isActive = c.id === currentChatId;
        return `<li data-chat-id="${esc(c.id)}" class="${isActive ? 'active' : ''}">
          <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;">
            <div>
              <div>${esc(label)}</div>
              <div style="font-size:11px;color:#64748b;">${c.isGroup ? 'Grupo' : 'Privado'} • ${esc(c.number || '')}</div>
            </div>
            <button data-del="${esc(c.id)}" style="border:none;background:transparent;color:#ef4444;font-size:16px;cursor:pointer;line-height:1;">×</button>
          </div>
        </li>`;
      }).join('');
  }

  function mergeAndRender() {
    const map = new Map();
    // 1) los chats reales que manda el server
    for (const c of allChats) map.set(c.id, c);
    // 2) los contactos de WA, PERO solo si no están ocultos
    for (const c of allContacts) {
      if (hiddenLocal.has(c.id)) continue; // 🔴 no lo reinsertes
      if (!map.has(c.id)) map.set(c.id, c);
    }
    mergedList = Array.from(map.values());
    renderList(mergedList);
  }

  async function reloadChats() {
    try {
      const res = await fetch('/api/chats');
      if (!res.ok) return;
      const payload = await res.json();
      const items = Array.isArray(payload) ? payload : (payload.items || []);
      allChats = items.map(c => ({
        id: c.id,
        name: c.name || c.id,
        isGroup: !!c.isGroup,
        number: onlyDigits(c.id)
      }));
      await fetchContactsOnce();
      mergeAndRender();
    } catch (e) {
      console.warn('Error al recargar chats:', e);
    }
  }

  async function fetchContactsOnce() {
    if (allContacts.length) return;
    try {
      const res = await fetch('/api/contacts');
      if (!res.ok) return;
      const contacts = await res.json();
      allContacts = (contacts || []).map(ct => ({
        id: ct.id,
        name: ct.name || ct.number || ct.id,
        isGroup: false,
        number: onlyDigits(ct.number || ct.id)
      }));
    } catch (e) {
      console.warn('fetch /api/contacts error:', e);
    }
  }

  async function openChat(chatId, label='') {
    if (!chatId) return;
    if (currentChatId) socket.emit('leave-chat', currentChatId);
    currentChatId = chatId;
    socket.emit('join-chat', chatId);

    try {
      localStorage.setItem('openChatId', chatId);
      localStorage.setItem('openChatName', label || chatId);
    } catch {}

    window.__currentChatId = chatId;

    if (welcomeEl) welcomeEl.classList.add('hidden');
    if (composerEl) composerEl.classList.remove('hidden');

    const lis = document.querySelectorAll('#chatList li');
    lis.forEach(li => {
      li.classList.toggle('active', li.dataset.chatId === chatId);
    });

    try {
      const res = await fetch(`/api/messages/${encodeURIComponent(chatId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const msgs = await res.json();
      messagesEl.innerHTML = '';
      (msgs || []).forEach(addMessageToView);
    } catch (e) {
      messagesEl.innerHTML = `<div class="error">No se pudieron cargar los mensajes: ${esc(e.message)}</div>`;
    }
  }

  function openFromQueryOrStorage() {
    const cid = getCurrentChatId();
    if (cid && !hiddenLocal.has(cid)) {
      const found = mergedList.find(x => x.id === cid);
      openChat(cid, found ? (found.name || found.id) : cid);
    }
  }

  // ====== SOCKET ======
  socket.on('connect', async () => {
    setStatus('Conectado al servidor');
    await reloadChats();
  });

  socket.on('disconnect', () => {
    setStatus('Desconectado');
  });

  socket.on('ready', () => {
    setStatus('WhatsApp listo ✅');
    if (qrBox) qrBox.classList.add('hidden');

    fetch('/api/chats?offset=0&limit=30')
      .then(r => r.ok ? r.json() : {items: [], total: 0})
      .then(payload => {
        const items = Array.isArray(payload) ? payload : (payload.items || []);
        allChats = items.map(c => ({
          id: c.id,
          name: c.name || c.id,
          isGroup: !!c.isGroup,
          number: onlyDigits(c.id)
        }));
        mergeAndRender();
        openFromQueryOrStorage();
      })
      .catch(() => {});
  });

  socket.on('qr', async (qr) => {
    setStatus('Escanea el QR para vincular WhatsApp');
    if (qrBox) qrBox.classList.remove('hidden');
    try {
      const QRCode = await import('https://cdn.skypack.dev/qrcode');
      QRCode.toCanvas(qrCanvas, qr, { width: 220, margin: 1 }, (err)=>{
        if (err) console.error(err);
      });
    } catch(e) {
      const ctx = qrCanvas.getContext('2d');
      ctx.font = '12px monospace';
      ctx.fillText('QR visible en terminal del servidor', 10, 20);
    }
  });

  // cuando el server diga “estos son los chats visibles”, no vuelvas a mostrar los ocultos
  socket.on('chats', (chats) => {
    const arr = Array.isArray(chats) ? chats : [];
    allChats = arr.map(c => ({
      id: c.id,
      name: c.name || c.id,
      isGroup: !!c.isGroup,
      number: onlyDigits(c.id)
    }));
    mergeAndRender();

    if (currentChatId && !allChats.find(x => x.id === currentChatId) && !hiddenLocal.has(currentChatId)) {
      currentChatId = null;
      if (messagesEl) messagesEl.innerHTML = '';
      if (composerEl) composerEl.classList.add('hidden');
      if (welcomeEl) welcomeEl.classList.remove('hidden');
      setStatus('Selecciona un chat para comenzar.');
      try {
        localStorage.removeItem('openChatId');
        localStorage.removeItem('openChatName');
      } catch {}
      window.__currentChatId = '';
    }
  });

  // ====== CLICK EN LISTA ======
  if (chatList) {
    chatList.addEventListener('click', async (e) => {
      const delBtn = e.target.closest('button[data-del]');
      if (delBtn) {
        const id = delBtn.dataset.del;
        // 1) pide al server que lo olvide
        try {
          await fetch('/api/forget-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: id })
          });
        } catch {}
        // 2) y aquí lo ocultamos para SIEMPRE en este index
        hiddenLocal.add(id);
        // si estabas dentro de ese chat, límpialo
        if (currentChatId === id) {
          currentChatId = null;
          if (messagesEl) messagesEl.innerHTML = '';
          if (composerEl) composerEl.classList.add('hidden');
          if (welcomeEl) welcomeEl.classList.remove('hidden');
          try {
            localStorage.removeItem('openChatId');
            localStorage.removeItem('openChatName');
          } catch {}
        }
        mergeAndRender();
        return;
      }

      const li = e.target.closest('li[data-chat-id]');
      if (!li) return;
      const id = li.dataset.chatId;
      if (hiddenLocal.has(id)) return;
      const c = mergedList.find(x => x.id === id);
      openChat(id, c ? (c.name || c.id) : id);
    });
  }

  // ====== ENVIAR TEXTO ======
  if (composerEl) {
    const textEl = document.getElementById('text');
    composerEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = (textEl.value || '').trim();
      const chatId = getCurrentChatId();
      if (!text || !chatId) return;
      try {
        const res = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, text })
        });
        const data = await res.json().catch(()=> ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        textEl.value = '';
      } catch (err) {
        alert('Error enviando: ' + err.message);
      }
    });
  }

  // ====== BUSCADOR ======
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) {
        renderList(mergedList);
        return;
      }
      const filtered = mergedList.filter(c => {
        if (hiddenLocal.has(c.id)) return false;
        const name = (c.name || '').toLowerCase();
        const number = (c.number || '').toLowerCase();
        const id = (c.id || '').toLowerCase();
        return name.includes(q) || number.includes(q) || id.includes(q);
      });
      renderList(filtered);
    });
  }

})();
async function fetchContactsOnce() {
  if (allContacts.length) return;
  try {
    const res = await fetch('/api/contacts');
    if (!res.ok) return;
    const contacts = await res.json();
    allContacts = (contacts || [])
      .filter(ct => !hiddenLocal.has(ct.id)) // 👈 no reinsertes lo que el user ya borró
      .map(ct => ({
        id: ct.id,
        name: ct.name || ct.number || ct.id,
        isGroup: false,
        number: onlyDigits(ct.number || ct.id)
      }));
  } catch (e) {
    console.warn('fetch /api/contacts error:', e);
  }
}
