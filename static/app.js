const $ = (id) => document.getElementById(id);
const THEME_KITS = [
  { id: 'azul', name: 'Azul clásico', description: 'La apariencia original', colors: ['#1767cc', '#0f56aa', '#edf4f9'] },
  { id: 'esmeralda', name: 'Esmeralda', description: 'Fresco y sereno', colors: ['#16866f', '#0b6655', '#e8f6f2'] },
  { id: 'violeta', name: 'Violeta', description: 'Suave y moderno', colors: ['#7653c6', '#56379e', '#f1edfa'] },
  { id: 'coral', name: 'Coral', description: 'Cálido y sobrio', colors: ['#c45f50', '#984238', '#faefed'] }
];
let activeThemeKit = 'azul';
try { activeThemeKit = localStorage.getItem('asistencia-theme-kit') || 'azul'; } catch {}
if (!THEME_KITS.some(kit => kit.id === activeThemeKit)) activeThemeKit = 'azul';
document.documentElement.dataset.theme = activeThemeKit;
const appIntro = $('app-intro');
const introStartedAt = performance.now();
let overview = { students: [], subjects: [] };
let studentChoices = [];
let availableStudentChoices = [];
let currentSubject = 'all';
let reportSubject = 'all';
let reportStudent = 'all';
let addSubject = null;
let eventMonth = new Date();
eventMonth.setDate(1);
let calendarEvents = [];
let upcomingCalendarEvents = [];
let nextTestEvent = null;
let gradeSubjects = [];
let selectedEventDate = null;
const linkedEventDate = new URLSearchParams(location.search).get('event_date');
if (/^\d{4}-\d{2}-\d{2}$/.test(linkedEventDate || '')
    && !Number.isNaN(new Date(`${linkedEventDate}T12:00:00`).getTime())) {
  selectedEventDate = linkedEventDate;
  eventMonth = new Date(`${linkedEventDate}T12:00:00`);
  eventMonth.setDate(1);
}
let editingEventId = null;
let editingClassId = null;
let editingClassOriginal = null;
let adminState = { configured: false, authenticated: false };
let studentState = { authenticated: false, student_id: null, name: null };
let studentActivation = null;
let pendingProfileAvatar = '';
let avatarCropState = null;
let notificationConfig = null;
let nativePushActionsReady = false;
let headerGreetingTimer = null;
let headerGreetingCleanupTimer = null;

function resetHeaderTitle() {
  clearTimeout(headerGreetingTimer);
  clearTimeout(headerGreetingCleanupTimer);
  const title = $('header-title');
  title.classList.remove('header-title-animated', 'is-switching');
  title.textContent = 'Registro de asistencia';
}

function showHeaderGreeting(name, delay = 0) {
  clearTimeout(headerGreetingTimer);
  clearTimeout(headerGreetingCleanupTimer);
  const title = $('header-title');
  const begin = () => {
    const greeting = document.createElement('span');
    greeting.className = 'header-title-layer header-title-greeting';
    greeting.textContent = name ? `Hola, ${name}` : 'Bienvenido/a';
    const regularTitle = document.createElement('span');
    regularTitle.className = 'header-title-layer header-title-regular';
    regularTitle.textContent = 'Registro de asistencia';
    regularTitle.setAttribute('aria-hidden', 'true');
    title.replaceChildren(greeting, regularTitle);
    title.classList.add('header-title-animated');
    title.classList.remove('is-switching');
    headerGreetingTimer = setTimeout(() => {
      title.classList.add('is-switching');
      headerGreetingCleanupTimer = setTimeout(resetHeaderTitle, 600);
    }, 2500);
  };
  if (delay) headerGreetingTimer = setTimeout(begin, delay);
  else begin();
}

async function api(path, body, method = 'POST') {
  let response;
  try {
    response = await fetch(path, body === undefined && method === 'POST' ? undefined : {
      method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error(navigator.onLine
      ? 'No se pudo conectar con el servidor. Intenta nuevamente.'
      : 'No hay conexión a internet. Los cambios requieren conexión con el servidor.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación.');
  return data;
}

function message(text, isError = false) {
  const box = $('message');
  box.textContent = text;
  box.classList.toggle('error', isError);
  box.hidden = false;
  clearTimeout(message.timer);
  message.timer = setTimeout(() => box.hidden = true, 4500);
}

function profileSaveMessage(text, isError = false) {
  const box = $('profile-save-message');
  box.textContent = text;
  box.classList.toggle('error', isError);
  box.hidden = false;
}

function studentDialogMessage(text = '') {
  const box = $('student-dialog-message');
  box.textContent = text;
  box.hidden = !text;
}

function option(select, value, label) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = label;
  select.append(item);
}

function fillSelect(id, entries, placeholder, selected = '', firstValue = '') {
  const select = $(id);
  select.replaceChildren();
  option(select, firstValue, placeholder);
  entries.forEach(entry => option(select, entry.id, entry.name));
  select.value = String(selected || '');
}

function renderProfileSummary() {
  const summary = $('profile-session-summary');
  if (!summary) return;
  const sessions = [];
  if (studentState.authenticated) sessions.push(`Estudiante: ${studentState.name}`);
  if (adminState.authenticated) sessions.push('Administrador');
  summary.textContent = sessions.length ? `Sesión activa · ${sessions.join(' · ')}` : 'No has iniciado sesión.';
  const profileButton = $('profile-toggle');
  const avatar = studentState.authenticated ? studentState.avatar_data : '';
  profileButton.classList.toggle('has-avatar', Boolean(avatar));
  profileButton.classList.toggle('guest-avatar', !studentState.authenticated && !adminState.authenticated);
  profileButton.classList.toggle('admin-avatar', adminState.authenticated && !studentState.authenticated);
  profileButton.style.backgroundImage = avatar ? `url(${avatar})` : '';
  $('personal-profile').hidden = !studentState.authenticated;
  $('profile-login-required').hidden = studentState.authenticated;
  if (studentState.authenticated) {
    $('profile-name').value = studentState.name || '';
    $('profile-tagline').value = (studentState.tagline || '').slice(0, 50);
    pendingProfileAvatar = studentState.avatar_data || '';
    renderProfileAvatar();
    updateProfileTaglineCount();
  }
  renderExportChoices();
}

function renderProfileAvatar() {
  const image = $('profile-avatar-preview');
  const fallback = $('profile-avatar-fallback');
  image.hidden = !pendingProfileAvatar;
  fallback.hidden = Boolean(pendingProfileAvatar);
  if (pendingProfileAvatar) image.src = pendingProfileAvatar;
  fallback.textContent = (studentState.name || '?').trim().charAt(0).toUpperCase();
}

function updateProfileTaglineCount() {
  $('profile-tagline-count').textContent = `${$('profile-tagline').value.length}/50`;
}

function loadAvatarImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('Selecciona una imagen válida.')); return; }
    const source = new Image();
    const reader = new FileReader();
    source.onload = () => resolve(source);
    source.onerror = () => reject(new Error('No se pudo abrir la imagen. Usa una foto JPG, PNG o WebP.'));
    reader.onerror = () => reject(new Error('No se pudo leer el archivo seleccionado.'));
    reader.onload = () => { source.src = reader.result; };
    reader.readAsDataURL(file);
  });
}

function clampAvatarCrop() {
  if (!avatarCropState) return;
  const { image, zoom } = avatarCropState;
  const canvas = $('avatar-crop-canvas');
  const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight) * zoom;
  const maxX = Math.max(0, (image.naturalWidth * scale - canvas.width) / 2);
  const maxY = Math.max(0, (image.naturalHeight * scale - canvas.height) / 2);
  avatarCropState.offsetX = Math.max(-maxX, Math.min(maxX, avatarCropState.offsetX));
  avatarCropState.offsetY = Math.max(-maxY, Math.min(maxY, avatarCropState.offsetY));
  avatarCropState.scale = scale;
}

function renderAvatarCrop() {
  if (!avatarCropState) return;
  clampAvatarCrop();
  const canvas = $('avatar-crop-canvas');
  const context = canvas.getContext('2d');
  const { image, scale, offsetX, offsetY } = avatarCropState;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, (canvas.width - width) / 2 + offsetX,
    (canvas.height - height) / 2 + offsetY, width, height);
}

async function openAvatarCrop(file) {
  const image = await loadAvatarImage(file);
  avatarCropState = { image, zoom: 1, offsetX: 0, offsetY: 0, scale: 1, dragging: false };
  $('avatar-crop-zoom').value = '1';
  renderAvatarCrop();
  $('avatar-crop-dialog').showModal();
}

async function loadOverview() {
  overview = await api('/api/overview');
  renderStudents();
  renderSubjects();
  renderExportChoices();
  if (reportStudent !== 'all' && !overview.students.some(s => s.id === Number(reportStudent))) reportStudent = 'all';
  fillSelect('report-student-filter', overview.students, 'Todos los estudiantes', reportStudent, 'all');
  if (currentSubject !== 'all' && !overview.subjects.some(s => s.id === Number(currentSubject))) currentSubject = 'all';
  if (reportSubject !== 'all' && !overview.subjects.some(s => s.id === Number(reportSubject))) reportSubject = 'all';
  if (!overview.subjects.some(s => s.id === Number(addSubject))) addSubject = overview.subjects[0]?.id || null;
  fillSelect('subject-filter', overview.subjects, 'Todos los ramos', currentSubject, 'all');
  fillSelect('report-subject-filter', overview.subjects, 'Todos los ramos', reportSubject, 'all');
  fillSelect('add-subject', overview.subjects, 'Selecciona un ramo', addSubject);
  fillSelect('event-subject', overview.subjects, 'Selecciona un ramo', overview.subjects[0]?.id || '');
  await refreshSubject();
  await refreshReport();
  await refreshEvents();
  await refreshUpcomingEvents();
  await refreshGradeSettings();
}

async function loadAdminStatus() {
  adminState = await api('/api/admin/status');
  $('tab-setup').hidden = !adminState.authenticated;
  $('open-event-editor').hidden = !adminState.authenticated;
  if (!adminState.authenticated && $('event-editor-dialog').open) $('event-editor-dialog').close();
  renderEventDetail();
  renderGradeSubjects();
  $('admin-button').textContent = adminState.authenticated ? 'Cerrar sesión de administrador'
    : adminState.configured ? 'Ingresar como administrador'
      : adminState.public_mode ? 'Configurar administrador en servidor' : 'Configurar administrador';
  renderProfileSummary();
  if (!adminState.authenticated && !$('panel-setup').hidden) $('tab-home').click();
  if (!adminState.configured && !adminState.public_mode) openAdminDialog();
  if (overview.students.length || overview.subjects.length) await refreshSubject();
}

async function loadStudentStatus() {
  studentState = await api('/api/student/status');
  $('student-button').textContent = studentState.authenticated
    ? `Cerrar sesión de ${studentState.name}` : 'Ingresar como estudiante';
  renderProfileSummary();
  if (studentState.authenticated) {
    reportStudent = studentState.student_id;
    if (overview.students.some(student => student.id === studentState.student_id)) {
      $('report-student-filter').value = String(reportStudent);
      await refreshReport();
    }
  }
  if (overview.students.length || overview.subjects.length) {
    await refreshSubject();
    await refreshReport();
    await refreshGradeSettings();
  }
}

async function openStudentDialog(firstTime = false, selectedId = null) {
  try {
    const [choices, available] = await Promise.all([
      api('/api/student/choices'), api('/api/student/available')
    ]);
    studentChoices = choices;
    availableStudentChoices = available;
    renderStudentChoiceList('student-login-list', 'student-login-name', studentChoices, selectedId);
    renderStudentChoiceList('student-register-list', 'student-register-name', availableStudentChoices,
      firstTime ? selectedId : null);
    setStudentMode(firstTime);
    if (!$('student-dialog').open) $('student-dialog').showModal();
  } catch (error) { message(error.message, true); }
}

function renderStudentChoiceList(containerId, inputId, entries, selectedId = null, onChoose = null) {
  const list = $(containerId);
  const input = inputId ? $(inputId) : null;
  list.replaceChildren();
  if (!entries.length) {
    list.append(element('div', 'student-choice-empty', 'No hay estudiantes disponibles.'));
    if (input) input.value = '';
    return;
  }
  if (input) input.value = selectedId ? String(selectedId) : '';
  entries.forEach(student => {
    const button = element('button', 'student-choice');
    button.type = 'button';
    button.dataset.studentId = String(student.id);
    button.setAttribute('aria-pressed', String(Number(selectedId) === Number(student.id)));
    button.classList.toggle('selected', Number(selectedId) === Number(student.id));
    const avatar = element('span', 'student-choice-avatar');
    if (student.avatar_data) {
      avatar.style.backgroundImage = `url(${student.avatar_data})`;
      avatar.classList.add('has-image');
    } else {
      avatar.textContent = student.name.trim().charAt(0).toUpperCase();
    }
    const copy = element('span', 'student-choice-copy');
    copy.append(element('span', 'student-choice-name', student.name));
    if (student.tagline) copy.append(element('small', 'student-choice-tagline', student.tagline));
    button.append(avatar, copy);
    button.addEventListener('click', () => {
      if ($('student-dialog')?.open) studentDialogMessage();
      list.querySelectorAll('.student-choice').forEach(choice => {
        const selected = choice === button;
        choice.classList.toggle('selected', selected);
        choice.setAttribute('aria-pressed', String(selected));
      });
      if (input) input.value = String(student.id);
      if (onChoose) onChoose(student);
    });
    list.append(button);
  });
}

function dismissAppIntro(fast = false) {
  if (!appIntro || !appIntro.isConnected || appIntro.classList.contains('is-leaving')) return;
  if (fast) appIntro.classList.add('fast-exit');
  appIntro.classList.add('is-leaving');
  appIntro.addEventListener('animationend', event => {
    if (event.target === appIntro) appIntro.remove();
  }, { once: true });
  setTimeout(() => appIntro?.remove(), fast ? 260 : 1300);
}

