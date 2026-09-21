const $ = (id) => document.getElementById(id);
let overview = { students: [], subjects: [] };
let currentSubject = 'all';
let reportSubject = 'all';
let reportStudent = 'all';
let addSubject = null;
let editorFilter = 'all';
let calendarMonth = new Date();
calendarMonth.setDate(1);
let calendarStudent = null;
let calendarClasses = [];
let selectedCalendarDate = null;
let eventMonth = new Date();
eventMonth.setDate(1);
let eventSubject = 'all';
let calendarEvents = [];
let selectedEventDate = null;
let editingEventId = null;
let adminState = { configured: false, authenticated: false };
let studentState = { authenticated: false, student_id: null, name: null };
let studentActivation = null;

async function api(path, body, method = 'POST') {
  const response = await fetch(path, body === undefined && method === 'POST' ? undefined : {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
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

async function loadOverview() {
  overview = await api('/api/overview');
  renderStudents();
  renderSubjects();
  renderExportChoices();
  if (!overview.students.some(s => s.id === Number(calendarStudent))) calendarStudent = null;
  fillSelect('calendar-student', overview.students, 'Todos los estudiantes', calendarStudent);
  if (reportStudent !== 'all' && !overview.students.some(s => s.id === Number(reportStudent))) reportStudent = 'all';
  fillSelect('report-student-filter', overview.students, 'Todos los estudiantes', reportStudent, 'all');
  if (currentSubject !== 'all' && !overview.subjects.some(s => s.id === Number(currentSubject))) currentSubject = 'all';
  if (reportSubject !== 'all' && !overview.subjects.some(s => s.id === Number(reportSubject))) reportSubject = 'all';
  if (editorFilter !== 'all' && !overview.subjects.some(s => s.id === Number(editorFilter))) editorFilter = 'all';
  if (!overview.subjects.some(s => s.id === Number(addSubject))) addSubject = overview.subjects[0]?.id || null;
  fillSelect('subject-filter', overview.subjects, 'Todos los ramos', currentSubject, 'all');
  fillSelect('report-subject-filter', overview.subjects, 'Todos los ramos', reportSubject, 'all');
  fillSelect('editor-filter', overview.subjects, 'Todos los ramos', editorFilter, 'all');
  fillSelect('add-subject', overview.subjects, 'Selecciona un ramo', addSubject);
  if (eventSubject !== 'all' && !overview.subjects.some(s => s.id === Number(eventSubject))) eventSubject = 'all';
  fillSelect('event-subject-filter', overview.subjects, 'Todos los ramos', eventSubject, 'all');
  fillSelect('event-subject', overview.subjects, 'Selecciona un ramo', overview.subjects[0]?.id || '');
  await refreshSubject();
  await refreshReport();
  await refreshEditor();
  await refreshCalendar();
  await refreshEvents();
}

async function loadAdminStatus() {
  adminState = await api('/api/admin/status');
  $('tab-setup').hidden = !adminState.authenticated;
  $('event-form').hidden = !adminState.authenticated;
  $('event-admin-hint').hidden = adminState.authenticated;
  renderEventDetail();
  renderCalendarDetail();
  document.querySelector('.tabs').classList.toggle('with-admin', adminState.authenticated);
  $('admin-button').textContent = adminState.authenticated ? 'Cerrar sesión'
    : adminState.configured ? 'Ingresar como administrador'
      : adminState.public_mode ? 'Configurar administrador en servidor' : 'Configurar administrador';
  if (!adminState.authenticated && !$('panel-setup').hidden) $('tab-classes').click();
  if (!adminState.configured && !adminState.public_mode) openAdminDialog();
  if (overview.students.length || overview.subjects.length) await refreshSubject();
}

async function loadStudentStatus() {
  studentState = await api('/api/student/status');
  $('student-button').textContent = studentState.authenticated
    ? `Cerrar sesión de ${studentState.name}` : 'Ingresar como estudiante';
  if (studentState.authenticated) {
    calendarStudent = studentState.student_id;
    reportStudent = studentState.student_id;
    if (overview.students.some(student => student.id === calendarStudent)) {
      $('calendar-student').value = String(calendarStudent);
      $('report-student-filter').value = String(reportStudent);
      await refreshCalendar();
      await refreshReport();
    }
  }
  renderCalendarDetail();
  if (overview.students.length || overview.subjects.length) await refreshSubject();
}

async function openStudentDialog(firstTime = false) {
  try {
    const available = await api('/api/student/available');
    fillSelect('student-register-name', available, 'Selecciona tu nombre');
    fillSelect('student-login-name', overview.students, 'Selecciona tu nombre');
    setStudentMode(firstTime);
    if (!$('student-dialog').open) $('student-dialog').showModal();
  } catch (error) { message(error.message, true); }
}

function setStudentMode(firstTime) {
  studentActivation = null;
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
    const identity = element('div', 'subject-identity');
    const marker = element('i', 'subject-color-dot');
    marker.style.backgroundColor = subject.color;
    identity.append(marker, name);
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
      const save = element('button', '', 'Guardar');
      save.type = 'submit';
      const cancel = element('button', 'secondary-button', 'Cancelar');
      cancel.type = 'button';
      cancel.addEventListener('click', () => renderSubjects());
      form.addEventListener('submit', async event => {
        event.preventDefault();
        save.disabled = true;
        try {
          await api(`/api/subjects/${subject.id}`, { name: input.value, color: color.value }, 'PATCH');
          await loadOverview();
          message('Ramo actualizado.');
        } catch (error) { message(error.message, true); save.disabled = false; }
      });
      form.append(input, color, save, cancel);
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
  for (const [type, entries] of [['students', overview.students], ['subjects', overview.subjects]]) {
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
  updateExportCount();
}

function exportIds(type) {
  return [...$(`export-${type}-list`).querySelectorAll('input:checked')].map(input => Number(input.value));
}

function updateExportCount() {
  const students = exportIds('students').length;
  const subjects = exportIds('subjects').length;
  $('export-count').textContent = `${students} estudiante${students === 1 ? '' : 's'} · ${subjects} ramo${subjects === 1 ? '' : 's'}`;
  $('export-download').disabled = students === 0 || subjects === 0;
}

async function refreshSubject() {
  const subject = currentSubject;
  const canAdd = overview.subjects.length > 0;
  $('session-form').querySelectorAll('input, select, button').forEach(node => node.disabled = !canAdd);
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
  const report = await api(`/api/report?subject_id=${subject}&student_id=${student}`);
  if (subject !== reportSubject || student !== reportStudent) return;
  renderReport(report);
}

async function refreshEditor() {
  const filter = editorFilter;
  const sessions = await api(`/api/sessions?subject_id=${filter}`);
  if (filter !== editorFilter) return;
  renderEditor(sessions);
}

function renderEditor(sessions) {
  const list = $('editor-list');
  list.replaceChildren();
  if (!sessions.length) { list.append(element('div', 'empty', 'Aún no hay clases registradas.')); return; }
  sessions.forEach(session => {
    const row = element('div', 'editor-row');
    const summary = element('div', 'editor-summary');
    const detail = element('div');
    detail.append(element('strong', '', `${readableDate(session.class_date)} · ${session.subject_name} · ${classLabel(session)}`),
      element('small', '', session.title || 'Clase sin tema indicado'));
    const actions = element('div', 'editor-actions');
    const edit = element('button', 'secondary-button', 'Editar');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      if (!requireClassLogin()) return;
      row.replaceChildren();
      const form = element('form', 'editor-form');
      const dateLabel = element('label', '', 'Fecha');
      const dateInput = element('input');
      dateInput.type = 'date';
      dateInput.required = true;
      dateInput.value = session.class_date;
      dateLabel.append(dateInput);
      const subjectLabel = element('label', '', 'Ramo');
      const subjectSelect = element('select');
      overview.subjects.forEach(subject => option(subjectSelect, subject.id, subject.name));
      subjectSelect.value = String(session.subject_id);
      subjectLabel.append(subjectSelect);
      const titleLabel = element('label', '', 'Tema');
      const titleInput = element('input');
      titleInput.value = session.title;
      titleInput.maxLength = 120;
      titleLabel.append(titleInput);
      const formActions = element('div', 'editor-actions');
      const save = element('button', '', 'Guardar');
      save.type = 'submit';
      const cancel = element('button', 'secondary-button', 'Cancelar');
      cancel.type = 'button';
      cancel.addEventListener('click', () => renderEditor(sessions));
      formActions.append(save, cancel);
      form.append(dateLabel, subjectLabel, titleLabel, formActions);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        save.disabled = true;
        try {
          await api(`/api/sessions/${session.id}`, {
            subject_id: Number(subjectSelect.value), class_date: dateInput.value, title: titleInput.value
          }, 'PATCH');
          await Promise.all([refreshSubject(), refreshReport(), refreshEditor(), refreshCalendar()]);
          message('Clase actualizada.');
        } catch (error) { message(error.message, true); save.disabled = false; }
      });
      row.append(form);
      dateInput.focus();
    });
    const remove = element('button', 'danger-button', 'Eliminar');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!requireClassLogin()) return;
      if (!confirm(`¿Eliminar la clase del ${readableDate(session.class_date)} de ${session.subject_name}? También se borrará su asistencia.`)) return;
      try {
        await api(`/api/sessions/${session.id}`, undefined, 'DELETE');
        await Promise.all([refreshSubject(), refreshReport(), refreshEditor(), refreshCalendar()]);
        message('Clase eliminada.');
      } catch (error) { message(error.message, true); }
    });
    actions.append(edit, remove);
    summary.append(detail, actions);
    row.append(summary);
    list.append(row);
  });
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
    const count = session.viewer_status
      ? element('span', `pill status-${session.viewer_status}`, personalStatus[session.viewer_status])
      : element('span', session.absent ? 'pill warn' : 'pill',
        `${session.present} presentes · ${session.absent} ausentes${session.justified ? ` · ${session.justified} justificadas` : ''}`);
    const button = element('button', '', 'Marcar asistencia');
    button.type = 'button';
    button.addEventListener('click', () => openAttendance(session.id));
    meta.append(count, button);
    row.append(detail, meta);
    list.append(row);
  });
}

