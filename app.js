const teamTabs = document.getElementById('team-tabs');
const teamPanel = document.getElementById('team-panel');
const teamArt = document.getElementById('team-art');
const messageFeed = document.getElementById('message-feed');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const notice = document.getElementById('notice');
const imageInput = document.getElementById('team-image-input');
const imageStoreKey = 'pitwall-team-images-v1';
const selectionStoreKey = 'pitwall-selected-team-v1';
const messageStoreName = 'pitwall-messages';
const syncTag = 'pitwall-message-sync';

let teams = [];
let selectedIndex = 0;
let db;
let noticeTimer;
let installPrompt;
let syncFailed = false;

function openMessageStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(messageStoreName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeRequest(mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('messages', mode);
    const request = operation(transaction.objectStore('messages'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function allMessages() {
  return storeRequest('readonly', (store) => store.getAll());
}

function showNotice(text) {
  notice.textContent = text;
  notice.classList.add('show');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.remove('show'), 3600);
}

function currentTeam() {
  return teams[selectedIndex];
}

function getImages() {
  try { return JSON.parse(localStorage.getItem(imageStoreKey) || '{}'); }
  catch { return {}; }
}

function renderTabs() {
  teamTabs.replaceChildren();
  teams.forEach((team, index) => {
    const button = document.createElement('button');
    button.className = 'team-tab';
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-current', String(index === selectedIndex));
    button.setAttribute('aria-selected', String(index === selectedIndex));
    button.textContent = team.name;
    button.addEventListener('click', () => selectTeam(index));
    teamTabs.append(button);
  });
}

function renderTeam() {
  const team = currentTeam();
  if (!team) return;
  const images = getImages();
  teamPanel.style.setProperty('--team', team.colors[0]);
  document.documentElement.style.setProperty('--team', team.colors[0]);
  document.getElementById('art-code').textContent = team.short;
  document.getElementById('art-name').textContent = team.name;
  document.getElementById('art-kicker').textContent = `Escudería ${String(selectedIndex + 1).padStart(2, '0')}`;
  document.getElementById('team-number').textContent = `Equipo ${String(selectedIndex + 1).padStart(2, '0')} / ${teams.length}`;
  document.getElementById('team-name').textContent = team.name;
  document.getElementById('team-alias').textContent = team.alias;
  document.getElementById('team-description').textContent = team.description;
  document.getElementById('recipient-name').textContent = team.name;
  document.getElementById('team-count').textContent = `${teamTabs.children.length || teams.length} equipos`;
  document.getElementById('team-palette').replaceChildren(...team.colors.map((color) => {
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.backgroundColor = color;
    swatch.title = color;
    swatch.setAttribute('aria-label', color);
    return swatch;
  }));
  const imageButton = document.getElementById('remove-image');
  imageButton.hidden = !images[team.id];
  teamArt.classList.toggle('has-image', Boolean(images[team.id]));
  teamArt.style.backgroundImage = images[team.id]
    ? `linear-gradient(0deg, #10141366, #10141311), url("${images[team.id]}")`
    : '';
  renderTabs();
  renderMessages();
}

function selectTeam(index) {
  selectedIndex = (index + teams.length) % teams.length;
  localStorage.setItem(selectionStoreKey, currentTeam().id);
  renderTeam();
  teamPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

async function renderMessages() {
  if (!db || !currentTeam()) return;
  const messages = (await allMessages()).sort((left, right) => right.createdAt - left.createdAt);
  const mine = messages.filter((message) => message.teamId === currentTeam().id);
  messageFeed.replaceChildren();
  document.getElementById('message-count').textContent = String(mine.length);
  document.getElementById('queue-count').textContent = `${messages.filter((message) => message.status !== 'sent').length} en cola`;
  if (!mine.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-feed';
    empty.textContent = 'Todavía no hay mensajes para este equipo.';
    messageFeed.append(empty);
    return;
  }
  mine.forEach((message) => {
    const item = document.createElement('article');
    item.className = 'feed-item';
    const meta = document.createElement('div');
    meta.className = 'feed-meta';
    const recipient = document.createElement('strong');
    recipient.textContent = message.teamName;
    const time = document.createElement('time');
    time.dateTime = new Date(message.createdAt).toISOString();
    time.textContent = formatTime(message.createdAt);
    const body = document.createElement('p');
    body.textContent = message.body;
    const status = document.createElement('span');
    const sent = message.status === 'sent';
    const offline = !navigator.onLine;
    status.className = `status-pill${sent ? ' sent' : offline ? '' : ' sending'}`;
    const statusIcon = document.createElement('span');
    statusIcon.className = 'status-icon';
    statusIcon.setAttribute('aria-hidden', 'true');
    statusIcon.textContent = sent ? '✓' : offline ? '◷' : '↻';
    status.append(statusIcon, document.createTextNode(
      sent ? 'Enviado'
        : offline ? 'Sin conexión · esperando'
          : syncFailed ? 'No se pudo enviar · reintentando'
            : 'Enviando…'
    ));
    meta.append(recipient, time);
    item.append(meta, body, status);
    messageFeed.append(item);
  });
}

async function notifyMessageQueued(message) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({
      type: 'MESSAGE_QUEUED',
      id: message.id,
      teamName: message.teamName,
      body: message.body
    });
  } catch (error) {
    console.warn('No se pudo mostrar la notificación:', error);
  }
}

async function requestMessageSync() {
  syncFailed = false;
  renderMessages();

  if (!('serviceWorker' in navigator)) {
    showNotice('Este navegador no admite Service Workers para entregar mensajes.');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    if (navigator.onLine) {
      if (!registration.active) throw new Error('No hay un Service Worker activo.');
      registration.active.postMessage({ type: 'SYNC_MESSAGES' });
      showNotice('Sincronizando los mensajes guardados en este dispositivo.');
    } else if ('sync' in registration) {
      await registration.sync.register(syncTag);
      showNotice('Mensaje guardado. Se sincronizará al recuperar la conexión.');
    } else {
      showNotice('Sin conexión. El mensaje se sincronizará al volver a conectarte.');
    }
  } catch (error) {
    console.error('No se pudo solicitar la sincronización:', error);
    showNotice('El mensaje quedó guardado, pero no se pudo iniciar la sincronización.');
  }
}

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = messageInput.value.trim();
  if (!body || !currentTeam()) return;
  const message = {
    id: crypto.randomUUID(),
    teamId: currentTeam().id,
    teamName: currentTeam().name,
    body,
    createdAt: Date.now(),
    status: 'pending'
  };
  try {
    await storeRequest('readwrite', (store) => store.add(message));
    messageInput.value = '';
    await renderMessages();
    await notifyMessageQueued(message);
    await requestMessageSync();
  } catch (error) {
    console.error('No se pudo guardar el mensaje:', error);
    showNotice('No se pudo guardar el mensaje. Revisa el espacio disponible.');
  }
});