async function showIntroAccess() {
  if (!appIntro || !appIntro.isConnected) return;
  try {
    studentChoices = await api('/api/student/choices');
    renderStudentChoiceList('intro-student-list', null, studentChoices, null,
      student => openStudentDialog(false, student.id));
  } catch (error) {
    $('intro-student-list').replaceChildren(element('div', 'student-choice-empty', error.message));
  }
  const wait = Math.max(0, 950 - (performance.now() - introStartedAt));
  setTimeout(() => {
    if (!appIntro?.isConnected) return;
    $('intro-access').hidden = false;
    requestAnimationFrame(() => {
      appIntro.classList.add('move-logo');
      setTimeout(() => {
        if (appIntro?.isConnected) appIntro.classList.add('show-access');
      }, 430);
    });
  }, wait);
}

function setStudentMode(firstTime) {
  studentActivation = null;
  studentDialogMessage();
  $('student-login-form').hidden = firstTime;
  $('student-code-form').hidden = !firstTime;
  $('student-register-form').hidden = true;
  $('student-dialog-title').textContent = firstTime ? 'Primera vez' : 'Ingresar como estudiante';
  $('student-dialog-info').textContent = firstTime
    ? 'Selecciona tu nombre e ingresa el código que te entregó el administrador.'
    : 'Selecciona tu nombre y escribe tu contraseña.';
}

function showActivation(name, code) {
  $('activation-dialog-title').textContent = `Código de ${name}`;
  $('activation-code').textContent = code;
  $('activation-dialog').showModal();
}

function requireClassLogin() {
  if (adminState.authenticated || studentState.authenticated) return true;
  openStudentDialog();
  message('Inicia sesión para agregar, editar o borrar clases.');
  return false;
}

function openAdminDialog() {
  const setup = !adminState.configured;
  $('admin-dialog-title').textContent = setup ? 'Configurar administrador' : 'Ingresar como administrador';
  $('admin-dialog-info').textContent = setup
    ? 'Crea una contraseña una sola vez. Esta cuenta podrá modificar estudiantes y ramos.'
    : 'La sesión quedará recordada en este navegador durante 30 días.';
  $('admin-confirm-wrap').hidden = !setup;
  $('admin-confirm').required = setup;
  $('admin-password').minLength = setup ? 6 : 1;
  $('admin-password').autocomplete = setup ? 'new-password' : 'current-password';
  $('admin-submit').textContent = setup ? 'Crear cuenta' : 'Ingresar';
  if (!$('admin-dialog').open) $('admin-dialog').showModal();
  $('admin-password').focus();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyThemeKit(themeId, remember = true) {
  const kit = THEME_KITS.find(item => item.id === themeId) || THEME_KITS[0];
  activeThemeKit = kit.id;
  document.documentElement.dataset.theme = kit.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', kit.colors[1]);
  if (remember) {
    try { localStorage.setItem('asistencia-theme-kit', kit.id); } catch {}
  }
  renderThemeKits();
}

function renderThemeKits() {
  const list = $('theme-kits');
  if (!list) return;
  list.replaceChildren();
  THEME_KITS.forEach(kit => {
    const button = element('button', `theme-kit${kit.id === activeThemeKit ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(kit.id === activeThemeKit));
    const swatches = element('span', 'theme-swatches');
    kit.colors.forEach(color => {
      const swatch = element('i');
      swatch.style.backgroundColor = color;
      swatches.append(swatch);
    });
    const copy = element('span', 'theme-kit-copy');
    copy.append(element('strong', '', kit.name), element('small', '', kit.description));
    const check = element('span', 'theme-kit-check', kit.id === activeThemeKit ? '✓' : '');
    button.append(swatches, copy, check);
    button.addEventListener('click', () => applyThemeKit(kit.id));
    list.append(button);
  });
}

function urlBase64ToBytes(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(character => character.charCodeAt(0)));
}

function nativePushPlugin() {
  if (window.Capacitor?.getPlatform?.() !== 'android') return null;
  return window.Capacitor?.Plugins?.PushNotifications || null;
}

function savedNativePushToken() {
  try { return localStorage.getItem('asistencia-native-push-token') || ''; } catch { return ''; }
}

function saveNativePushToken(token = '') {
  try {
    if (token) localStorage.setItem('asistencia-native-push-token', token);
    else localStorage.removeItem('asistencia-native-push-token');
  } catch {}
}

async function setupNativePushActions() {
  const plugin = nativePushPlugin();
  if (!plugin || nativePushActionsReady) return;
  nativePushActionsReady = true;
  await plugin.addListener('pushNotificationActionPerformed', event => {
    const target = event.notification?.data?.url;
    if (target) location.assign(new URL(target, location.origin).href);
  });
}

async function registerNativePush(plugin) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    const finish = async (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await registrationListener.remove();
      await errorListener.remove();
      callback(value);
    };
    const registrationListener = await plugin.addListener('registration', token =>
      finish(resolve, token.value));
    const errorListener = await plugin.addListener('registrationError', error =>
      finish(reject, new Error(error?.error || 'No se pudo registrar este teléfono.')));
    const timer = setTimeout(() => finish(reject,
      new Error('El registro de notificaciones tardó demasiado. Intenta nuevamente.')), 15000);
    await plugin.register();
  });
}

async function refreshNotificationStatus() {
  const status = $('notification-status');
  const button = $('notification-toggle');
  const help = $('notification-help');
  const preferenceInputs = [
    $('notification-class-minutes'),
    $('notification-presentation-minutes'),
    $('notification-test-minutes'),
    $('notification-other-minutes')
  ];
  const preferenceSave = $('notification-preferences-save');
  status.textContent = 'Comprobando…';
  button.disabled = true;
  preferenceInputs.forEach(input => { input.disabled = true; });
  preferenceSave.disabled = true;
  help.textContent = '';
  const nativePush = nativePushPlugin();
  if (!nativePush && (!('serviceWorker' in navigator) || !('PushManager' in window)
      || !('Notification' in window))) {
    status.textContent = 'No compatible';
    help.textContent = 'Este navegador no admite notificaciones web.';
    return;
  }
  try {
    notificationConfig = await api('/api/notifications/config');
    const preferences = notificationConfig.preferences || {};
    $('notification-class-minutes').value = preferences.class_minutes ?? 15;
    $('notification-presentation-minutes').value = preferences.presentation_minutes ?? 30;
    $('notification-test-minutes').value = preferences.test_minutes ?? 60;
    $('notification-other-minutes').value = preferences.other_minutes ?? 15;
    if (!notificationConfig.student_authenticated) {
      status.textContent = 'Sesión requerida';
      button.textContent = 'Inicia sesión como estudiante';
      help.textContent = 'Las notificaciones se vinculan a tu cuenta y a este dispositivo.';
      return;
    }
    preferenceInputs.forEach(input => { input.disabled = false; });
    preferenceSave.disabled = false;
    if (!notificationConfig.supported) {
      status.textContent = 'Pendiente de configurar';
      button.textContent = 'Activar notificaciones';
      help.textContent = 'Falta configurar las claves de notificación en el servidor.';
      return;
    }
    if (nativePush) {
      await setupNativePushActions();
      const permission = await nativePush.checkPermissions();
      const active = Boolean(savedNativePushToken()) && permission.receive === 'granted';
      status.textContent = active ? 'Activadas' : permission.receive === 'denied' ? 'Bloqueadas' : 'Desactivadas';
      button.textContent = active ? 'Desactivar notificaciones' : 'Activar notificaciones';
      button.disabled = permission.receive === 'denied';
      help.textContent = permission.receive === 'denied'
        ? 'Debes permitir las notificaciones desde los ajustes de Android.'
        : active ? 'La aplicación recibirá recordatorios nativos.'
          : 'Android solicitará permiso una sola vez.';
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    const active = Boolean(subscription) && Notification.permission === 'granted';
    status.textContent = active ? 'Activadas' : Notification.permission === 'denied' ? 'Bloqueadas' : 'Desactivadas';
    button.textContent = active ? 'Desactivar notificaciones' : 'Activar notificaciones';
    button.disabled = Notification.permission === 'denied';
    if (Notification.permission === 'denied') {
      help.textContent = 'Debes permitir las notificaciones desde la configuración del navegador o del teléfono.';
    } else if (/iPhone|iPad|iPod/.test(navigator.userAgent)
        && !window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone) {
      help.textContent = 'En iPhone, abre la aplicación instalada desde la pantalla de inicio para activarlas.';
      button.disabled = true;
    } else {
      help.textContent = active ? 'Este dispositivo recibirá los recordatorios programados.'
        : 'El navegador solicitará permiso una sola vez.';
    }
  } catch (error) {
    status.textContent = 'No disponible';
    help.textContent = error.message;
  }
}

async function saveNotificationPreferences(event) {
  event.preventDefault();
  const button = $('notification-preferences-save');
  const values = {
    class_minutes: Number($('notification-class-minutes').value),
    presentation_minutes: Number($('notification-presentation-minutes').value),
    test_minutes: Number($('notification-test-minutes').value),
    other_minutes: Number($('notification-other-minutes').value)
  };
  if (Object.values(values).some(value => !Number.isInteger(value) || value < 0 || value > 1440)) {
    message('Escribe minutos completos entre 0 y 1440.', true);
    return;
  }
  button.disabled = true;
  try {
    const result = await api('/api/notifications/preferences', values);
    notificationConfig.preferences = result.preferences;
    message('Tiempos de notificación guardados.');
  } catch (error) {
    message(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function toggleNotifications() {
  if (!notificationConfig?.student_authenticated) {
    await openStudentDialog();
    return;
  }
  const button = $('notification-toggle');
  button.disabled = true;
  try {
    const nativePush = nativePushPlugin();
    if (nativePush) {
      await setupNativePushActions();
      const existingToken = savedNativePushToken();
      if (existingToken) {
        await api('/api/notifications/native/unsubscribe', { token: existingToken });
        await nativePush.unregister();
        saveNativePushToken();
        message('Notificaciones nativas desactivadas en este teléfono.');
      } else {
        let permission = await nativePush.checkPermissions();
        if (permission.receive !== 'granted') permission = await nativePush.requestPermissions();
        if (permission.receive !== 'granted') {
          throw new Error('No se concedió permiso para enviar notificaciones.');
        }
        const token = await registerNativePush(nativePush);
        await api('/api/notifications/native/subscribe', { token, platform: 'android' });
        saveNativePushToken(token);
        message('Notificaciones nativas activadas en este teléfono.');
      }
      await refreshNotificationStatus();
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await api('/api/notifications/unsubscribe', { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
      message('Notificaciones desactivadas en este dispositivo.');
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('No se concedió permiso para enviar notificaciones.');
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(notificationConfig.public_key)
      });
      const value = subscription.toJSON();
      await api('/api/notifications/subscribe', {
        endpoint: value.endpoint, keys: value.keys
      });
      message('Notificaciones activadas en este dispositivo.');
    }
  } catch (error) { message(error.message, true); }
  await refreshNotificationStatus();
}

function readableDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function classLabel(item) {
  return item.class_number > 1 ? `${item.class_number}° clase` : '1° clase';
}

function renderStudents() {
  const list = $('students-list');
  list.replaceChildren();
  if (!overview.students.length) { list.append(element('div', 'empty', 'Aún no hay estudiantes.')); return; }
  overview.students.forEach(student => {
    const row = element('div', 'student-row');
    const name = element('strong', '', student.name);
    const actions = element('div', 'student-actions');
    const edit = element('button', 'secondary-button', 'Editar');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      name.remove();
      edit.remove();
      const form = element('form', 'student-edit');
      const input = element('input');
      input.value = student.name;
      input.required = true;
      input.maxLength = 120;
      input.setAttribute('aria-label', 'Nombre del estudiante');
      const save = element('button', '', 'Guardar');
      save.type = 'submit';
      const cancel = element('button', 'secondary-button', 'Cancelar');
      cancel.type = 'button';
      cancel.addEventListener('click', () => renderStudents());
      const reset = element('button', 'danger-button', 'Restablecer contraseña');
      reset.type = 'button';
      reset.addEventListener('click', async () => {
        if (!confirm(`¿Restablecer la contraseña de ${student.name}? Su sesión actual se cerrará y necesitará un nuevo código de activación. Su asistencia se conservará.`)) return;
        reset.disabled = true;
        try {
          const result = await api(`/api/students/${student.id}/reset-password`, {});
          showActivation(result.name, result.activation_code);
          renderStudents();
        } catch (error) { message(error.message, true); reset.disabled = false; }
      });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        save.disabled = true;
        try {
          await api(`/api/students/${student.id}`, { name: input.value }, 'PATCH');
          await loadOverview();
          message('Nombre actualizado.');
        } catch (error) { message(error.message, true); save.disabled = false; }
      });
      form.append(input, save, cancel, reset);
      row.prepend(form);
      input.focus();
    });
    const remove = element('button', 'danger-button', 'Eliminar');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar a ${student.name}? También se borrará toda su asistencia registrada.`)) return;
      try {
        await api(`/api/students/${student.id}`, undefined, 'DELETE');
        await loadOverview();
        message('Estudiante eliminado.');
      } catch (error) { message(error.message, true); }
    });
    actions.append(edit, remove);
    row.append(name, actions);
    list.append(row);
  });
}

function renderSubjects() {
  const list = $('subjects-list');
  list.replaceChildren();
  if (!overview.subjects.length) { list.append(element('div', 'empty', 'Aún no hay ramos.')); return; }
  overview.subjects.forEach(subject => {
    const row = element('div', 'student-row');
    const name = element('strong', '', subject.name);
    const abbreviationBadge = element('span', 'subject-abbreviation-badge', subject.abbreviation);
    const identity = element('div', 'subject-identity');
    const marker = element('i', 'subject-color-dot');
    marker.style.backgroundColor = subject.color;
    identity.append(marker, name, abbreviationBadge);
    const actions = element('div', 'student-actions');
    const edit = element('button', 'secondary-button', 'Editar');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      identity.remove();
      edit.remove();
      const form = element('form', 'student-edit');
      const input = element('input');
      input.value = subject.name;
      input.required = true;
      input.maxLength = 120;
      input.setAttribute('aria-label', 'Nombre del ramo');
      const color = element('input');
      color.type = 'color';
      color.value = subject.color;
      color.required = true;
      color.className = 'subject-color-input';
      color.setAttribute('aria-label', 'Color del ramo');
      const abbreviation = element('input');
      abbreviation.value = subject.abbreviation;
      abbreviation.required = true;
      abbreviation.maxLength = 3;
      abbreviation.className = 'subject-abbreviation-input';
      abbreviation.setAttribute('aria-label', 'Diminutivo del ramo');
      abbreviation.setAttribute('placeholder', 'ABC');
      abbreviation.addEventListener('input', () => {
        abbreviation.value = abbreviation.value.toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ]/g, '').slice(0, 3);
      });
      const save = element('button', '', 'Guardar');
      save.type = 'submit';
      const cancel = element('button', 'secondary-button', 'Cancelar');
      cancel.type = 'button';
      cancel.addEventListener('click', () => renderSubjects());
      form.addEventListener('submit', async event => {
        event.preventDefault();
        save.disabled = true;
        try {
          await api(`/api/subjects/${subject.id}`, {
            name: input.value, abbreviation: abbreviation.value, color: color.value
          }, 'PATCH');
          await loadOverview();
          message('Ramo actualizado.');
        } catch (error) { message(error.message, true); save.disabled = false; }
      });
      form.append(input, abbreviation, color, save, cancel);
      row.prepend(form);
      input.focus();
    });
    const remove = element('button', 'danger-button', 'Eliminar');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm(`¿Eliminar el ramo ${subject.name}? También se borrarán todas sus clases y registros de asistencia.`)) return;
      try {
        await api(`/api/subjects/${subject.id}`, undefined, 'DELETE');
        await loadOverview();
        message('Ramo eliminado.');
      } catch (error) { message(error.message, true); }
    });
    actions.append(edit, remove);
    row.append(identity, actions);
    list.append(row);
  });
}