function renderReport(report) {
  const list = $('report-list');
  list.replaceChildren();
  $('report-empty').hidden = report.length > 0;
  if (!report.length) $('report-empty').textContent = 'Agrega estudiantes para ver sus inasistencias.';
  report.forEach(student => {
    const card = element('div', 'report-card');
    const top = element('div', 'report-top');
    top.append(element('strong', '', student.name),
      element('span', student.absent ? 'pill warn' : 'pill', `${student.absent} inasistencia${student.absent === 1 ? '' : 's'}`));
    card.append(top);
    const stats = element('div', 'stats');
    [[`Clases: ${student.total_classes}`, 'stat'], [`Presentes: ${student.present}`, 'stat'],
      [`Ausentes: ${student.absent}`, 'stat absent'], [`Justificadas: ${student.justified}`, 'stat']]
      .forEach(([text, cls]) => stats.append(element('span', cls, text)));
    card.append(stats);
    card.append(element('div', 'attendance-percent',
      `Asistencia: ${student.attendance_percent === null ? '—' : `${student.attendance_percent.toLocaleString('es-CL')}%`}`));
    if (student.absence_days.length) {
      const days = element('ul', 'absence-days');
      student.absence_days.forEach(day => days.append(element('li', '',
        `${readableDate(day.class_date)} · ${day.subject_name} · ${classLabel(day)}${day.title ? ` · ${day.title}` : ''}`)));
      card.append(days);
    }
    list.append(card);
  });
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
          await refreshEditor();
          await refreshCalendar();
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

function monthKey() {
  return `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}`;
}

async function refreshCalendar() {
  const month = monthKey();
  const student = calendarStudent;
  const query = `/api/calendar?month=${month}${student ? `&student_id=${student}` : ''}`;
  const classes = await api(query);
  if (month !== monthKey() || student !== calendarStudent) return;
  calendarClasses = classes;
  $('calendar-month').textContent = calendarMonth.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  renderCalendar();
}

function renderCalendar() {
  const grid = $('calendar-grid');
  grid.replaceChildren();
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) grid.append(element('div', 'calendar-spacer'));
  for (let day = 1; day <= days; day++) {
    const iso = `${monthKey()}-${String(day).padStart(2, '0')}`;
    const entries = calendarClasses.filter(item => item.class_date === iso);
    const absent = calendarStudent && entries.some(item => item.status === 'ausente');
    const button = element('button', `calendar-day${entries.length ? ' has-class' : ''}${absent ? ' has-absence' : ''}${selectedCalendarDate === iso ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-label', `${readableDate(iso)}: ${entries.length} clase${entries.length === 1 ? '' : 's'}${absent ? ', con falta' : ''}`);
    button.append(element('span', 'day-number', day));
    if (entries.length) button.append(element('span', 'day-count', `${entries.length} clase${entries.length === 1 ? '' : 's'}`));
    button.addEventListener('click', () => { selectedCalendarDate = iso; renderCalendar(); });
    grid.append(button);
  }
  renderCalendarDetail();
}

function renderCalendarDetail() {
  const detail = $('calendar-detail');
  detail.replaceChildren();
  if (!selectedCalendarDate || !selectedCalendarDate.startsWith(monthKey())) {
    detail.textContent = 'Selecciona un día para ver sus clases.';
    return;
  }
  const entries = calendarClasses.filter(item => item.class_date === selectedCalendarDate);
  detail.append(element('strong', '', readableDate(selectedCalendarDate)));
  if (!entries.length) { detail.append(element('p', '', 'No hay clases registradas este día.')); return; }
  const list = element('div', 'calendar-class-list');
  entries.forEach(item => {
    const row = element('div', 'calendar-class-item');
    const line = element('span', item.status === 'ausente' ? 'red-text' : '',
      `${item.subject_name} · ${classLabel(item)}${item.title ? ` · ${item.title}` : ''}${item.status === 'ausente' ? ' · Falta' : ''}`);
    const button = element('button', 'secondary-button', adminState.authenticated
      ? 'Gestionar asistencia' : studentState.authenticated ? 'Marcar mi asistencia' : 'Marcar asistencia');
    button.type = 'button';
    button.addEventListener('click', () => openAttendance(item.id));
    row.append(line, button);
    list.append(row);
  });
  detail.append(list);
}

function eventMonthKey() {
  return `${eventMonth.getFullYear()}-${String(eventMonth.getMonth() + 1).padStart(2, '0')}`;
}

async function refreshEvents() {
  const month = eventMonthKey();
  const subject = eventSubject;
  const events = await api(`/api/events?month=${month}&subject_id=${subject}`);
  if (month !== eventMonthKey() || subject !== eventSubject) return;
  calendarEvents = events;
  $('event-month').textContent = eventMonth.toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  renderEventCalendar();
}

function renderEventCalendar() {
  const grid = $('event-grid');
  grid.replaceChildren();
  const year = eventMonth.getFullYear();
  const month = eventMonth.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) grid.append(element('div', 'calendar-spacer'));
  for (let day = 1; day <= days; day++) {
    const iso = `${eventMonthKey()}-${String(day).padStart(2, '0')}`;
    const entries = calendarEvents.filter(item => item.event_date === iso);
    const subjects = [...new Map(entries.map(item => [item.subject_id, {
      name: item.subject_name,
      color: item.color
    }])).values()];
    const button = element('button', `calendar-day${entries.length ? ' has-event' : ''}${selectedEventDate === iso ? ' selected' : ''}`);
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
      subjects.forEach(subject => names.append(element('span', 'event-subject-name', subject.name)));
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

function renderEventDetail() {
  const detail = $('event-detail');
  detail.replaceChildren();
  if (!selectedEventDate || !selectedEventDate.startsWith(eventMonthKey())) {
    detail.textContent = 'Selecciona un día para ver sus eventos.';
    return;
  }
  const entries = calendarEvents.filter(item => item.event_date === selectedEventDate);
  detail.append(element('strong', '', readableDate(selectedEventDate)));
  if (!entries.length) { detail.append(element('p', '', 'No hay fechas calendarizadas este día.')); return; }
  const list = element('div', 'event-list');
  entries.forEach(item => {
    const row = element('div', 'event-item');
    row.style.borderLeftColor = item.color;
    const text = element('div');
    const heading = element('strong', 'event-heading');
    const color = element('i', 'event-color-dot');
    color.style.backgroundColor = item.color;
    heading.append(color, document.createTextNode(`${item.event_type} · ${item.subject_name}`));
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
        $('event-type').value = item.event_type;
        $('event-title').value = item.title;
        $('event-details').value = item.details;
        $('event-save').textContent = 'Guardar cambios';
        $('event-cancel').hidden = false;
        $('event-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
        $('event-title').focus();
      });
      const remove = element('button', 'danger-button', 'Eliminar');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!confirm(`¿Eliminar “${item.title}”?`)) return;
        try {
          await api(`/api/events/${item.id}`, undefined, 'DELETE');
          await refreshEvents();
          message('Fecha eliminada.');
        } catch (error) { message(error.message, true); }
      });
      actions.append(edit, remove);
      row.append(actions);
    }
    list.append(row);
  });
  detail.append(list);
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
  const subject = await api('/api/subjects', { name: $('subject-name').value, color: $('subject-color').value });
  $('subject-name').value = '';
  addSubject = subject.id;
  await loadOverview();
  message('Ramo agregado.');
});
onSubmit('session-form', async () => {
  if (!requireClassLogin()) return;
  await api('/api/sessions', { subject_id: Number($('add-subject').value), class_date: $('class-date').value, title: $('class-title').value });
  $('class-title').value = '';
  await refreshSubject();
  await refreshReport();
  await refreshEditor();
  await refreshCalendar();
  message('Clase agregada.');
});
onSubmit('event-form', async () => {
  const payload = { subject_id: Number($('event-subject').value), event_date: $('event-date').value,
    event_type: $('event-type').value,
    title: $('event-title').value, details: $('event-details').value };
  if (editingEventId) await api(`/api/events/${editingEventId}`, payload, 'PATCH');
  else await api('/api/events', payload);
  selectedEventDate = $('event-date').value;
  eventMonth = new Date(`${selectedEventDate}T12:00:00`);
  eventMonth.setDate(1);
  const wasEditing = Boolean(editingEventId);
  editingEventId = null;
  $('event-title').value = '';
  $('event-details').value = '';
  $('event-save').textContent = 'Agregar fecha';
  $('event-cancel').hidden = true;
  await refreshEvents();
  message(wasEditing ? 'Fecha actualizada.' : 'Fecha agregada al calendario.');
});
$('event-cancel').addEventListener('click', () => {
  editingEventId = null;
  $('event-title').value = '';
  $('event-details').value = '';
  $('event-type').value = 'Prueba';
  $('event-save').textContent = 'Agregar fecha';
  $('event-cancel').hidden = true;
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
$('editor-filter').addEventListener('change', async event => {
  editorFilter = event.target.value === 'all' ? 'all' : Number(event.target.value);
  try { await refreshEditor(); } catch (error) { message(error.message, true); }
});
$('event-subject-filter').addEventListener('change', async event => {
  eventSubject = event.target.value === 'all' ? 'all' : Number(event.target.value);
  try { await refreshEvents(); } catch (error) { message(error.message, true); }
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
$('export-form').addEventListener('submit', async event => {
  event.preventDefault();
  const studentIds = exportIds('students');
  const subjectIds = exportIds('subjects');
  if (!studentIds.length || !subjectIds.length) {
    message('Selecciona al menos un estudiante y un ramo.', true);
    return;
  }
  const button = $('export-download');
  button.disabled = true;
  button.textContent = 'Preparando Excel…';
  try {
    const response = await fetch('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_ids: studentIds, subject_ids: subjectIds })
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'No se pudo generar el Excel.');
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `asistencia_${new Date().toLocaleDateString('en-CA')}.xlsx`;
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
  });
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
    message('Sesión de administrador cerrada.');
  } catch (error) { message(error.message, true); }
});
$('close-admin-dialog').addEventListener('click', () => $('admin-dialog').close());
$('student-button').addEventListener('click', async () => {
  if (!studentState.authenticated) { await openStudentDialog(); return; }
  try {
    await api('/api/student/logout', {});
    await loadStudentStatus();
    message('Sesión de estudiante cerrada.');
  } catch (error) { message(error.message, true); }
});
$('close-student-dialog').addEventListener('click', () => $('student-dialog').close());
$('close-activation-dialog').addEventListener('click', () => $('activation-dialog').close());
$('activation-dialog').addEventListener('close', () => { $('activation-code').textContent = ''; });
$('copy-activation-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('activation-code').textContent);
    message('Código copiado.');
  } catch (error) { message('No se pudo copiar. Selecciona el código y cópialo manualmente.', true); }
});
$('student-login-mode').addEventListener('click', () => setStudentMode(false));
$('student-first-mode').addEventListener('click', async () => {
  try {
    const available = await api('/api/student/available');
    fillSelect('student-register-name', available, 'Selecciona tu nombre');
    setStudentMode(true);
  } catch (error) { message(error.message, true); }
});
$('student-code-form').addEventListener('submit', async event => {
  event.preventDefault();
  const studentId = Number($('student-register-name').value);
  const code = $('student-activation-code').value.trim().toUpperCase();
  try {
    await api('/api/student/activation-check', { student_id: studentId, activation_code: code });
    studentActivation = { student_id: studentId, activation_code: code };
    $('student-code-form').hidden = true;
    $('student-register-form').hidden = false;
    $('student-dialog-info').textContent = 'Código aceptado. Ahora crea tu contraseña.';
    $('student-register-password').focus();
  } catch (error) { message(error.message, true); }
});
$('student-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/student/login', {
      student_id: Number($('student-login-name').value),
      password: $('student-login-password').value
    });
    $('student-login-password').value = '';
    $('student-dialog').close();
    await loadStudentStatus();
    message(`Bienvenido, ${studentState.name}.`);
  } catch (error) { message(error.message, true); }
});
$('student-register-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('student-register-password').value;
  if (password.length < 6 || !/[A-ZÁÉÍÓÚÑ]/.test(password) || !/[0-9]/.test(password)) {
    message('Usa al menos 6 caracteres, una mayúscula y un número.', true);
    return;
  }
  if (password !== $('student-register-confirm').value) {
    message('Las contraseñas no coinciden.', true);
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
    message(`Cuenta creada para ${studentState.name}.`);
  } catch (error) { message(error.message, true); }
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
    $('tab-setup').click();
    message(setup ? 'Administrador configurado.' : 'Sesión de administrador iniciada.');
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});
$('calendar-student').addEventListener('change', async event => {
  calendarStudent = event.target.value ? Number(event.target.value) : null;
  try { await refreshCalendar(); } catch (error) { message(error.message, true); }
});
for (const [id, direction] of [['calendar-prev', -1], ['calendar-next', 1]]) {
  $(id).addEventListener('click', async () => {
    calendarMonth.setMonth(calendarMonth.getMonth() + direction);
    selectedCalendarDate = null;
    try { await refreshCalendar(); } catch (error) { message(error.message, true); }
  });
}
for (const [id, direction] of [['event-prev', -1], ['event-next', 1]]) {
  $(id).addEventListener('click', async () => {
    eventMonth.setMonth(eventMonth.getMonth() + direction);
    selectedEventDate = null;
    try { await refreshEvents(); } catch (error) { message(error.message, true); }
  });
}
$('class-date').value = new Date().toLocaleDateString('en-CA');
$('event-date').value = new Date().toLocaleDateString('en-CA');
Promise.all([loadAdminStatus(), loadStudentStatus()])
  .then(loadOverview)
  .catch(error => message(error.message, true));
