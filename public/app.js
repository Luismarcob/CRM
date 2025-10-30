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

  // ====== KANBAN STATE ======
  // items: [{id, title, lane}]

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

  // ====== RENDER LISTA LATERAL (por si sigues usando la lista clásica) ======
  function renderList(arr) {
    if (!chatList) return;
    chatList.innerHTML = arr.map(c => {
      const label = c.name || c.id;
      const isActive = c.id === currentChatId;
      return `<li data-chat-id="${esc(c.id)}" class="${isActive ? 'active' : ''}">
        <div>${esc(label)}</div>
        <div style="font-size:11px;color:#64748b;">${c.isGroup ? 'Grupo' : 'Privado'} • ${esc(c.number || '')}</div>
      </li>`;
    }).join('');
  }

  function mergeAndRender() {
    const map = new Map();
    for (const c of allChats) map.set(c.id, c);
    for (const c of allContacts) if (!map.has(c.id)) map.set(c.id, c);
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
    if (cid) {
      const found = mergedList.find(x => x.id === cid);
      openChat(cid, found ? (found.name || found.id) : cid);
    }
  }

  // ====== KANBAN RENDER ======
  function renderKanban() {
    if (!kanbanEl) return;
    kanbanEl.innerHTML = '';
    lanesOrder.forEach(laneId => {
      const col = document.createElement('div');
      col.className = 'kanban-col';
      col.dataset.lane = laneId;
      col.style.minWidth = '220px';
      col.style.background = '#e2e8f0';
      col.style.borderRadius = '10px';
      col.style.padding = '6px';
      col.style.display = 'flex';
      col.style.flexDirection = 'column';
      col.style.maxHeight = '300px';
      col.style.overflowY = 'auto';

      const header = document.createElement('div');
      header.textContent = laneLabels[laneId] || laneId;
      header.style.fontWeight = '600';
      header.style.marginBottom = '4px';
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'center';

      // botón para crear directo en esta columna
      const addBtn = document.createElement('button');
      addBtn.textContent = '+';
      addBtn.style.border = 'none';
      addBtn.style.background = '#0f172a';
      addBtn.style.color = 'white';
      addBtn.style.borderRadius = '6px';
      addBtn.style.width = '22px';
      addBtn.style.height = '22px';
      addBtn.style.cursor = 'pointer';
      addBtn.onclick = () => {
        const title = prompt('Nombre de la tarjeta / conversación:');
        if (!title) return;
        const fakeId = 'local-' + Date.now();
        // mandamos al server
        fetch('/api/kanban/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json'},
          body: JSON.stringify({ id: fakeId, title, lane: laneId })
        }).catch(()=>{});
      };

      header.appendChild(addBtn);
      col.appendChild(header);

      const items = kanbanItems.filter(it => it.lane === laneId);
      items.forEach(it => {
        const card = document.createElement('div');
        card.className = 'kanban-card';
        card.draggable = true;
        card.dataset.id = it.id;
        card.style.background = '#ffffff';
        card.style.borderRadius = '8px';
        card.style.padding = '6px 8px';
        card.style.marginBottom = '6px';
        card.style.cursor = 'grab';
        card.style.display = 'flex';
        card.style.justifyContent = 'space-between';
        card.style.alignItems = 'center';
        card.style.gap = '4px';

        const title = document.createElement('div');
        title.textContent = it.title || it.id;
        title.style.flex = '1 1 auto';
        title.style.fontSize = '13px';
        title.style.wordBreak = 'break-word';
        title.ondblclick = () => {
          const nuevo = prompt('Nuevo nombre:', title.textContent);
          if (!nuevo) return;
          fetch('/api/kanban/upsert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json'},
            body: JSON.stringify({ id: it.id, title: nuevo, lane: it.lane })
          }).catch(()=>{});
        };

        const del = document.createElement('button');
        del.textContent = '×';
        del.style.border = 'none';
        del.style.background = 'transparent';
        del.style.cursor = 'pointer';
        del.style.color = '#ef4444';
        del.onclick = () => {
          if (!confirm('¿Eliminar esta tarjeta del kanban?')) return;
          fetch('/api/kanban/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json'},
            body: JSON.stringify({ id: it.id })
          }).catch(()=>{});
        };

        card.appendChild(title);
        card.appendChild(del);

        // drag events
        card.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.setData('text/plain', it.id);
          ev.dataTransfer.effectAllowed = 'move';
        });

        col.appendChild(card);
      });

      // drop column
      col.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        col.style.outline = '2px dashed #0f172a';
      });
      col.addEventListener('dragleave', () => {
        col.style.outline = 'none';
      });
      col.addEventListener('drop', (ev) => {
        ev.preventDefault();
        col.style.outline = 'none';
        const itemId = ev.dataTransfer.getData('text/plain');
        if (!itemId) return;
        // mandamos al server vía socket (para que rebote en todos)
        socket.emit('kanban:move', { id: itemId, lane: laneId });
      });

      kanbanEl.appendChild(col);
    });
  }

  // === SOCKET ===
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

  socket.on('chats', (chats) => {
    const arr = Array.isArray(chats) ? chats : [];
    allChats = arr.map(c => ({
      id: c.id,
      name: c.name || c.id,
      isGroup: !!c.isGroup,
      number: onlyDigits(c.id)
    }));
    mergeAndRender();

    if (currentChatId && !allChats.find(x => x.id === currentChatId)) {
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

  // 🔴 KANBAN SOCKET EVENTS
  socket.on('kanban:full', (items) => {
    kanbanItems = Array.isArray(items) ? items : [];
    renderKanban();
  });
  socket.on('kanban:upsert', (item) => {
    const idx = kanbanItems.findIndex(i => i.id === item.id);
    if (idx === -1) kanbanItems.push(item);
    else kanbanItems[idx] = item;
    renderKanban();
  });
  socket.on('kanban:delete', ({ id }) => {
    kanbanItems = kanbanItems.filter(it => it.id !== id);
    renderKanban();
  });

  // 🔴 MENSAJES NUEVOS
  socket.on('new-message', (m) => {
    if (m.chatId === currentChatId) addMessageToView(m);
    // si llega un mensaje de un chat que ya está en kanban, lo subimos visualmente
    const idx = kanbanItems.findIndex(it => it.id === m.chatId);
    if (idx !== -1) {
      // opcional: si llega mensaje lo mandamos a "en_proceso"
      kanbanItems[idx].lane = 'en_proceso';
      renderKanban();
    }
  });

  // ====== CLICK EN LISTA NORMAL ======
  if (chatList) {
    chatList.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-chat-id]');
      if (!li) return;
      const id = li.dataset.chatId;
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
        const name = (c.name || '').toLowerCase();
        const number = (c.number || '').toLowerCase();
        const id = (c.id || '').toLowerCase();
        return name.includes(q) || number.includes(q) || id.includes(q);
      });
      renderList(filtered);
    });
  }

})();