function renderExportChoices() {
  const signedIn = adminState.authenticated || studentState.authenticated;
  const studentEntries = adminState.authenticated ? overview.students
    : studentState.authenticated ? overview.students.filter(item => item.id === studentState.student_id) : [];
  $('export-students-field').hidden = !adminState.authenticated;
  $('export-access-hint').textContent = adminState.authenticated
    ? 'Como administrador puedes escoger estudiantes, ramos y tipos de información.'
    : studentState.authenticated ? 'La descarga incluirá únicamente tus propios datos.'
      : 'Inicia sesión para descargar información.';
  for (const [type, entries] of [['students', studentEntries], ['subjects', overview.subjects]]) {
    const list = $(`export-${type}-list`);
    list.replaceChildren();
    const all = $(`export-all-${type}`);
    all.checked = entries.length > 0;
    all.disabled = entries.length === 0;
    entries.forEach(entry => {
      const label = element('label', 'export-choice');
      const checkbox = element('input');
      checkbox.type = 'checkbox';
      checkbox.value = String(entry.id);
      checkbox.checked = true;
      checkbox.addEventListener('change', () => {
        const choices = [...list.querySelectorAll('input[type="checkbox"]')];
        all.checked = choices.length > 0 && choices.every(choice => choice.checked);
        updateExportCount();
      });
      label.append(checkbox, document.createTextNode(entry.name));
      list.append(label);
    });
  }
  $('export-attendance').disabled = !signedIn;
  $('export-grades').disabled = !signedIn;
  updateExportCount();
}

function exportIds(type) {
  return [...$(`export-${type}-list`).querySelectorAll('input:checked')].map(input => Number(input.value));
}

function updateExportCount() {
  const students = exportIds('students').length;
  const subjects = exportIds('subjects').length;
  const sections = [$('export-attendance').checked, $('export-grades').checked].filter(Boolean).length;
  $('export-count').textContent = `${students} estudiante${students === 1 ? '' : 's'} · ${subjects} ramo${subjects === 1 ? '' : 's'}`;
  $('export-download').disabled = students === 0 || subjects === 0 || sections === 0
    || (!adminState.authenticated && !studentState.authenticated);
}

async function refreshSubject() {
  const subject = currentSubject;
  const canAdd = overview.subjects.length > 0;
  $('open-class-editor').disabled = !canAdd;
  $('sessions-list').replaceChildren();
  $('sessions-empty').hidden = true;
  const sessions = await api(`/api/sessions?subject_id=${subject}`);
  if (subject !== currentSubject) return;
  renderSessions(sessions);
}

async function refreshReport() {
  const subject = reportSubject;
  const student = reportStudent;
  $('report-list').replaceChildren();
  $('report-empty').hidden = true;
  $('home-report-list').replaceChildren();
  const homeStudent = studentState.authenticated ? studentState.student_id : null;
  $('home-report-empty').hidden = Boolean(homeStudent);
  if (!homeStudent) $('home-report-empty').textContent = 'Inicia sesión para ver esta información.';
  const requests = [api(`/api/report?subject_id=${subject}&student_id=${student}`)];
  if (homeStudent) requests.push(api(`/api/report?subject_id=all&student_id=${homeStudent}`));
  const [report, homeReport = []] = await Promise.all(requests);
  if (subject !== reportSubject || student !== reportStudent) return;
  renderReport(report);
  if (homeStudent && homeStudent === (studentState.authenticated ? studentState.student_id : null)) {
    renderReport(homeReport, 'home-report-list', 'home-report-empty', false);
  }
}

function renderSessions(sessions) {
  const list = $('sessions-list');
  list.replaceChildren();
  $('sessions-empty').hidden = sessions.length > 0;
  if (!sessions.length) $('sessions-empty').textContent = 'Aún no hay clases registradas.';
  sessions.forEach(session => {
    const row = element('div', 'session-row');
    const detail = element('div');
    detail.append(element('strong', '', `${readableDate(session.class_date)} · ${session.subject_name} · ${classLabel(session)}`),
      element('small', '', session.title || 'Clase sin tema indicado'));
    const meta = element('div', 'meta');
    const personalStatus = { presente: 'Presente', ausente: 'Ausente', justificado: 'Justificado' };
    if (!session.has_attendance) {
      meta.append(element('span', 'pill session-no-attendance', 'Sin lista'));
    } else {
      const count = session.viewer_status
        ? element('span', `pill status-${session.viewer_status}`, personalStatus[session.viewer_status])
        : element('span', `${session.absent ? 'pill warn' : 'pill'} session-count-summary`,
          `${session.present} presentes · ${session.absent} ausentes${session.justified ? ` · ${session.justified} justificadas` : ''}`);
      const button = element('button', '', 'Marcar asistencia');
      button.type = 'button';
      button.addEventListener('click', () => openAttendance(session.id));
      meta.append(count, button);
    }
    const menuWrap = element('div', 'class-menu-wrap');
    const menuButton = element('button', 'class-menu-button secondary-button', '⋮');
    menuButton.type = 'button';
    menuButton.setAttribute('aria-label', `Opciones de ${session.subject_name}`);
    const menu = element('div', 'class-menu');
    menu.hidden = true;
    const edit = element('button', 'profile-action', 'Editar clase');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      if (!requireClassLogin()) return;
      openClassEditor(session);
    });
    const remove = element('button', 'profile-action class-delete-action', 'Eliminar clase');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!requireClassLogin()) return;
      if (!confirm(`¿Eliminar la clase del ${readableDate(session.class_date)} de ${session.subject_name}? También se borrará su asistencia.`)) return;
      try {
        await api(`/api/sessions/${session.id}`, undefined, 'DELETE');
        await Promise.all([refreshSubject(), refreshReport()]);
        message('Clase eliminada.');
      } catch (error) { message(error.message, true); }
    });
    menu.append(edit, remove);
    menuButton.addEventListener('click', event => {
      event.stopPropagation();
      document.querySelectorAll('.class-menu').forEach(other => {
        if (other !== menu) other.hidden = true;
      });
      menu.hidden = !menu.hidden;
    });
    menuWrap.append(menuButton, menu);
    meta.append(menuWrap);
    row.append(detail, meta);
    list.append(row);
  });
}

function resetClassEditor() {
  editingClassId = null;
  editingClassOriginal = null;
  $('class-editor-title').textContent = 'Agregar clase';
  $('class-save').textContent = 'Agregar clase';
  $('add-subject').value = String(addSubject || overview.subjects[0]?.id || '');
  $('class-date').value = new Date().toLocaleDateString('en-CA');
  $('class-title').value = '';
  $('class-has-attendance').checked = true;
}

function openClassEditor(session = null) {
  if (!session) resetClassEditor();
  else {
    editingClassId = session.id;
    editingClassOriginal = session;
    $('class-editor-title').textContent = 'Editar clase';
    $('class-save').textContent = 'Guardar cambios';
    $('add-subject').value = String(session.subject_id);
    $('class-date').value = session.class_date;
    $('class-title').value = session.title || '';
    $('class-has-attendance').checked = Boolean(session.has_attendance);
  }
  if (!$('class-editor-dialog').open) $('class-editor-dialog').showModal();
}

function renderReport(report, listId = 'report-list', emptyId = 'report-empty', showStudentName = true) {
  const list = $(listId);
  list.replaceChildren();
  $(emptyId).hidden = report.length > 0;
  if (!report.length) $(emptyId).textContent = 'Agrega estudiantes para ver sus inasistencias.';

  function appendStats(container, data) {
    const stats = element('div', 'stats');
    [[`Clases: ${data.total_classes}`, 'stat'], [`Presentes: ${data.present}`, 'stat'],
      [`Ausentes: ${data.absent}`, 'stat absent'], [`Justificadas: ${data.justified}`, 'stat']]
      .forEach(([text, cls]) => stats.append(element('span', cls, text)));
    container.append(stats);
    container.append(element('div', 'attendance-percent',
      `Asistencia: ${data.attendance_percent === null ? '—' : `${data.attendance_percent.toLocaleString('es-CL')}%`}`));
  }

  report.forEach(student => {
    const card = element('div', 'report-card');
    if (student.subjects) {
      card.classList.add('report-card-by-subject');
      if (showStudentName) card.append(element('strong', 'report-student-name', student.name));
      if (!student.subjects.length) card.append(element('p', 'hint', 'Aún no hay ramos registrados.'));
      student.subjects.forEach(subject => {
        const section = element('section', 'subject-report');
        const heading = element('div', 'report-top');
        heading.append(element('strong', '', subject.name),
          element('span', subject.absent ? 'pill warn' : 'pill', `${subject.absent} inasistencia${subject.absent === 1 ? '' : 's'}`));
        section.append(heading);
        appendStats(section, subject);
        if (subject.absence_days.length) {
          const days = element('ul', 'absence-days');
          subject.absence_days.forEach(day => days.append(element('li', '',
            `${readableDate(day.class_date)} · ${classLabel(day)}${day.title ? ` · ${day.title}` : ''}`)));
          section.append(days);
        }
        card.append(section);
      });
      list.append(card);
      return;
    }
    const top = element('div', 'report-top');
    top.append(element('strong', '', student.name),
      element('span', student.absent ? 'pill warn' : 'pill', `${student.absent} inasistencia${student.absent === 1 ? '' : 's'}`));
    card.append(top);
    appendStats(card, student);
    if (student.absence_days.length) {
      const days = element('ul', 'absence-days');
      student.absence_days.forEach(day => days.append(element('li', '',
        `${readableDate(day.class_date)} · ${day.subject_name} · ${classLabel(day)}${day.title ? ` · ${day.title}` : ''}`)));
      card.append(days);
    }
    list.append(card);
  });
}

async function refreshGradeSettings() {
  gradeSubjects = await api('/api/grade-settings');
  renderGradeSubjects();
}

function percentage(value) {
  const formatted = Number(value).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return `${formatted}%`;
}

function gradeText(value) {
  if (!Number.isFinite(value)) return '—';
  return roundedGrade(value).toFixed(1);
}

function averageText(value) {
  if (!Number.isFinite(value)) return '—';
  return (Number(value) + 1e-9).toFixed(2);
}

function parseGradeInput(rawValue) {
  const normalized = String(rawValue).trim().replace(',', '.');
  if (!normalized) return null;
  if (/^\d{2}$/.test(normalized)) return Number(normalized) / 10;
  if (!/^\d(?:\.\d{0,2})?$/.test(normalized)) return NaN;
  return Number(normalized);
}

function gradeInputText(value) {
  return value === null || value === undefined ? '' : roundedGrade(value).toFixed(1);
}

function roundedGrade(value) {
  return Number.isFinite(Number(value))
    ? Math.round((Number(value) + 1e-9) * 10) / 10 : null;
}

function meetsGrade(value, target) {
  const rounded = roundedGrade(value);
  return rounded !== null && rounded >= Number(target);
}

function minimumTenthThatMeets(calculateAverage, target) {
  for (let tenth = 10; tenth <= 70; tenth += 1) {
    const candidate = tenth / 10;
    if (meetsGrade(calculateAverage(candidate), target)) return candidate;
  }
  return 7.1;
}

function updateGradeValueColor(target, value) {
  const numericValue = typeof value === 'string' ? parseGradeInput(value) : Number(value);
  target.classList.toggle('grade-below-passing', Number.isFinite(numericValue)
    && roundedGrade(numericValue) < 4);
}

function parsePercentageInput(rawValue) {
  const normalized = String(rawValue).trim().replace(',', '.');
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) return NaN;
  const value = Number(normalized);
  return value >= 0 && value <= 100 ? value : NaN;
}