document.getElementById('previous-team').addEventListener('click', () => selectTeam(selectedIndex - 1));
document.getElementById('next-team').addEventListener('click', () => selectTeam(selectedIndex + 1));

document.getElementById('choose-image').addEventListener('click', () => imageInput.click());
document.getElementById('remove-image').addEventListener('click', () => {
  const images = getImages();
  delete images[currentTeam().id];
  localStorage.setItem(imageStoreKey, JSON.stringify(images));
  renderTeam();
});

imageInput.addEventListener('change', () => {
  const file = imageInput.files && imageInput.files[0];
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onerror = () => showNotice('No se pudo leer esa imagen.');
  reader.onload = () => {
    const image = new Image();
    image.onerror = () => showNotice('El archivo no parece ser una imagen válida.');
    image.onload = () => {
      const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const images = getImages();
      images[currentTeam().id] = canvas.toDataURL('image/jpeg', 0.82);
      try {
        localStorage.setItem(imageStoreKey, JSON.stringify(images));
        renderTeam();
        showNotice(`Imagen guardada para ${currentTeam().name} en este dispositivo.`);
      } catch {
        showNotice('No hay espacio suficiente para guardar esta imagen.');
      }
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
  imageInput.value = '';
});

document.getElementById('notification-btn').addEventListener('click', async (event) => {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    showNotice('Este navegador no admite notificaciones.');
    return;
  }
  const permission = await Notification.requestPermission();
  const enabled = permission === 'granted';
  event.currentTarget.setAttribute('aria-pressed', String(enabled));
  event.currentTarget.textContent = enabled ? 'Notificaciones activadas' : 'Activar notificaciones';
  showNotice(enabled ? 'Los avisos locales están activados en este dispositivo.' : 'No se concedió permiso para notificaciones.');
});

document.getElementById('sync-btn').addEventListener('click', async () => {
  await requestMessageSync();
});

window.addEventListener('online', () => {
  const network = document.getElementById('network-status');
  network.textContent = 'Con conexión';
  network.classList.remove('offline');
  renderMessages();
  requestMessageSync();
});
window.addEventListener('offline', () => {
  const network = document.getElementById('network-status');
  network.textContent = 'Sin conexión';
  network.classList.add('offline');
  renderMessages();
});

navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'SYNC_COMPLETE') {
    renderMessages();
    showNotice(event.data.message || 'Sincronización completada.');
  } else if (event.data?.type === 'SYNC_FAILED') {
    syncFailed = true;
    renderMessages();
    showNotice('No se pudo sincronizar. Se volverá a intentar al recuperar la conexión.');
  }
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  document.getElementById('install-btn').classList.add('visible');
});

document.getElementById('install-btn').addEventListener('click', async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  installPrompt = null;
  document.getElementById('install-btn').classList.remove('visible');
});

async function startApp() {
  db = await openMessageStore();
  const response = await fetch('./dato.json');
  if (!response.ok) throw new Error('No se pudieron cargar los equipos.');
  teams = await response.json();
  const savedTeam = localStorage.getItem(selectionStoreKey);
  const savedIndex = teams.findIndex((team) => team.id === savedTeam);
  selectedIndex = savedIndex >= 0 ? savedIndex : 0;
  if (!navigator.onLine) {
    document.getElementById('network-status').textContent = 'Sin conexión';
    document.getElementById('network-status').classList.add('offline');
  }
  renderTeam();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.error('Error al registrar el Service Worker:', error);
      showNotice('No se pudo preparar el modo sin conexión. Abre la app desde localhost o HTTPS.');
    });
  }
}

startApp().catch((error) => {
  console.error(error);
  showNotice('No se pudo iniciar Pitwall. Conéctate una vez para cargar los equipos.');
});