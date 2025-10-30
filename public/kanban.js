// public/kanban.js
// Kanban con persistencia en server (columnas + tarjetas)
(() => {
  const socket         = io({ transports: ['websocket'] });
  const statusEl       = document.getElementById('status');
  const contactList    = document.getElementById('contactList');
  const searchContacts = document.getElementById('searchContacts');
  const kanbanEl       = document.getElementById('kanban');
  const emptyHint      = document.getElementById('emptyHint');
  const btnAddLane     = document.getElementById('btnAddLane');
  const lanesInfo      = document.getElementById('lanesInfo');

  let allChats    = [];
  let kanbanItems = [];
  let lanes       = [];

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t;
  }
  function esc(s) {
    return String(s || '').replace(/[&<>"]/g, m => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'
    }[m]));
  }

  // =========================================
  // CONTACTOS (lado izq)
  // =========================================
  function renderContacts(filter = '') {
    if (!contactList) return;
    const q = filter.trim().toLowerCase();
    const usedIds = new Set(kanbanItems.map(i => i.id));
    const noLanes = lanes.length === 0;

    const list = allChats.filter(c => {
      if (!q) return true;
      const n = (c.name || '').toLowerCase();
      const id = (c.id || '').toLowerCase();
      const num = (c.number || '').toLowerCase();
      return n.includes(q) || id.includes(q) || num.includes(q);
    });

    if (!list.length) {
      contactList.innerHTML = `<div style="padding:10px;font-size:12px;color:#94a3b8;">(Aún no hay chats cargados)</div>`;
      return;
    }

    contactList.innerHTML = list.map(c => {
      const inBoard = usedIds.has(c.id);
      const disabled = noLanes;
      const btnLabel = disabled ? 'Sin tablero' : (inBoard ? 'En tablero' : '➕');
      return `
        <div class="contact-item" draggable="${!disabled}">
          <div class="contact-top">
            <div class="contact-name" title="${esc(c.name || c.id)}">${esc(c.name || c.id)}</div>
            <button class="contact-add" data-id="${esc(c.id)}" ${disabled ? 'disabled style="opacity:.35;cursor:not-allowed;"' : (inBoard ? 'disabled style="opacity:.35;cursor:not-allowed;"' : '')}>
              ${btnLabel}
            </button>
          </div>
          <div class="contact-id">${esc(c.id)}</div>
          <input type="hidden" class="contact-value" value="${esc(c.id)}" />
        </div>
      `;
    }).join('');

    // botón +
    contactList.querySelectorAll('.contact-add').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (!id) return;
        if (!lanes.length) {
          alert('Primero crea un tablero (columna).');
          return;
        }
        const c = allChats.find(x => x.id === id);
        const title = c ? (c.name || c.id) : id;
        const firstLane = lanes[0];

        upsertLocalCard({ id, title, lane: firstLane.id });

        fetch('/api/kanban/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json'},
          body: JSON.stringify({ id, title, lane: firstLane.id })
        }).catch(()=>{});
      });
    });

    // drag desde contactos
    contactList.querySelectorAll('.contact-item').forEach(item => {
      if (!lanes.length) return;
      item.addEventListener('dragstart', (ev) => {
        const hidden = item.querySelector('.contact-value');
        const chatId = hidden ? hidden.value : '';
        if (!chatId) return;
        ev.dataTransfer.setData('text/plain', chatId);
        ev.dataTransfer.effectAllowed = 'move';
      });
    });
  }

  // =========================================
  // HELPERS
  // =========================================
  function upsertLocalCard(item) {
    const i = kanbanItems.findIndex(x => x.id === item.id);
    if (i === -1) {
      kanbanItems.push(item);
    } else {
      kanbanItems[i] = item;
    }
    renderKanban();
    renderContacts(searchContacts ? searchContacts.value || '' : '');
  }

  function setLanes(newLanes) {
    // ordenar por order si viene
    lanes = Array.isArray(newLanes) ? [...newLanes].sort((a,b) => {
      const ao = typeof a.order === 'number' ? a.order : 9999;
      const bo = typeof b.order === 'number' ? b.order : 9999;
      return ao - bo;
    }) : [];
    renderKanban();
    renderContacts(searchContacts ? searchContacts.value || '' : '');
  }

  // =========================================
  // RENDER KANBAN
  // =========================================
  function renderKanban() {
    if (!kanbanEl) return;
    kanbanEl.innerHTML = '';

    if (!lanes.length) {
      if (emptyHint) emptyHint.style.display = 'block';
      if (lanesInfo) lanesInfo.textContent = '';
      return;
    } else {
      if (emptyHint) emptyHint.style.display = 'none';
      if (lanesInfo) lanesInfo.textContent = `${lanes.length} tablero(s)`;
    }

    lanes.forEach(lane => {
      const laneEl = document.createElement('div');
      laneEl.className = 'lane';
      laneEl.dataset.lane = lane.id;

      const header = document.createElement('div');
      header.className = 'lane-header';

      const titleInput = document.createElement('input');
      titleInput.className = 'lane-title-input';
      titleInput.value = lane.label;
      titleInput.addEventListener('change', () => {
        lane.label = titleInput.value || lane.id;
        renderKanban();
        // 👉 guardar nombre de columna
        fetch('/api/kanban/lanes/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json'},
          body: JSON.stringify({ id: lane.id, label: lane.label, order: lane.order ?? 0 })
        }).catch(()=>{});
      });

      const btns = document.createElement('div');
      btns.className = 'lane-btns';

      const addCardBtn = document.createElement('button');
      addCardBtn.className = 'lane-icon-btn';
      addCardBtn.textContent = '+';
      addCardBtn.title = 'Agregar tarjeta aquí';
      addCardBtn.onclick = () => {
        const t = prompt('Título de la tarjeta:');
        if (!t) return;
        const fakeId = 'local-' + Date.now();
        upsertLocalCard({ id: fakeId, title: t, lane: lane.id });
        fetch('/api/kanban/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json'},
          body: JSON.stringify({ id: fakeId, title: t, lane: lane.id })
        }).catch(()=>{});
      };

      const delLaneBtn = document.createElement('button');
      delLaneBtn.className = 'lane-icon-btn';
      delLaneBtn.textContent = '×';
      delLaneBtn.title = 'Eliminar tablero';
      delLaneBtn.onclick = () => {
        if (!confirm('¿Eliminar este tablero y sus tarjetas?')) return;

        // quitar local
        kanbanItems = kanbanItems.filter(it => it.lane !== lane.id);
        lanes = lanes.filter(l => l.id !== lane.id);
        renderKanban();
        renderContacts(searchContacts ? searchContacts.value || '' : '');

        // avisar al server
        fetch('/api/kanban/lanes/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json'},
          body: JSON.stringify({ id: lane.id })
        }).catch(()=>{});
      };

      btns.appendChild(addCardBtn);
      btns.appendChild(delLaneBtn);

      header.appendChild(titleInput);
      header.appendChild(btns);

      const cardsBox = document.createElement('div');
      cardsBox.className = 'cards';

      const items = kanbanItems.filter(i => i.lane === lane.id);
      items.forEach(it => {
        const card = document.createElement('div');
        card.className = 'card';
        card.draggable = true;
        card.dataset.id = it.id;

        const ct = document.createElement('div');
        ct.className = 'card-title';
        ct.innerHTML = `${esc(it.title || it.id)}<small>${esc(it.id)}</small>`;
        ct.ondblclick = () => {
          const nuevo = prompt('Nuevo título:', it.title || it.id);
          if (!nuevo) return;
          upsertLocalCard({ id: it.id, title: nuevo, lane: it.lane });
          fetch('/api/kanban/upsert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json'},
            body: JSON.stringify({ id: it.id, title: nuevo, lane: it.lane })
          }).catch(()=>{});
        };

        const actions = document.createElement('div');
        actions.className = 'card-actions';

        const del = document.createElement('button');
        del.className = 'card-btn';
        del.textContent = '×';
        del.title = 'Quitar tarjeta';
        del.onclick = () => {
          kanbanItems = kanbanItems.filter(x => x.id !== it.id);
          renderKanban();
          renderContacts(searchContacts ? searchContacts.value || '' : '');
          fetch('/api/kanban/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json'},
            body: JSON.stringify({ id: it.id })
          }).catch(()=>{});
        };

        actions.appendChild(del);

        card.appendChild(ct);
        card.appendChild(actions);

        // drag de tarjeta
        card.addEventListener('dragstart', (ev) => {
          ev.dataTransfer.setData('text/plain', it.id);
          ev.dataTransfer.effectAllowed = 'move';
        });

        cardsBox.appendChild(card);
      });

      // drop en columna
      laneEl.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        laneEl.classList.add('drop-target');
      });
      laneEl.addEventListener('dragleave', () => {
        laneEl.classList.remove('drop-target');
      });
      laneEl.addEventListener('drop', (ev) => {
        ev.preventDefault();
        laneEl.classList.remove('drop-target');
        const droppedId = ev.dataTransfer.getData('text/plain');
        if (!droppedId) return;

        // 1) si ya existe la tarjeta → mover
        const existing = kanbanItems.find(x => x.id === droppedId);
        if (existing) {
          existing.lane = lane.id;
          renderKanban();
          renderContacts(searchContacts ? searchContacts.value || '' : '');
          // avisar al server
          socket.emit('kanban:move', { id: droppedId, lane: lane.id });
          return;
        }

        // 2) venía de contactos → crear tarjeta
        const contact = allChats.find(c => c.id === droppedId);
        const title = contact ? (contact.name || contact.id) : droppedId;

        upsertLocalCard({ id: droppedId, title, lane: lane.id });

        fetch('/api/kanban/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json'},
          body: JSON.stringify({ id: droppedId, title, lane: lane.id })
        }).catch(()=>{});
      });

      laneEl.appendChild(header);
      laneEl.appendChild(cardsBox);
      kanbanEl.appendChild(laneEl);
    });
  }

  // =========================================
  // SOCKETS
  // =========================================
  socket.on('connect', () => setStatus('Conectado al servidor'));
  socket.on('disconnect', () => setStatus('Desconectado'));
  socket.on('ready', () => setStatus('WhatsApp listo ✅'));

  socket.on('chats', (chats) => {
    const arr = Array.isArray(chats) ? chats : [];
    allChats = arr.map(c => ({
      id: c.id,
      name: c.name || c.id,
      isGroup: !!c.isGroup,
      number: (c.id || '').replace(/\D+/g, '')
    }));
    renderContacts(searchContacts ? searchContacts.value || '' : '');
  });

  // server manda TODAS las tarjetas
  socket.on('kanban:full', (items) => {
    kanbanItems = Array.isArray(items) ? items : [];
    renderKanban();
    renderContacts(searchContacts ? searchContacts.value || '' : '');
  });

  // server manda UNA tarjeta
  socket.on('kanban:upsert', (item) => {
    upsertLocalCard(item);
  });

  socket.on('kanban:delete', ({ id }) => {
    kanbanItems = kanbanItems.filter(x => x.id !== id);
    renderKanban();
    renderContacts(searchContacts ? searchContacts.value || '' : '');
  });

  // 👉 NUEVO: server manda columnas
  socket.on('kanban:lanes', (serverLanes) => {
    setLanes(serverLanes || []);
  });

  // =========================================
  // CARGA INICIAL (fetch)
  // =========================================
  // 1. columnas
  fetch('/api/kanban/lanes')
    .then(r => r.ok ? r.json() : { ok:false, lanes:[] })
    .then(data => {
      if (data && Array.isArray(data.lanes)) {
        setLanes(data.lanes);
      } else {
        setLanes([]);
      }
    })
    .catch(()=>{ setLanes([]); });

  // 2. tarjetas
  fetch('/api/kanban')
    .then(r => r.ok ? r.json() : { ok:false, items:[] })
    .then(data => {
      if (data && data.items) {
        kanbanItems = data.items;
        renderKanban();
        renderContacts(searchContacts ? searchContacts.value || '' : '');
      }
    })
    .catch(()=>{});

  // 3. chats (para el panel izquierdo)
  fetch('/api/chats')
    .then(r => r.ok ? r.json() : [])
    .then(data => {
      if (Array.isArray(data) && data.length) {
        allChats = data.map(c => ({
          id: c.id,
          name: c.name || c.id,
          isGroup: !!c.isGroup,
          number: (c.id || '').replace(/\D+/g, '')
        }));
        renderContacts(searchContacts ? searchContacts.value || '' : '');
      }
    })
    .catch(()=>{});

  // =========================================
  // BOTÓN "AGREGAR TABLERO"
  // =========================================
  if (btnAddLane) {
    btnAddLane.addEventListener('click', () => {
      const name = prompt('Nombre del tablero / columna:');
      if (!name) return;
      const laneId = 'lane-' + Date.now();
      const laneObj = { id: laneId, label: name, order: lanes.length };
      lanes.push(laneObj);
      renderKanban();
      renderContacts(searchContacts ? searchContacts.value || '' : '');
      // 👉 guardar en server
      fetch('/api/kanban/lanes/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify(laneObj)
      }).catch(()=>{});
    });
  }

  // =========================================
  // BUSCADOR
  // =========================================
  if (searchContacts) {
    searchContacts.addEventListener('input', () => {
      renderContacts(searchContacts.value || '');
    });
  }

})();