function percentageInputText(value) {
  if (value === null || value === undefined || value === '') return '';
  return Number(value).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function averageValueElement(value, emptyText = '-') {
  const result = element('strong', '', value === null ? emptyText : averageText(value));
  if (value !== null && roundedGrade(value) < 4) result.classList.add('grade-below-passing');
  return result;
}

function gradeCoefficients(subject, scope = 'total') {
  const categories = scope === 'total' ? ['teorico', 'practico'] : [scope];
  const result = [];
  let completeConfiguration = true;
  categories.forEach(category => {
    const categoryWeight = scope === 'total'
      ? Number(category === 'teorico' ? subject.theoretical_weight : subject.practical_weight)
      : 100;
    if (categoryWeight <= 0) return;
    const evaluations = subject.evaluations.filter(item => item.category === category);
    const evaluationWeight = evaluations.reduce((sum, item) => sum + Number(item.weight), 0);
    if (!evaluations.length || evaluationWeight <= 0) {
      completeConfiguration = false;
      return;
    }
    evaluations.forEach(item => result.push({
      ...item,
      coefficient: (categoryWeight / 100) * (Number(item.weight) / evaluationWeight)
    }));
  });
  return { entries: result, completeConfiguration };
}

function evaluationScore(subject, evaluation, applySubstitution = true) {
  if (subject.simulation_active && (evaluation.score === null || evaluation.score === undefined)
      && evaluation.simulation_score !== null && evaluation.simulation_score !== undefined) {
    return Number(evaluation.simulation_score);
  }
  if (applySubstitution && subject.substitution
      && Number(subject.substitution.evaluation_id) === Number(evaluation.id)
      && subject.substitution.score !== null && subject.substitution.score !== undefined) {
    return Number(subject.substitution.score);
  }
  return evaluation.score === null || evaluation.score === undefined ? null : Number(evaluation.score);
}

function currentGrade(subject, scope = 'total', applySubstitution = true) {
  const { entries, completeConfiguration } = gradeCoefficients(subject, scope);
  const scored = entries.map(item => ({ ...item, calculationScore:
    evaluationScore(subject, item, applySubstitution) }))
    .filter(item => item.calculationScore !== null);
  const enteredWeight = scored.reduce((sum, item) => sum + item.coefficient, 0);
  return {
    value: enteredWeight > 0
      ? scored.reduce((sum, item) => sum + item.calculationScore * item.coefficient, 0) / enteredWeight
      : null,
    entered: scored.length,
    total: entries.length,
    completeConfiguration
  };
}

function requiredPendingGrade(subject, target, scope) {
  const { entries, completeConfiguration } = gradeCoefficients(subject, scope);
  if (!completeConfiguration || !entries.length) return { state: 'unavailable' };
  const valued = entries.map(item => ({ ...item, calculationScore: evaluationScore(subject, item) }));
  const pending = valued.filter(item => item.calculationScore === null);
  const known = valued.filter(item => item.calculationScore !== null)
    .reduce((sum, item) => sum + item.calculationScore * item.coefficient, 0);
  const pendingWeight = pending.reduce((sum, item) => sum + item.coefficient, 0);
  if (!pending.length || pendingWeight <= 0) {
    return { state: meetsGrade(known, target) ? 'achieved' : 'missed' };
  }
  const value = minimumTenthThatMeets(candidate => known + candidate * pendingWeight, target);
  if (value <= 1) return { state: 'easy', value: 1 };
  if (value > 7) return { state: 'impossible', value };
  return { state: 'needed', value };
}

function requiredExamGrade(subject, target = 4) {
  const examWeight = Number(subject.exam_weight) / 100;
  if (examWeight <= 0) return null;
  if (subject.exam_scope === 'total') {
    const coursework = currentGrade(subject, 'total').value;
    if (coursework === null) return null;
    return (target - coursework * (1 - examWeight)) / examWeight;
  }
  const theoretical = currentGrade(subject, 'teorico').value;
  if (theoretical === null) return null;
  return (target - theoretical * (1 - examWeight)) / examWeight;
}

function theoreticalGradeWithExam(subject) {
  const theoretical = currentGrade(subject, 'teorico').value;
  const examWeight = Number(subject.exam_weight) / 100;
  if (theoretical === null || subject.exam_score === null
      || subject.exam_score === undefined || examWeight <= 0) return null;
  return theoretical * (1 - examWeight) + Number(subject.exam_score) * examWeight;
}

function finalGradeValue(subject) {
  const coursework = currentGrade(subject, 'total').value;
  const examWeight = Number(subject.exam_weight) / 100;
  if (coursework === null || subject.exam_score === null
      || subject.exam_score === undefined || examWeight <= 0) return coursework;
  if (subject.exam_scope === 'total') {
    return coursework * (1 - examWeight) + Number(subject.exam_score) * examWeight;
  }
  const theoreticalWithExam = theoreticalGradeWithExam(subject);
  if (theoreticalWithExam === null) return coursework;
  const practicalWeight = Number(subject.practical_weight) / 100;
  if (practicalWeight <= 0) return theoreticalWithExam;
  const practical = currentGrade(subject, 'practico').value;
  if (practical === null) return null;
  const theoreticalWeight = Number(subject.theoretical_weight) / 100;
  return theoreticalWithExam * theoreticalWeight + practical * practicalWeight;
}

function renderCategoryAverage(subject, category, container) {
  const average = currentGrade(subject, category);
  container.replaceChildren(
    element('span', '', category === 'teorico' ? 'Promedio teórico' : 'Promedio práctico'),
    averageValueElement(average.value)
  );
}

function categoryResult(subject, category) {
  const evaluations = subject.evaluations.filter(item => item.category === category);
  const complete = evaluations.length > 0
    && evaluations.every(item => evaluationScore(subject, item) !== null);
  const average = currentGrade(subject, category).value;
  return { complete, average, failed: complete && average !== null && roundedGrade(average) < 4 };
}

function subjectFailure(subject) {
  const theoretical = categoryResult(subject, 'teorico');
  const practical = categoryResult(subject, 'practico');
  const examFailed = Boolean(subject.exam_is_failing
    && subject.exam_score !== null && subject.exam_score !== undefined
    && roundedGrade(subject.exam_score) < 4);
  return {
    theoretical: theoretical.failed,
    practical: subject.course_type === 'teorico_practico' && practical.failed,
    exam: examFailed,
    failed: theoretical.failed
      || (subject.course_type === 'teorico_practico' && practical.failed) || examFailed
  };
}

function theoreticalPracticalAverage(subject) {
  const theoretical = currentGrade(subject, 'teorico').value;
  const practical = currentGrade(subject, 'practico').value;
  if (theoretical === null || practical === null) return null;
  const theoreticalWeight = Number(subject.theoretical_weight) / 100;
  const practicalWeight = Number(subject.practical_weight) / 100;
  const totalWeight = theoreticalWeight + practicalWeight;
  return totalWeight > 0
    ? (theoretical * theoreticalWeight + practical * practicalWeight) / totalWeight
    : null;
}

function substitutionRecommendation(subject, evaluationId = null) {
  if (!subject.exemption_enabled || !subject.evaluations.length) return null;
  if (subject.evaluations.some(item => evaluationScore(subject, item, false) === null)) return null;
  const eligible = subject.evaluations
    .filter(item => item.category === 'teorico' && item.substitutable)
    .sort((left, right) => evaluationScore(subject, left, false)
      - evaluationScore(subject, right, false));
  if (!eligible.length) return null;
  const selected = eligible.find(item => Number(item.id) === Number(evaluationId)) || eligible[0];
  const { entries } = gradeCoefficients(subject, subject.exemption_scope);
  const totalWeight = entries.reduce((sum, item) => sum + item.coefficient, 0);
  const selectedEntry = entries.find(item => item.id === selected.id);
  const current = currentGrade(subject, subject.exemption_scope, false).value;
  if (!selectedEntry || totalWeight <= 0 || current === null) return null;
  const effectiveWeight = selectedEntry.coefficient / totalWeight;
  const originalScore = evaluationScore(subject, selected, false);
  const needed = minimumTenthThatMeets(
    candidate => current + (candidate - originalScore) * effectiveWeight,
    Number(subject.exemption_grade)
  );
  return { evaluation: selected, needed };
}

function buildExemptionCard(subject, needed) {
  const card = element('div', 'grade-calculation-card grade-exemption-card');
  card.append(element('span', '', `Para eximirse (${gradeText(Number(subject.exemption_grade))})`));
  const messages = {
    unavailable: '—',
    achieved: 'Eximido',
    missed: 'No eximido',
    easy: '1.0',
    impossible: 'Ni con un 7',
    needed: gradeText(needed.value)
  };
  const result = element('strong', '', messages[needed.state]);
  if ((needed.state === 'easy' || needed.state === 'needed') && Number(needed.value) < 4) {
    result.classList.add('grade-below-passing');
  }
  card.append(result);
  return card;
}

function renderTheoreticalExemption(subject, container) {
  container.replaceChildren();
  if (!studentState.authenticated || !subject.exemption_enabled || subject.exemption_scope !== 'teorico') return;
  const needed = requiredPendingGrade(subject, Number(subject.exemption_grade), 'teorico');
  container.append(buildExemptionCard(subject, needed));
}

function renderGradeCalculations(subject, container, onUpdate, theoreticalExamSlot = null) {
  container.replaceChildren();
  if (theoreticalExamSlot) theoreticalExamSlot.replaceChildren();
  if (!studentState.authenticated) {
    container.append(element('p', 'grade-login-hint', 'Inicia sesión como estudiante para ingresar tus notas y ver los cálculos.'));
    return;
  }
  const current = currentGrade(subject, 'total');
  const cards = element('div', 'grade-calculation-grid');
  let exemptionResult = null;
  if (subject.exemption_enabled) {
    const needed = requiredPendingGrade(subject, Number(subject.exemption_grade), subject.exemption_scope);
    exemptionResult = needed;
    if (subject.exemption_scope !== 'teorico') {
      if (Number(subject.practical_weight) > 0) {
        const combinedCard = element('div', 'grade-calculation-card grade-combined-average');
        const combined = theoreticalPracticalAverage(subject);
        combinedCard.append(element('span', '', 'Promedio teórico-práctico'),
          averageValueElement(combined));
        cards.append(combinedCard);
      }
      cards.append(buildExemptionCard(subject, needed));
    }
  }
  const allNotesEntered = subject.evaluations.length > 0
    && subject.evaluations.every(item => evaluationScore(subject, item, false) !== null);
  const eligibleSubstitutions = subject.evaluations
    .filter(item => item.category === 'teorico' && item.substitutable
      && evaluationScore(subject, item, false) !== null)
    .sort((left, right) => evaluationScore(subject, left, false)
      - evaluationScore(subject, right, false));
  const originalExemptionAverage = subject.exemption_enabled
    ? currentGrade(subject, subject.exemption_scope, false).value : null;
  const needsSubstitution = originalExemptionAverage !== null
    && !meetsGrade(originalExemptionAverage, Number(subject.exemption_grade));
  const canShowSubstitution = allNotesEntered && eligibleSubstitutions.length
    && subject.exemption_enabled && (needsSubstitution || subject.substitution);
  if (canShowSubstitution && subject.simulation_active) {
    const substitution = substitutionRecommendation(subject);
    const simulationCard = element('div', 'grade-calculation-card grade-simulation-substitution');
    simulationCard.append(element('span', '', 'Sustitutiva sugerida'));
    let suggestedGrade = gradeText(Math.max(1, substitution.needed));
    if (substitution.needed > 7) suggestedGrade = 'Ni con 7 te eximes';
    simulationCard.append(element('strong', '',
      `${substitution.evaluation.name} (${suggestedGrade})`));
    if (theoreticalExamSlot && subject.exam_scope === 'teorico') {
      theoreticalExamSlot.append(simulationCard);
    } else {
      cards.append(simulationCard);
    }
  } else if (canShowSubstitution) {
    const defaultEvaluation = eligibleSubstitutions[0];
    const selectedEvaluationId = Number(subject.substitution?.evaluation_id || defaultEvaluation.id);
    const substitution = substitutionRecommendation(subject, selectedEvaluationId);
    const substitutionCard = element('div', 'grade-calculation-card grade-substitution-editor');
    if (subject.exam_scope === 'teorico') substitutionCard.classList.add('grade-theory-exam-related');
    substitutionCard.append(element('span', 'grade-substitution-title', 'Prueba a sustituir'));
    const fields = element('div', 'grade-substitution-fields');
    const evaluationLabel = element('label', '', 'Evaluación');
    const evaluationSelect = element('select');
    eligibleSubstitutions.forEach(item => option(
      evaluationSelect, String(item.id),
      `${item.name} (${gradeText(evaluationScore(subject, item, false))})`));
    evaluationSelect.value = String(selectedEvaluationId);
    evaluationLabel.append(evaluationSelect);
    const scoreLabel = element('label', '', 'Nota sustitutiva');
    const substitutionInput = element('input');
    substitutionInput.type = 'text';
    substitutionInput.inputMode = 'decimal';
    substitutionInput.maxLength = 4;
    substitutionInput.placeholder = 'Ej: 5.0';
    substitutionInput.value = subject.substitution?.score === null
      || subject.substitution?.score === undefined ? '' : gradeInputText(subject.substitution.score);
    updateGradeValueColor(substitutionInput, substitutionInput.value);
    scoreLabel.append(substitutionInput);
    fields.append(evaluationLabel, scoreLabel);
    substitutionCard.append(fields);
    const suggestion = element('small', 'grade-substitution-suggestion');
    let suggestedGrade = gradeText(Math.max(1, substitution.needed));
    if (substitution.needed > 7) suggestedGrade = 'Ni con 7 te eximes';
    suggestion.textContent = substitution.needed > 7
      ? suggestedGrade : `Nota sugerida para eximirse: ${suggestedGrade}`;
    substitutionCard.append(suggestion);
    if (substitution.needed <= 7 && Math.max(1, substitution.needed) < 4) {
      suggestion.classList.add('grade-below-passing');
    }
    const saveSubstitution = async (evaluationId, score) => {
      evaluationSelect.disabled = true;
      substitutionInput.disabled = true;
      suggestion.textContent = 'Guardando…';
      try {
        const saved = await api('/api/grade-substitution', {
          evaluation_id: evaluationId, score
        });
        subject.substitution = saved;
        if (onUpdate) onUpdate();
      } catch (error) {
        message(error.message, true);
        if (onUpdate) onUpdate();
      }
    };
    evaluationSelect.addEventListener('change', () => {
      saveSubstitution(Number(evaluationSelect.value), null);
    });
    substitutionInput.addEventListener('input', () => {
      if (substitutionInput.value.includes(',')) {
        substitutionInput.value = substitutionInput.value.replace(',', '.');
      }
      updateGradeValueColor(substitutionInput, substitutionInput.value);
    });
    substitutionInput.addEventListener('change', () => {
      const value = parseGradeInput(substitutionInput.value);
      if (value !== null && (!Number.isFinite(value) || value < 1 || value > 7)) {
        substitutionInput.value = subject.substitution?.score === null
          || subject.substitution?.score === undefined ? '' : gradeInputText(subject.substitution.score);
        updateGradeValueColor(substitutionInput, substitutionInput.value);
        message('La nota sustitutiva debe estar entre 1,0 y 7,0.', true);
        return;
      }
      saveSubstitution(Number(evaluationSelect.value), value);
    });
    if (theoreticalExamSlot && subject.exam_scope === 'teorico') {
      theoreticalExamSlot.append(substitutionCard);
    } else {
      cards.append(substitutionCard);
    }
  }
  const mandatoryExam = !subject.exemption_enabled;
  const showExam = Number(subject.exam_weight) > 0
    && (mandatoryExam || subject.exam_score !== null && subject.exam_score !== undefined
      || (allNotesEntered && exemptionResult?.state !== 'achieved'));
  if (showExam) {
    const calculatedExam = requiredExamGrade(subject);
    const exam = Number.isFinite(calculatedExam) && subject.exam_is_failing
      ? Math.max(4, calculatedExam) : calculatedExam;
    const examCard = element('div', 'grade-calculation-card grade-exam-card');
    if (subject.exam_scope === 'teorico') examCard.classList.add('grade-theory-exam-related');
    const examHeading = element('div', 'grade-exam-heading');
    examHeading.append(element('span', '', 'Nota necesaria en examen'));
    if (subject.exam_is_failing) {
      examHeading.append(element('small', 'grade-exam-failing-badge', 'REPROBATORIO'));
    }
    examCard.append(examHeading);
    let value = '—';
    if (Number.isFinite(exam)) {
      if (exam <= 1) value = '1.0';
      else if (exam > 7) value = 'No es posible';
      else value = gradeText(exam);
    }
    const requiredExam = element('strong', 'grade-required-exam', value);
    if (Number.isFinite(exam) && exam <= 7) updateGradeValueColor(requiredExam, Math.max(1, exam));
    examCard.append(requiredExam);
    if (!subject.simulation_active) {
      const examScoreLabel = element('label', 'grade-exam-score-field', 'Nota obtenida en el examen');
      const examScoreInput = element('input');
      examScoreInput.type = 'text';
      examScoreInput.inputMode = 'decimal';
      examScoreInput.maxLength = 4;
      examScoreInput.placeholder = 'Ej: 5.0';
      examScoreInput.value = subject.exam_score === null || subject.exam_score === undefined
        ? '' : gradeInputText(subject.exam_score);
      updateGradeValueColor(examScoreInput, examScoreInput.value);
      examScoreLabel.append(examScoreInput);
      examCard.append(examScoreLabel);
      examScoreInput.addEventListener('input', () => {
        if (examScoreInput.value.includes(',')) examScoreInput.value = examScoreInput.value.replace(',', '.');
        updateGradeValueColor(examScoreInput, examScoreInput.value);
      });
      examScoreInput.addEventListener('change', async () => {
        const value = parseGradeInput(examScoreInput.value);
        if (value !== null && (!Number.isFinite(value) || value < 1 || value > 7)) {
          examScoreInput.value = subject.exam_score === null || subject.exam_score === undefined
            ? '' : gradeInputText(subject.exam_score);
          updateGradeValueColor(examScoreInput, examScoreInput.value);
          message('La nota del examen debe estar entre 1,0 y 7,0.', true);
          return;
        }
        examScoreInput.disabled = true;
        try {
          const saved = await api('/api/grade-exam-score', { subject_id: subject.id, score: value });
          subject.exam_score = saved.score;
          if (onUpdate) onUpdate();
        } catch (error) {
          message(error.message, true);
          if (onUpdate) onUpdate();
        }
      });
    }
    if (subject.exam_scope === 'teorico' && subject.exam_score !== null
        && subject.exam_score !== undefined) {
      const adjusted = element('div', 'grade-exam-adjusted');
      adjusted.append(element('span', '', 'Promedio teórico con examen'),
        averageValueElement(theoreticalGradeWithExam(subject)));
      examCard.append(adjusted);
    }
    if (theoreticalExamSlot && subject.exam_scope === 'teorico') {
      theoreticalExamSlot.append(examCard);
    } else {
      cards.append(examCard);
    }
  }
  const finalCard = element('div', 'grade-calculation-card grade-final-average');
  finalCard.append(element('span', '', 'Promedio final'),
    averageValueElement(finalGradeValue(subject), '—'));
  if (subjectFailure(subject).failed) {
    finalCard.append(element('b', 'grade-course-failed', 'REPROBADO'));
  }
  cards.append(finalCard);
  container.append(cards);
  if (theoreticalExamSlot) theoreticalExamSlot.hidden = theoreticalExamSlot.childElementCount === 0;
}

function gradeInterfaceIcon(type) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const paths = type === 'edit'
    ? ['M4 20l4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z', 'M14.8 6.5l2.7 2.7']
    : ['m6 9 6 6 6-6'];
  paths.forEach(value => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', value);
    svg.append(path);
  });
  return svg;
}

function renderClosedGradeSummary(subject, container) {
  container.replaceChildren();
  if (!studentState.authenticated || !subject.evaluations.length) return;
  const exemptionScope = subject.exemption_scope === 'teorico' ? 'teorico' : 'total';
  const exemptionEntries = gradeCoefficients(subject, exemptionScope).entries;
  const exemptionComplete = exemptionEntries.length > 0
    && exemptionEntries.every(item => evaluationScore(subject, item) !== null);
  const exemptionAverage = currentGrade(subject, exemptionScope).value;
  const exempted = Boolean(subject.exemption_enabled && exemptionComplete
    && exemptionAverage !== null && meetsGrade(exemptionAverage, Number(subject.exemption_grade)));
  const exemptionText = exempted ? 'Eximido' : 'No eximido';
  const failure = subjectFailure(subject);
  const addLine = (label, average, status = '') => {
    const line = element('span', 'grade-subject-summary-line');
    const value = average === null ? '—' : averageText(average);
    line.textContent = `${label} ${value}${status ? ` · ${status}` : ''}`;
    if (average !== null && roundedGrade(average) < 4) line.classList.add('grade-below-passing');
    if (status === 'Reprobado') line.classList.add('grade-failed-status');
    container.append(line);
  };
  if (subject.course_type === 'teorico_practico') {
    addLine('Promedio Teórico', currentGrade(subject, 'teorico').value,
      failure.theoretical || failure.exam ? 'Reprobado' : exemptionText);
    addLine('Promedio Práctico', currentGrade(subject, 'practico').value,
      failure.practical ? 'Reprobado' : '');
  } else {
    addLine('Promedio', currentGrade(subject, 'teorico').value,
      failure.failed ? 'Reprobado' : exemptionText);
  }
}

function renderGradeSubjects(expandedSubjectId = null) {
  const list = $('notes-subjects-list');
  if (!list) return;
  list.replaceChildren();
  $('notes-subjects-empty').hidden = gradeSubjects.length > 0;
  gradeSubjects.forEach(subject => {
    const card = element('article', 'grade-subject-card');
    card.dataset.subjectId = subject.id;
    card.classList.toggle('is-simulating', Boolean(subject.simulation_active));
    const header = element('div', 'grade-subject-header');
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', 'false');
    const identity = element('span', 'grade-subject-identity');
    const color = element('i', 'subject-color-dot');
    color.style.backgroundColor = subject.color;
    const identityText = element('span', 'grade-subject-identity-text');
    identityText.append(element('strong', '', subject.name));
    const closedSummary = element('span', 'grade-subject-closed-summary');
    renderClosedGradeSummary(subject, closedSummary);
    identityText.append(closedSummary);
    identity.append(color, identityText);
    const controls = element('span', 'grade-subject-controls');
    if (adminState.authenticated) {
      const edit = element('button', 'grade-config-edit');
      edit.type = 'button';
      edit.append(gradeInterfaceIcon('edit'));
      edit.setAttribute('aria-label', `Configurar notas de ${subject.name}`);
      edit.title = 'Configurar ramo';
      edit.addEventListener('click', event => {
        event.stopPropagation();
        openGradeSettings(subject);
      });
      controls.append(edit);
    }
    const arrow = element('span', 'grade-subject-arrow');
    arrow.append(gradeInterfaceIcon('arrow'));
    controls.append(arrow);
    header.append(identity, controls);
    const body = element('div', 'grade-subject-body');
    body.hidden = true;
    const categoryStats = element('div', 'grade-category-stats');
    if (subject.course_type === 'teorico_practico') {
      categoryStats.append(
        element('span', 'stat', `Teórico: ${percentage(subject.theoretical_weight)}`),
        element('span', 'stat', `Práctico: ${percentage(subject.practical_weight)}`)
      );
    } else {
      categoryStats.append(element('span', 'stat', 'Solo teórico'));
    }
    const saveStatus = element('span', 'grade-save-status');
    saveStatus.hidden = true;
    saveStatus.setAttribute('aria-live', 'polite');
    categoryStats.append(saveStatus);
    let saveStatusTimer = null;
    let latestSave = 0;
    const setSaveStatus = (state, text, saveId) => {
      if (saveId !== latestSave) return;
      clearTimeout(saveStatusTimer);
      saveStatus.className = `grade-save-status ${state}`;
      saveStatus.textContent = text;
      saveStatus.hidden = false;
      if (state !== 'saving') {
        saveStatusTimer = setTimeout(() => {
          if (saveId === latestSave) saveStatus.hidden = true;
        }, state === 'saved' ? 1800 : 3000);
      }
    };
    body.append(categoryStats);
    const categoryAverageContainers = {};
    const categoryExemptionContainers = {};
    let calculations = null;
    let theoreticalExamSlot = null;
    let refreshSimulationControls = () => {};
    const refreshGradeDerived = () => {
      renderClosedGradeSummary(subject, closedSummary);
      Object.entries(categoryAverageContainers).forEach(([categoryName, averageContainer]) => {
        renderCategoryAverage(subject, categoryName, averageContainer);
      });
      Object.values(categoryExemptionContainers).forEach(exemptionContainer => {
        renderTheoreticalExemption(subject, exemptionContainer);
      });
      if (calculations) {
        renderGradeCalculations(subject, calculations, refreshGradeDerived, theoreticalExamSlot);
      }
      refreshSimulationControls();
    };
    if (subject.evaluations.length) {
      const evaluations = element('div', 'grade-summary-evaluations');
      for (const category of ['teorico', 'practico']) {
        const entries = subject.evaluations.filter(item => item.category === category);
        if (!entries.length) continue;
        const section = element('section', 'grade-summary-category');
        section.append(element('h4', '', category === 'teorico' ? 'Teórico' : 'Práctico'));
        entries.forEach(item => {
          const row = element('div', 'grade-summary-row');
          const scoreArea = element('span', 'grade-score-area');
          if (studentState.authenticated) {
            const score = element('input', 'grade-score-input');
            score.type = 'text';
            score.inputMode = 'decimal';
            score.maxLength = 4;
            score.placeholder = 'Ej: 7.0';
            const simulationPending = subject.simulation_active
              && (item.score === null || item.score === undefined);
            score.value = simulationPending
              ? gradeInputText(item.simulation_score) : gradeInputText(item.score);
            updateGradeValueColor(score, score.value);
            if (simulationPending) score.classList.add('grade-simulation-input');
            if (subject.simulation_active && !simulationPending) score.disabled = true;
            score.setAttribute('aria-label', `Nota de ${item.name}`);
            score.addEventListener('click', event => event.stopPropagation());
            score.addEventListener('input', () => {
              if (score.value.includes(',')) score.value = score.value.replace(',', '.');
              updateGradeValueColor(score, score.value);
              if (simulationPending) {
                const simulated = parseGradeInput(score.value);
                item.simulation_score = Number.isFinite(simulated)
                  && simulated >= 1 && simulated <= 7 ? simulated : null;
                refreshGradeDerived();
              }
            });
            score.addEventListener('change', async () => {
              if (simulationPending) {
                const simulated = parseGradeInput(score.value);
                if (simulated !== null && (!Number.isFinite(simulated) || simulated < 1 || simulated > 7)) {
                  score.value = gradeInputText(item.simulation_score);
                  updateGradeValueColor(score, score.value);
                  message('La nota simulada debe estar entre 1,0 y 7,0.', true);
                  return;
                }
                item.simulation_score = simulated;
                score.value = gradeInputText(simulated);
                updateGradeValueColor(score, score.value);
                refreshGradeDerived();
                return;
              }
              const previous = item.score;
              const value = parseGradeInput(score.value);
              if (value !== null && (!Number.isFinite(value) || value < 1 || value > 7)) {
                score.value = gradeInputText(previous);
                updateGradeValueColor(score, score.value);
                message('La nota debe estar entre 1,0 y 7,0.', true);
                return;
              }
              const saveId = ++latestSave;
              setSaveStatus('saving', 'Guardando…', saveId);
              score.disabled = true;
              try {
                const saved = await api('/api/grade-scores', { evaluation_id: item.id, score: value });
                item.score = saved.score;
                if (saved.substitution_deleted) subject.substitution = null;
                score.value = gradeInputText(saved.score);
                updateGradeValueColor(score, score.value);
                refreshGradeDerived();
                setSaveStatus('saved', 'Guardado ✓', saveId);
              } catch (error) {
                score.value = gradeInputText(previous);
                updateGradeValueColor(score, score.value);
                setSaveStatus('error', 'No se pudo guardar', saveId);
                message(error.message, true);
              } finally { score.disabled = false; }
            });
            scoreArea.append(score);
          } else {
            scoreArea.append(element('span', 'grade-score-placeholder', '—'));
          }
          scoreArea.append(element('strong', '', percentage(item.weight)));
          const evaluationLabel = element('span', 'grade-evaluation-label', item.name);
          row.append(evaluationLabel, scoreArea);
          section.append(row);
        });
        if (Number(subject.practical_weight) > 0) {
          const categoryAverage = element('div', 'grade-category-average');
          categoryAverageContainers[category] = categoryAverage;
          renderCategoryAverage(subject, category, categoryAverage);
          section.append(categoryAverage);
        }
        if (category === 'teorico' && subject.exemption_enabled && subject.exemption_scope === 'teorico') {
          const exemptionContainer = element('div', 'grade-category-exemption');
          categoryExemptionContainers[category] = exemptionContainer;
          renderTheoreticalExemption(subject, exemptionContainer);
          section.append(exemptionContainer);
        }
        evaluations.append(section);
        if (category === 'teorico' && subject.course_type === 'teorico_practico'
            && subject.exam_scope === 'teorico' && Number(subject.exam_weight) > 0) {
          evaluations.classList.add('has-theoretical-exam');
          theoreticalExamSlot = element('section', 'grade-theoretical-exam-slot');
          theoreticalExamSlot.hidden = true;
          evaluations.append(theoreticalExamSlot);
        }
      }
      body.append(evaluations);
    } else {
      body.append(element('p', 'grade-empty-config', adminState.authenticated
        ? 'Aún no hay evaluaciones. Usa el lápiz para configurar este ramo.'
        : 'Aún no se han configurado evaluaciones para este ramo.'));
    }
    calculations = element('div', 'grade-calculations');
    body.append(calculations);
    const simulationControls = element('div', 'grade-simulation-controls');
    body.append(simulationControls);
    refreshSimulationControls = () => {
      const pendingEvaluations = subject.evaluations.filter(item =>
        item.score === null || item.score === undefined || item.score === ''
        || !Number.isFinite(Number(item.score)));
      simulationControls.replaceChildren();
      simulationControls.hidden = !studentState.authenticated || pendingEvaluations.length === 0;
      if (simulationControls.hidden) return;
      if (subject.simulation_active) {
        const simulationInfo = element('div', 'grade-simulation-info');
        simulationInfo.append(
          element('strong', '', 'Modo simulación'),
          element('span', '', 'Estas notas son temporales y no se guardarán.')
        );
        simulationControls.append(simulationInfo);
      }
      const simulationButton = element('button', subject.simulation_active
        ? 'secondary-button grade-simulation-close' : 'secondary-button grade-simulation-open',
      subject.simulation_active ? 'Cerrar simulación' : 'Simular notas pendientes');
      simulationButton.type = 'button';
      simulationButton.addEventListener('click', event => {
        event.stopPropagation();
        const closing = Boolean(subject.simulation_active);
        subject.simulation_active = !closing;
        if (closing) pendingEvaluations.forEach(item => { delete item.simulation_score; });
        renderGradeSubjects(subject.id);
      });
      simulationControls.append(simulationButton);
    };
    refreshGradeDerived();
    const toggleBody = () => {
      body.hidden = !body.hidden;
      header.setAttribute('aria-expanded', String(!body.hidden));
      arrow.classList.toggle('open', !body.hidden);
    };
    header.addEventListener('click', toggleBody);
    header.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleBody();
    });
    if (Number(expandedSubjectId) === Number(subject.id)) {
      body.hidden = false;
      header.setAttribute('aria-expanded', 'true');
      arrow.classList.add('open');
    }
    card.append(header, body);
    list.append(card);
  });
}

function updateGradeEvaluationOrder(container) {
  const rows = [...container.querySelectorAll('.grade-evaluation-row')];
  rows.forEach((row, index) => {
    const handle = row.querySelector('.grade-drag-handle');
    handle.setAttribute('aria-label', `Reordenar evaluación. Posición ${index + 1} de ${rows.length}`);
  });
}

function enableGradeEvaluationDragging(row, handle) {
  let pointerId = null;
  let dragGhost = null;
  let dragStartY = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  handle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const container = row.parentElement;
    const sibling = event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    if (!sibling) return;
    if (event.key === 'ArrowUp') container.insertBefore(row, sibling);
    else container.insertBefore(sibling, row);
    updateGradeEvaluationOrder(container);
    event.preventDefault();
  });
  const move = event => {
    if (event.pointerId !== pointerId) return;
    const container = row.parentElement;
    const siblings = [...container.querySelectorAll('.grade-evaluation-row:not(.is-dragging)')];
    if (dragGhost) dragGhost.style.transform = `translate3d(0, ${event.clientY - dragStartY}px, 0)`;
    const nextRow = siblings.find(item => {
      const box = item.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    const reference = nextRow || null;
    const alreadyThere = reference ? row.nextElementSibling === reference : row === container.lastElementChild;
    if (!alreadyThere) {
      const previousPositions = new Map(siblings.map(item => [item, item.getBoundingClientRect().top]));
      container.insertBefore(row, reference);
      if (!reducedMotion.matches) siblings.forEach(item => {
        const distance = previousPositions.get(item) - item.getBoundingClientRect().top;
        if (distance) item.animate(
          [{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }],
          { duration: 190, easing: 'cubic-bezier(.2,.8,.2,1)' }
        );
      });
    }
    event.preventDefault();
  };
  const finish = event => {
    if (event && event.pointerId !== pointerId) return;
    if (pointerId === null) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    const ghostBox = dragGhost?.getBoundingClientRect();
    dragGhost?.remove();
    dragGhost = null;
    row.classList.remove('is-dragging');
    document.body.classList.remove('is-reordering-grade');
    if (ghostBox && !reducedMotion.matches) {
      const finalBox = row.getBoundingClientRect();
      row.animate([
        { transform: `translate(${ghostBox.left - finalBox.left}px, ${ghostBox.top - finalBox.top}px)`, opacity: .9 },
        { transform: 'translate(0, 0)', opacity: 1 }
      ], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    updateGradeEvaluationOrder(row.parentElement);
    pointerId = null;
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== undefined && event.button !== 0) return;
    pointerId = event.pointerId;
    dragStartY = event.clientY;
    const box = row.getBoundingClientRect();
    dragGhost = row.cloneNode(true);
    dragGhost.classList.add('grade-drag-ghost');
    dragGhost.style.left = `${box.left}px`;
    dragGhost.style.top = `${box.top}px`;
    dragGhost.style.width = `${box.width}px`;
    dragGhost.style.height = `${box.height}px`;
    document.body.append(dragGhost);
    row.classList.add('is-dragging');
    document.body.classList.add('is-reordering-grade');
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    event.preventDefault();
  });
}

function addGradeEvaluationRow(evaluation = {}, fixedCategory = evaluation.category || 'teorico') {
  const row = element('div', 'grade-evaluation-row');
  if (evaluation.id) row.dataset.evaluationId = evaluation.id;
  row.dataset.category = fixedCategory;
  const nameLabel = element('label', '', 'Nombre');
  const name = element('input');
  name.className = 'grade-evaluation-name';
  name.required = true;
  name.maxLength = 120;
  name.placeholder = 'Ej: Certamen 1';
  name.value = evaluation.name || '';
  nameLabel.append(name);
  const weightLabel = element('label', '', 'Ponderación (%)');
  const weight = element('input');
  weight.className = 'grade-evaluation-weight';
  weight.type = 'text';
  weight.inputMode = 'decimal';
  weight.maxLength = 6;
  weight.placeholder = 'Ej: 33.33';
  weight.required = true;
  weight.value = percentageInputText(evaluation.weight);
  weight.addEventListener('input', () => {
    if (weight.value.includes(',')) weight.value = weight.value.replace(',', '.');
    renderGradeSettingsWarnings();
  });
  weight.addEventListener('change', () => {
    const parsed = parsePercentageInput(weight.value);
    if (Number.isFinite(parsed)) weight.value = percentageInputText(parsed);
  });
  weightLabel.append(weight);
  let substitutableControl;
  if (fixedCategory === 'teorico') {
    const substitutableLabel = element('label', 'grade-substitutable-option');
    const substitutable = element('input');
    substitutable.className = 'grade-evaluation-substitutable';
    substitutable.type = 'checkbox';
    substitutable.checked = Boolean(evaluation.substitutable);
    substitutableLabel.append(substitutable, document.createTextNode('¿Es sustituible?'));
    substitutableControl = substitutableLabel;
  } else {
    substitutableControl = element('span', 'grade-substitutable-spacer');
  }
  const handle = element('button', 'grade-drag-handle');
  handle.type = 'button';
  handle.innerHTML = '<span></span><span></span><span></span><span></span><span></span><span></span>';
  handle.title = 'Mantén presionado y arrastra para cambiar el orden';
  enableGradeEvaluationDragging(row, handle);
  const remove = element('button', 'danger-button grade-evaluation-remove', 'Eliminar');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    const container = row.parentElement;
    row.remove();
    updateGradeEvaluationOrder(container);
    renderGradeSettingsWarnings();
  });
  row.append(handle, nameLabel, weightLabel, substitutableControl, remove);
  const container = $(fixedCategory === 'teorico'
    ? 'grade-theoretical-evaluations' : 'grade-practical-evaluations');
  container.append(row);
  updateGradeEvaluationOrder(container);
  renderGradeSettingsWarnings();
}

function gradeCourseIsPractical() {
  return $('grade-course-type').value === 'teorico_practico';
}

function gradeEvaluationRows(category) {
  return [...$(category === 'teorico'
    ? 'grade-theoretical-evaluations' : 'grade-practical-evaluations')
    .querySelectorAll('.grade-evaluation-row')];
}

function gradeSettingsProblems() {
  const problems = [];
  const practicalCourse = gradeCourseIsPractical();
  const theoreticalRows = gradeEvaluationRows('teorico');
  const practicalRows = practicalCourse ? gradeEvaluationRows('practico') : [];
  const checkEvaluations = (rows, label) => {
    if (!rows.length) {
      problems.push(`Agrega al menos una evaluación ${label}.`);
      return;
    }
    const weights = rows.map(row => parsePercentageInput(
      row.querySelector('.grade-evaluation-weight').value));
    if (weights.some(weight => !Number.isFinite(weight))) {
      problems.push(`Completa correctamente las ponderaciones ${label}s.`);
      return;
    }
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (Math.abs(total - 100) > .001) {
      problems.push(`Las evaluaciones ${label}s suman ${percentage(total)}; deben sumar 100%.`);
    }
  };
  checkEvaluations(theoreticalRows, 'teórica');
  if (practicalCourse) {
    const theoreticalWeight = Number($('grade-theoretical-weight').value);
    const practicalWeight = Number($('grade-practical-weight').value);
    if (!(theoreticalWeight > 0) || !(practicalWeight > 0)) {
      problems.push('Las categorías Teórica y Práctica deben tener una ponderación mayor que 0%.');
    } else if (Math.abs(theoreticalWeight + practicalWeight - 100) > .001) {
      problems.push(`Las categorías suman ${percentage(theoreticalWeight + practicalWeight)}; deben sumar 100%.`);
    }
    checkEvaluations(practicalRows, 'práctica');
  }
  return problems;
}

function renderGradeSettingsWarnings() {
  const warningBox = $('grade-settings-warnings');
  if (!warningBox) return [];
  const problems = gradeSettingsProblems();
  warningBox.replaceChildren();
  warningBox.hidden = problems.length === 0;
  if (problems.length) {
    warningBox.append(element('strong', '', 'Revisa la configuración'));
    const list = element('ul');
    problems.forEach(problem => list.append(element('li', '', problem)));
    warningBox.append(list);
  }
  return problems;
}

function syncGradeCourseType() {
  const practicalCourse = gradeCourseIsPractical();
  $('grade-category-weights').hidden = !practicalCourse;
  $('grade-practical-group').hidden = !practicalCourse;
  $('grade-exemption-scope-field').hidden = !practicalCourse;
  $('grade-exam-scope-field').hidden = !practicalCourse;
  if (!practicalCourse) {
    $('grade-theoretical-weight').value = 100;
    $('grade-practical-weight').value = 0;
    $('grade-exemption-scope').value = 'teorico';
    $('grade-exam-scope').value = 'teorico';
  }
  renderGradeSettingsWarnings();
}

function openGradeSettings(subject) {
  $('grade-subject-id').value = subject.id;
  $('grade-settings-title').textContent = subject.name;
  $('grade-course-type').value = subject.course_type || (
    Number(subject.practical_weight) > 0
      || subject.evaluations.some(evaluation => evaluation.category === 'practico')
      ? 'teorico_practico' : 'teorico');
  $('grade-theoretical-weight').value = subject.theoretical_weight;
  $('grade-practical-weight').value = subject.practical_weight;
  $('grade-exemption-enabled').checked = Boolean(subject.exemption_enabled);
  $('grade-exemption-grade').value = subject.exemption_grade;
  $('grade-exemption-scope').value = subject.exemption_scope;
  $('grade-exam-weight').value = subject.exam_weight;
  $('grade-exam-scope').value = subject.exam_scope;
  $('grade-exam-is-failing').checked = Boolean(subject.exam_is_failing);
  $('grade-exemption-options').hidden = !$('grade-exemption-enabled').checked;
  $('grade-theoretical-evaluations').replaceChildren();
  $('grade-practical-evaluations').replaceChildren();
  subject.evaluations.forEach(evaluation => addGradeEvaluationRow(evaluation));
  syncGradeCourseType();
  $('grade-settings-dialog').showModal();
}

async function openAttendance(sessionId) {
  try {
    if (!adminState.authenticated && !studentState.authenticated) {
      await openStudentDialog();
      message('Ingresa para marcar tu asistencia.');
      return;
    }
    const data = await api(`/api/session?session_id=${sessionId}`);
    $('dialog-title').textContent = `${classLabel(data.session)} del ${readableDate(data.session.class_date)}`;
    $('dialog-subtitle').textContent = data.session.title || 'Sin tema indicado';
    const list = $('attendance-list');
    list.replaceChildren();
    const visibleStudents = adminState.authenticated ? data.students
      : data.students.filter(student => student.id === studentState.student_id);
    if (!visibleStudents.length) list.append(element('div', 'empty', 'Tu registro de estudiante no está disponible.'));
    visibleStudents.forEach(student => {
      const row = element('div', 'attendance-row');
      row.append(element('strong', '', student.name));
      const select = element('select');
      option(select, 'presente', 'Presente');
      option(select, 'ausente', 'Ausente (automático)');
      option(select, 'justificado', 'Justificado');
      select.value = student.status;
      select.addEventListener('change', async () => {
        const chosen = select.value;
        select.disabled = true;
        try {
          await api('/api/attendance', { session_id: sessionId, student_id: student.id, status: chosen });
          student.status = chosen;
          await refreshSubject();
          await refreshReport();
        } catch (error) {
          select.value = student.status;
          message(error.message, true);
        } finally { select.disabled = false; }
      });
      row.append(select);
      list.append(row);
    });
    $('attendance-dialog').showModal();
  } catch (error) { message(error.message, true); }
}

function eventMonthKey() {
  return `${eventMonth.getFullYear()}-${String(eventMonth.getMonth() + 1).padStart(2, '0')}`;
}

async function refreshEvents() {
  const month = eventMonthKey();
  const events = await api(`/api/events?month=${month}&subject_id=all`);
  if (month !== eventMonthKey()) return;
  calendarEvents = events;
  $('event-month').textContent = eventMonth.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  renderEventCalendar();
}

async function refreshUpcomingEvents() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const dates = [today, tomorrow].map(value => value.toLocaleDateString('en-CA'));
  const months = [...new Set(dates.map(value => value.slice(0, 7)))];
  const [responses, nextTest] = await Promise.all([
    Promise.all(months.map(month => api(`/api/events?month=${month}&subject_id=all`))),
    api('/api/events/next-test')
  ]);
  const wanted = new Set(dates);
  upcomingCalendarEvents = responses.flat().filter(item => wanted.has(item.event_date));
  nextTestEvent = nextTest;
  renderUpcomingEvents();
}

function renderEventCalendar() {
  const grid = $('event-grid');
  grid.replaceChildren();
  const year = eventMonth.getFullYear();
  const month = eventMonth.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const todayIso = new Date().toLocaleDateString('en-CA');
  for (let i = 0; i < offset; i++) grid.append(element('div', 'calendar-spacer'));
  for (let day = 1; day <= days; day++) {
    const iso = `${eventMonthKey()}-${String(day).padStart(2, '0')}`;
    const entries = calendarEvents.filter(item => item.event_date === iso);
    const subjects = [...new Map(entries.map(item => [item.subject_id, {
      name: item.subject_name,
      abbreviation: item.subject_abbreviation,
      color: item.color
    }])).values()];
    const button = element('button', `calendar-day${entries.length ? ' has-event' : ''}${iso === todayIso ? ' is-today' : ''}${selectedEventDate === iso ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-label', `${readableDate(iso)}: ${entries.length} evento${entries.length === 1 ? '' : 's'}`);
    if (subjects.length) {
      const stripeSize = 100 / subjects.length;
      const borderStops = subjects.flatMap((subject, index) => [
        `${subject.color} ${index * stripeSize}%`,
        `${subject.color} ${(index + 1) * stripeSize}%`
      ]);
      const fillStops = subjects.flatMap((subject, index) => [
        `${subject.color}38 ${index * stripeSize}%`,
        `${subject.color}38 ${(index + 1) * stripeSize}%`
      ]);
      button.style.background = `linear-gradient(90deg, ${fillStops.join(', ')}) padding-box, linear-gradient(90deg, ${borderStops.join(', ')}) border-box`;
      button.style.borderColor = 'transparent';
    }
    const dayHead = element('span', 'event-day-head');
    dayHead.append(element('span', 'day-number', day));
    if (entries.some(item => item.event_type === 'Prueba')) dayHead.append(element('span', 'test-label', 'Prueba'));
    button.append(dayHead);
    if (subjects.length) {
      const names = element('span', 'event-subject-names');
      subjects.forEach(subject => names.append(element('span', 'event-subject-name',
        subject.abbreviation || subject.name.slice(0, 3).toUpperCase())));
      button.append(names);
    }
    button.addEventListener('click', () => {
      selectedEventDate = iso;
      if (adminState.authenticated) $('event-date').value = iso;
      renderEventCalendar();
    });
    grid.append(button);
  }
  renderEventDetail();
}

function buildEventList(entries) {
  const list = element('div', 'event-list');
  entries.forEach(item => {
    const row = element('div', 'event-item');
    row.style.borderLeftColor = item.color;
    const text = element('div');
    const heading = element('strong', 'event-heading');
    const color = element('i', 'event-color-dot');
    color.style.backgroundColor = item.color;
    heading.append(color, document.createTextNode(`${item.event_time ? `${item.event_time} · ` : ''}${item.event_type} · ${item.subject_name}`));
    text.append(heading,
      element('p', '', item.title), item.details ? element('small', '', item.details) : document.createTextNode(''));
    row.append(text);
    if (adminState.authenticated) {
      const actions = element('div', 'event-actions');
      const edit = element('button', 'secondary-button', 'Editar');
      edit.type = 'button';
      edit.addEventListener('click', () => {
        editingEventId = item.id;
        $('event-subject').value = String(item.subject_id);
        $('event-date').value = item.event_date;
        $('event-time').value = item.event_time || '';
        $('event-type').value = item.event_type;
        $('event-title').value = item.title;
        $('event-details').value = item.details;
        $('event-save').textContent = 'Guardar cambios';
        $('event-cancel').hidden = false;
        $('event-editor-title').textContent = 'Modificar fecha';
        if (!$('event-editor-dialog').open) $('event-editor-dialog').showModal();
        $('event-title').focus();
      });
      const remove = element('button', 'danger-button', 'Eliminar');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!confirm(`¿Eliminar “${item.title}”?`)) return;
        try {
          await api(`/api/events/${item.id}`, undefined, 'DELETE');
          await Promise.all([refreshEvents(), refreshUpcomingEvents()]);
          message('Fecha eliminada.');
        } catch (error) { message(error.message, true); }
      });
      actions.append(edit, remove);
      row.append(actions);
    }
    list.append(row);
  });
  return list;
}

function buildUpcomingList(entries) {
  const list = element('div', 'event-upcoming-list');
  entries.forEach(item => {
    const row = element('div', 'event-upcoming-item');
    row.style.borderLeftColor = item.color;
    const meta = element('strong', 'event-upcoming-meta',
      `${item.event_time || 'Sin hora'} · ${item.subject_abbreviation || item.subject_name.slice(0, 3).toUpperCase()} · ${item.event_type}`);
    const title = element('span', 'event-upcoming-title', item.title);
    row.append(meta, title);
    if (item.details) row.append(element('small', 'event-upcoming-description', item.details));
    list.append(row);
  });
  return list;
}

function appendUpcomingDay(detail, label, iso) {
  const section = element('section', 'event-upcoming-day');
  const heading = element('div', 'event-upcoming-heading');
  heading.append(element('strong', '', label), element('span', '', readableDate(iso)));
  section.append(heading);
  const entries = upcomingCalendarEvents.filter(item => item.event_date === iso);
  if (entries.length) section.append(buildUpcomingList(entries));
  else section.append(element('p', 'event-upcoming-empty', 'No hay actividades programadas.'));
  detail.append(section);
}

function renderUpcomingEvents() {
  const upcoming = $('event-upcoming');
  upcoming.replaceChildren();
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  appendUpcomingDay(upcoming, 'Hoy', today.toLocaleDateString('en-CA'));
  appendUpcomingDay(upcoming, 'Mañana', tomorrow.toLocaleDateString('en-CA'));
  renderNextTest();
}

function renderNextTest() {
  const container = $('next-test');
  container.replaceChildren();
  if (!nextTestEvent) {
    const empty = element('div', 'next-test-empty');
    empty.append(element('strong', '', 'Próxima prueba'),
      element('span', '', 'No hay próximas pruebas programadas.'));
    container.append(empty);
    return;
  }
  const test = nextTestEvent;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const target = new Date(`${test.event_date}T12:00:00`);
  const days = Math.max(0, Math.round((target - today) / 86400000));
  const relative = days === 0 ? 'Hoy' : days === 1 ? 'Mañana' : `En ${days} días`;
  const card = element('button', 'next-test-card');
  card.type = 'button';
  card.style.borderLeftColor = test.color;
  const heading = element('span', 'next-test-heading');
  heading.append(element('span', 'next-test-label', 'Próxima prueba'),
    element('strong', 'next-test-relative', relative));
  const title = element('strong', 'next-test-title', test.title);
  const meta = element('span', 'next-test-meta',
    `${test.subject_name} · ${readableDate(test.event_date)}${test.event_time ? ` · ${test.event_time}` : ''}`);
  card.append(heading, title, meta);
  if (test.details) card.append(element('small', 'next-test-description', test.details));
  card.addEventListener('click', async () => {
    selectedEventDate = test.event_date;
    eventMonth = new Date(`${test.event_date}T12:00:00`);
    try {
      await refreshEvents();
      $('event-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) { message(error.message, true); }
  });
  container.append(card);
}

function renderEventDetail() {
  const detail = $('event-detail');
  detail.replaceChildren();
  if (!selectedEventDate || !selectedEventDate.startsWith(eventMonthKey())) {
    detail.textContent = 'Selecciona un día para ver su programación.';
    return;
  }
  const entries = calendarEvents.filter(item => item.event_date === selectedEventDate);
  detail.append(element('strong', '', readableDate(selectedEventDate)));
  if (!entries.length) { detail.append(element('p', '', 'No hay fechas calendarizadas este día.')); return; }
  detail.append(buildEventList(entries));
}

function resetEventEditorForm(dateValue = selectedEventDate || new Date().toLocaleDateString('en-CA')) {
  editingEventId = null;
  $('event-subject').value = String(overview.subjects[0]?.id || '');
  $('event-date').value = dateValue;
  $('event-time').value = '';
  $('event-type').value = 'Prueba';
  $('event-title').value = '';
  $('event-details').value = '';
  $('event-save').textContent = 'Agregar fecha';
  $('event-cancel').hidden = true;
  $('event-editor-title').textContent = 'Agregar fecha';
}

function onSubmit(id, action) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try { await action(); } catch (error) { message(error.message, true); }
    finally { button.disabled = false; }
  });
}

onSubmit('student-form', async () => {
  const student = await api('/api/students', { name: $('student-name').value });
  $('student-name').value = '';
  showActivation(student.name, student.activation_code);
  await loadOverview();
  message('Estudiante agregado. Entrega su código de activación.');
});
onSubmit('subject-form', async () => {
  const subject = await api('/api/subjects', {
    name: $('subject-name').value,
    abbreviation: $('subject-abbreviation').value,
    color: $('subject-color').value
  });
  $('subject-name').value = '';
  $('subject-abbreviation').value = '';
  addSubject = subject.id;
  await loadOverview();
  message('Ramo agregado.');
});
$('session-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!requireClassLogin()) return;
  const hasAttendance = $('class-has-attendance').checked;
  if (editingClassOriginal?.has_attendance && !hasAttendance
      && Number(editingClassOriginal.recorded_attendance) > 0
      && !confirm('Esta clase dejará de contar en la asistencia. Las marcas existentes se conservarán, pero quedarán excluidas de los porcentajes. ¿Continuar?')) return;
  const button = $('class-save');
  button.disabled = true;
  const payload = {
    subject_id: Number($('add-subject').value),
    class_date: $('class-date').value,
    title: $('class-title').value,
    has_attendance: hasAttendance
  };
  try {
    const wasEditing = Boolean(editingClassId);
    if (wasEditing) await api(`/api/sessions/${editingClassId}`, payload, 'PATCH');
    else await api('/api/sessions', payload);
    addSubject = payload.subject_id;
    $('class-editor-dialog').close();
    resetClassEditor();
    await Promise.all([refreshSubject(), refreshReport()]);
    message(wasEditing ? 'Clase actualizada.' : 'Clase agregada.');
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});
onSubmit('event-form', async () => {
  const payload = { subject_id: Number($('event-subject').value), event_date: $('event-date').value,
    event_time: $('event-time').value, event_type: $('event-type').value,
    title: $('event-title').value, details: $('event-details').value };
  if (editingEventId) await api(`/api/events/${editingEventId}`, payload, 'PATCH');
  else await api('/api/events', payload);
  selectedEventDate = $('event-date').value;
  eventMonth = new Date(`${selectedEventDate}T12:00:00`);
  eventMonth.setDate(1);
  const wasEditing = Boolean(editingEventId);
  editingEventId = null;
  $('event-time').value = '';
  $('event-title').value = '';
  $('event-details').value = '';
  $('event-save').textContent = 'Agregar fecha';
  $('event-cancel').hidden = true;
  await Promise.all([refreshEvents(), refreshUpcomingEvents()]);
  $('event-editor-dialog').close();
  message(wasEditing ? 'Fecha actualizada.' : 'Fecha agregada al calendario.');
});
onSubmit('grade-settings-form', async () => {
  const problems = renderGradeSettingsWarnings();
  if (problems.length) throw new Error('Revisa las advertencias antes de guardar la configuración.');
  const practicalCourse = gradeCourseIsPractical();
  const evaluations = [];
  const categories = [['teorico', 'grade-theoretical-evaluations']];
  if (practicalCourse) categories.push(['practico', 'grade-practical-evaluations']);
  for (const [category, containerId] of categories) {
    [...$(containerId).querySelectorAll('.grade-evaluation-row')].forEach((row, index) => {
      const weight = parsePercentageInput(row.querySelector('.grade-evaluation-weight').value);
      if (!Number.isFinite(weight)) throw new Error('La ponderación debe estar entre 0 y 100 y usar hasta dos decimales, por ejemplo 33.33.');
      evaluations.push({
        id: row.dataset.evaluationId ? Number(row.dataset.evaluationId) : null,
        name: row.querySelector('.grade-evaluation-name').value,
        category,
        weight,
        substitutable: row.querySelector('.grade-evaluation-substitutable')?.checked || false,
        sort_order: index + 1
      });
    });
  }
  await api('/api/grade-settings', {
    subject_id: Number($('grade-subject-id').value),
    course_type: $('grade-course-type').value,
    theoretical_weight: practicalCourse ? Number($('grade-theoretical-weight').value) : 100,
    practical_weight: practicalCourse ? Number($('grade-practical-weight').value) : 0,
    exemption_enabled: $('grade-exemption-enabled').checked,
    exemption_grade: Number($('grade-exemption-grade').value),
    exemption_scope: $('grade-exemption-scope').value,
    exam_weight: Number($('grade-exam-weight').value),
    exam_scope: $('grade-exam-scope').value,
    exam_is_failing: $('grade-exam-is-failing').checked,
    evaluations
  });
  await refreshGradeSettings();
  $('grade-settings-dialog').close();
  message('Configuración de notas guardada.');
});
$('add-theoretical-evaluation').addEventListener('click', () => addGradeEvaluationRow({}, 'teorico'));
$('add-practical-evaluation').addEventListener('click', () => addGradeEvaluationRow({}, 'practico'));
$('grade-course-type').addEventListener('change', syncGradeCourseType);
$('grade-settings-form').addEventListener('input', renderGradeSettingsWarnings);
$('grade-exemption-enabled').addEventListener('change', event => {
  $('grade-exemption-options').hidden = !event.target.checked;
});
$('close-grade-settings').addEventListener('click', () => $('grade-settings-dialog').close());
$('cancel-grade-settings').addEventListener('click', () => $('grade-settings-dialog').close());
$('event-cancel').addEventListener('click', () => {
  resetEventEditorForm();
});
$('open-event-editor').addEventListener('click', () => {
  resetEventEditorForm();
  $('event-editor-dialog').showModal();
});
$('close-event-editor').addEventListener('click', () => $('event-editor-dialog').close());
$('event-editor-dialog').addEventListener('close', () => resetEventEditorForm());
$('open-class-editor').addEventListener('click', () => {
  if (!requireClassLogin()) return;
  openClassEditor();
});
$('close-class-editor').addEventListener('click', () => $('class-editor-dialog').close());
$('class-cancel').addEventListener('click', () => $('class-editor-dialog').close());
$('class-editor-dialog').addEventListener('close', () => resetClassEditor());
$('open-report-details').addEventListener('click', () => $('report-details-dialog').showModal());
$('close-report-details').addEventListener('click', () => $('report-details-dialog').close());
$('subject-abbreviation').addEventListener('input', event => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ]/g, '').slice(0, 3);
});
$('subject-filter').addEventListener('change', async event => {
  currentSubject = event.target.value === 'all' ? 'all' : Number(event.target.value);
  reportSubject = currentSubject;
  $('report-subject-filter').value = reportSubject;
  try { await Promise.all([refreshSubject(), refreshReport()]); } catch (error) { message(error.message, true); }
});
$('report-subject-filter').addEventListener('change', async event => {
  reportSubject = event.target.value === 'all' ? 'all' : Number(event.target.value);
  try { await refreshReport(); } catch (error) { message(error.message, true); }
});
$('report-student-filter').addEventListener('change', async event => {
  reportStudent = event.target.value === 'all' ? 'all' : Number(event.target.value);
  try { await refreshReport(); } catch (error) { message(error.message, true); }
});
$('add-subject').addEventListener('change', event => { addSubject = event.target.value ? Number(event.target.value) : null; });
for (const type of ['students', 'subjects']) {
  $(`export-all-${type}`).addEventListener('change', event => {
    $(`export-${type}-list`).querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.checked = event.target.checked;
    });
    updateExportCount();
  });
}
for (const id of ['export-attendance', 'export-grades']) {
  $(id).addEventListener('change', updateExportCount);
}
$('export-form').addEventListener('submit', async event => {
  event.preventDefault();
  const studentIds = exportIds('students');
  const subjectIds = exportIds('subjects');
  const sections = [];
  if ($('export-attendance').checked) sections.push('attendance');
  if ($('export-grades').checked) sections.push('grades');
  if (!studentIds.length || !subjectIds.length || !sections.length) {
    message('Selecciona al menos un tipo de información y un ramo.', true);
    return;
  }
  const button = $('export-download');
  button.disabled = true;
  button.textContent = 'Preparando Excel…';
  try {
    const response = await fetch('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_ids: studentIds, subject_ids: subjectIds, sections })
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'No se pudo generar el Excel.');
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `registro_academico_${new Date().toLocaleDateString('en-CA')}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    message('Excel descargado.');
  } catch (error) { message(error.message, true); }
  finally { button.textContent = 'Descargar .xlsx'; updateExportCount(); }
});
document.querySelectorAll('[role="tab"]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[role="tab"]').forEach(item => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      $(item.getAttribute('aria-controls')).hidden = !active;
    });
    $('profile-menu').hidden = true;
    $('profile-toggle').setAttribute('aria-expanded', 'false');
  });
});
$('profile-toggle').addEventListener('click', event => {
  event.stopPropagation();
  const opening = $('profile-menu').hidden;
  $('profile-menu').hidden = !opening;
  $('profile-toggle').setAttribute('aria-expanded', String(opening));
});
$('profile-menu').addEventListener('click', event => event.stopPropagation());
$('open-profile').addEventListener('click', () => {
  $('profile-menu').hidden = true;
  $('profile-toggle').setAttribute('aria-expanded', 'false');
  renderProfileSummary();
  $('profile-save-message').hidden = true;
  $('profile-dialog').showModal();
});
$('open-settings').addEventListener('click', () => {
  $('profile-menu').hidden = true;
  $('profile-toggle').setAttribute('aria-expanded', 'false');
  renderThemeKits();
  $('settings-dialog').showModal();
  refreshNotificationStatus();
});
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('notification-toggle').addEventListener('click', toggleNotifications);
$('notification-preferences-form').addEventListener('submit', saveNotificationPreferences);
$('close-profile').addEventListener('click', () => $('profile-dialog').close());
$('profile-tagline').addEventListener('input', updateProfileTaglineCount);
$('profile-photo').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    await openAvatarCrop(file);
  } catch (error) { message(error.message, true); }
  event.target.value = '';
});
const avatarCanvas = $('avatar-crop-canvas');
avatarCanvas.addEventListener('pointerdown', event => {
  if (!avatarCropState) return;
  avatarCropState.dragging = true;
  avatarCropState.pointerX = event.clientX;
  avatarCropState.pointerY = event.clientY;
  avatarCanvas.setPointerCapture(event.pointerId);
});
avatarCanvas.addEventListener('pointermove', event => {
  if (!avatarCropState?.dragging) return;
  const rect = avatarCanvas.getBoundingClientRect();
  const ratio = avatarCanvas.width / rect.width;
  avatarCropState.offsetX += (event.clientX - avatarCropState.pointerX) * ratio;
  avatarCropState.offsetY += (event.clientY - avatarCropState.pointerY) * ratio;
  avatarCropState.pointerX = event.clientX;
  avatarCropState.pointerY = event.clientY;
  renderAvatarCrop();
});
const stopAvatarDrag = () => { if (avatarCropState) avatarCropState.dragging = false; };
avatarCanvas.addEventListener('pointerup', stopAvatarDrag);
avatarCanvas.addEventListener('pointercancel', stopAvatarDrag);
$('avatar-crop-zoom').addEventListener('input', event => {
  if (!avatarCropState) return;
  avatarCropState.zoom = Number(event.target.value);
  renderAvatarCrop();
});
function closeAvatarCrop() {
  avatarCropState = null;
  $('avatar-crop-dialog').close();
}
$('close-avatar-crop').addEventListener('click', closeAvatarCrop);
$('cancel-avatar-crop').addEventListener('click', closeAvatarCrop);
$('avatar-crop-dialog').addEventListener('close', () => { avatarCropState = null; });
$('apply-avatar-crop').addEventListener('click', () => {
  if (!avatarCropState) return;
  let data = avatarCanvas.toDataURL('image/jpeg', .78);
  if (data.length > 100000) data = avatarCanvas.toDataURL('image/jpeg', .6);
  if (data.length > 100000) {
    message('La imagen sigue siendo demasiado grande. Prueba con otra foto.', true);
    return;
  }
  pendingProfileAvatar = data;
  renderProfileAvatar();
  closeAvatarCrop();
});
$('profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('profile-save');
  button.disabled = true;
  try {
    const result = await api('/api/profile', {
      name: $('profile-name').value, tagline: $('profile-tagline').value,
      avatar_data: pendingProfileAvatar
    }, 'PATCH');
    studentState = { ...studentState, ...result, authenticated: true };
    await loadOverview();
    renderProfileSummary();
    profileSaveMessage('Perfil actualizado.');
  } catch (error) { profileSaveMessage(error.message, true); }
  finally { button.disabled = false; }
});
document.addEventListener('click', () => {
  $('profile-menu').hidden = true;
  $('profile-toggle').setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.class-menu').forEach(menu => { menu.hidden = true; });
});
$('student-button').addEventListener('click', () => {
  $('profile-menu').hidden = true;
  $('profile-toggle').setAttribute('aria-expanded', 'false');
});
$('admin-button').addEventListener('click', () => {
  $('profile-menu').hidden = true;
  $('profile-toggle').setAttribute('aria-expanded', 'false');
});
$('close-dialog').addEventListener('click', () => $('attendance-dialog').close());
$('done-dialog').addEventListener('click', () => $('attendance-dialog').close());
$('admin-button').addEventListener('click', async () => {
  if (!adminState.authenticated) {
    if (!adminState.configured && adminState.public_mode) {
      message('Configura la cuenta desde Render Shell con python server.py --setup-admin.', true);
      return;
    }
    openAdminDialog();
    return;
  }
  try {
    await api('/api/admin/logout', {});
    await loadAdminStatus();
    showHeaderGreeting(null);
    message('Sesión de administrador cerrada.');
  } catch (error) { message(error.message, true); }
});
$('close-admin-dialog').addEventListener('click', () => $('admin-dialog').close());
$('student-button').addEventListener('click', async () => {
  if (!studentState.authenticated) { await openStudentDialog(); return; }
  try {
    await api('/api/student/logout', {});
    await loadStudentStatus();
    showHeaderGreeting(null);
    message('Sesión de estudiante cerrada.');
  } catch (error) { message(error.message, true); }
});
$('close-student-dialog').addEventListener('click', () => $('student-dialog').close());
$('intro-first-time').addEventListener('click', () => openStudentDialog(true));
$('intro-admin-login').addEventListener('click', openAdminDialog);
$('intro-guest').addEventListener('click', () => {
  dismissAppIntro();
  showHeaderGreeting(null);
});
$('close-activation-dialog').addEventListener('click', () => $('activation-dialog').close());
$('activation-dialog').addEventListener('close', () => { $('activation-code').textContent = ''; });
$('copy-activation-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('activation-code').textContent);
    message('Código copiado.');
  } catch (error) { message('No se pudo copiar. Selecciona el código y cópialo manualmente.', true); }
});
$('student-login-mode').addEventListener('click', () => setStudentMode(false));
$('student-login-password').addEventListener('input', () => studentDialogMessage());
$('student-activation-code').addEventListener('input', () => studentDialogMessage());
$('student-first-mode').addEventListener('click', async () => {
  try {
    availableStudentChoices = await api('/api/student/available');
    renderStudentChoiceList('student-register-list', 'student-register-name', availableStudentChoices);
    setStudentMode(true);
  } catch (error) { studentDialogMessage(error.message); }
});
$('student-code-form').addEventListener('submit', async event => {
  event.preventDefault();
  const studentId = Number($('student-register-name').value);
  if (!studentId) { studentDialogMessage('Selecciona tu perfil.'); return; }
  const code = $('student-activation-code').value.trim().toUpperCase();
  try {
    await api('/api/student/activation-check', { student_id: studentId, activation_code: code });
    studentActivation = { student_id: studentId, activation_code: code };
    $('student-code-form').hidden = true;
    $('student-register-form').hidden = false;
    $('student-dialog-info').textContent = 'Código aceptado. Ahora crea tu contraseña.';
    $('student-register-password').focus();
  } catch (error) { studentDialogMessage(error.message); }
});
$('student-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const studentId = Number($('student-login-name').value);
  if (!studentId) { studentDialogMessage('Selecciona tu perfil.'); return; }
  try {
    await api('/api/student/login', {
      student_id: studentId,
      password: $('student-login-password').value
    });
    $('student-login-password').value = '';
    $('student-dialog').close();
    await loadStudentStatus();
    dismissAppIntro();
    showHeaderGreeting(studentState.name);
  } catch (error) { studentDialogMessage(error.message); }
});
$('student-register-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('student-register-password').value;
  if (password.length < 6 || !/[A-ZÁÉÍÓÚÑ]/.test(password) || !/[0-9]/.test(password)) {
    studentDialogMessage('Usa al menos 6 caracteres, una mayúscula y un número.');
    return;
  }
  if (password !== $('student-register-confirm').value) {
    studentDialogMessage('Las contraseñas no coinciden.');
    return;
  }
  try {
    await api('/api/student/register', {
      ...studentActivation, password, confirm_password: $('student-register-confirm').value
    });
    $('student-register-password').value = '';
    $('student-register-confirm').value = '';
    $('student-activation-code').value = '';
    studentActivation = null;
    $('student-dialog').close();
    await loadStudentStatus();
    dismissAppIntro();
    showHeaderGreeting(studentState.name);
    message(`Cuenta creada para ${studentState.name}.`);
  } catch (error) { studentDialogMessage(error.message); }
});
$('admin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('admin-password').value;
  const setup = !adminState.configured;
  if (setup && (password.length < 6 || !/[A-ZÁÉÍÓÚÑ]/.test(password) || !/[0-9]/.test(password))) {
    message('Usa al menos 6 caracteres, una mayúscula y un número.', true);
    return;
  }
  if (setup && password !== $('admin-confirm').value) {
    message('Las contraseñas no coinciden.', true);
    return;
  }
  const button = $('admin-submit');
  button.disabled = true;
  try {
    await api(setup ? '/api/admin/setup' : '/api/admin/login', { password });
    $('admin-password').value = '';
    $('admin-confirm').value = '';
    $('admin-dialog').close();
    await loadAdminStatus();
    dismissAppIntro();
    showHeaderGreeting('Administrador');
    if (setup) message('Administrador configurado.');
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});
for (const [id, direction] of [['event-prev', -1], ['event-next', 1]]) {
  $(id).addEventListener('click', async () => {
    eventMonth.setMonth(eventMonth.getMonth() + direction);
    selectedEventDate = null;
    try { await refreshEvents(); } catch (error) { message(error.message, true); }
  });
}
$('class-date').value = new Date().toLocaleDateString('en-CA');
$('event-date').value = new Date().toLocaleDateString('en-CA');

let installPrompt = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  $('install-app').hidden = false;
});
$('install-app').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('install-app').hidden = true;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('install-app').hidden = true;
  message('Aplicación instalada correctamente.');
});
window.addEventListener('offline', () => message('Sin conexión: puedes ver la interfaz, pero no consultar ni guardar datos.', true));
window.addEventListener('online', () => message('Conexión recuperada. Actualizando información...'));
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js')
    .catch(() => console.warn('No se pudo activar el modo instalable.')));
}

applyThemeKit(activeThemeKit, false);
setupNativePushActions().catch(() => {});
Promise.all([loadAdminStatus(), loadStudentStatus()])
  .then(async () => {
    const greetingName = studentState.authenticated ? studentState.name
      : adminState.authenticated ? 'Administrador' : null;
    showHeaderGreeting(greetingName, 650);
    if (studentState.authenticated || adminState.authenticated) {
      const remainingIntro = Math.max(0, 800 - (performance.now() - introStartedAt));
      setTimeout(() => dismissAppIntro(true), remainingIntro);
    }
    await loadOverview();
    if (!studentState.authenticated && !adminState.authenticated) await showIntroAccess();
  })
  .catch(error => message(error.message, true));
