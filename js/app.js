/* js/app.js — Полный файл
   Включает:
   - Вся логика CRM (пользователи, статусы, клиенты, комментарии, активити, CSV import/export)
   - Модальные окна для клиента и пользователя
   - Статистика с подробной разбивкой по пользователям
   - Улучшенная карточка клиента (role-aware)
   - Theme toggle (сохранение crm_theme в localStorage)
   - Защита от создания пустых временных клиентов (temp client сохраняется только при явном сохранении)
   - Ничего лишнего — только изменения, которые вы просили.
*/

/* ---------- Utilities & Storage helpers ---------- */
const uid = (prefix='id') => prefix + '_' + Math.random().toString(36).slice(2,9);
const now = ()=> new Date().toISOString();
const lsGet = (k, fallback)=> JSON.parse(localStorage.getItem(k) || JSON.stringify(fallback));
const lsSet = (k,v)=> localStorage.setItem(k, JSON.stringify(v));

/* ---------- Theme handling ---------- */
function getSavedTheme(){ return localStorage.getItem('crm_theme') || null; }
function setTheme(theme){
  if(!theme) return;
  document.body.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggle');
  if(btn){
    btn.textContent = theme === 'light' ? '☀️' : '🌙';
  }
  localStorage.setItem('crm_theme', theme);
}
function toggleTheme(){
  const current = document.body.getAttribute('data-theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme:light)').matches ? 'light' : 'dark');
  const next = current === 'light' ? 'dark' : 'light';
  setTheme(next);
}
function initTheme(){
  const saved = getSavedTheme();
  if(saved){ setTheme(saved); return; }
  setTheme('dark');
}

/* ---------- Initial demo data (run once) ---------- */
function ensureDemoData(){
  if(!localStorage.getItem('crm_initialized')){
    // users
    const users = [
      {id: uid('u'), name: 'Admin', email: 'admin@crm.local', password: 'admin', role: 'admin'},
      {id: uid('u'), name: 'SalesUser', email: 'user@crm.local', password: 'user', role: 'user'},
      {id: uid('u'), name: 'Affiliator', email: 'aff@crm.local', password: 'aff', role: 'affiliator'},
    ];
    lsSet('crm_users', users);

    // statuses
    const statuses = [
      {id: uid('s'), name: 'Новый', color:'#3b82f6'},
      {id: uid('s'), name: 'В работе', color:'#f59e0b'},
      {id: uid('s'), name: 'CallBack', color:'#10b981'},
      {id: uid('s'), name: 'No Potential', color:'#ef4444'},
    ];
    lsSet('crm_statuses', statuses);

    // clients example
    const clients = [
      {
        id: uid('c'),
        firstName:'Иван', lastName:'Петров',
        statusId: statuses[0].id,
        email:'ivan.petrov@example.com', phone:'+373600001', source:'Форма сайта',
        card:'**** **** **** 1234', amount:'1200', loss:'0', regDate:'2025-09-01', birthDate:'1990-05-12',
        base:'Основная', lossCompany:'', description:'Интересуется пакетом Pro', assignedTo: null,
        createdBy: users[2].id, createdAt: now(), comments:[], log: [{at: now(), text:'Создан пользователем Affiliator'}]
      },
      {
        id: uid('c'),
        firstName:'Ольга', lastName:'Смирнова',
        statusId: statuses[1].id,
        email:'olga.s@example.com', phone:'+373600002', source:'Колл-центр',
        card:'', amount:'500', loss:'0', regDate:'2025-07-22', birthDate:'1985-02-01',
        base:'Вторая', lossCompany:'', description:'Просила обратный звонок', assignedTo: users[1].id,
        createdBy: users[2].id, createdAt: now(), comments:[], log: [{at: now(), text:'Создан и назначен на SalesUser'}]
      }
    ];
    lsSet('crm_clients', clients);

    lsSet('crm_activity', [{at: now(), text: 'Система: Инициализирована демонстрационная база'}]);

    localStorage.setItem('crm_initialized', '1');
  }
}
ensureDemoData();

/* ---------- State ---------- */
let state = {
  currentUser: null,
  view: 'leads',
  search: '',
  selectedClient: null,
  tempClient: null,
  editingUserId: null
};

/* ---------- Storage APIs ---------- */
const Users = {
  all: ()=> lsGet('crm_users', []),
  saveAll: (arr)=> lsSet('crm_users', arr),
  byId: (id)=> Users.all().find(u=>u.id===id),
  create: (user)=>{ const arr = Users.all(); arr.push(user); Users.saveAll(arr); Activity.log(`Админ создал пользователя ${user.name} (${user.role})`); },
  findByEmail: (email)=> Users.all().find(u=>u.email.toLowerCase()===email.toLowerCase())
};

const Statuses = {
  all: ()=> lsGet('crm_statuses', []),
  saveAll: (arr)=> lsSet('crm_statuses', arr),
  byId: (id)=> Statuses.all().find(s=>s.id===id),
  add: (name, color='#94a3b8')=>{
    const s = {id: uid('s'), name, color}; const arr=Statuses.all(); arr.push(s); Statuses.saveAll(arr);
    Activity.log(`${state.currentUser?.name || 'Система'} добавил(а) статус "${name}"`); return s;
  },
  removeById: (id) => {
    const arr = Statuses.all(); const idx = arr.findIndex(s => s.id === id); if (idx === -1) return false;
    const removed = arr.splice(idx,1)[0]; Statuses.saveAll(arr);
    const fallback = Statuses.all()[0] ? Statuses.all()[0].id : null;
    const clients = Clients.all();
    clients.forEach(c => { if(c.statusId === id){ c.statusId = fallback; c.log = c.log || []; c.log.unshift({at: now(), text: `Статус изменён автоматически (удалён статус "${removed.name}")`}); }});
    Clients.saveAll(clients);
    Activity.log(`${state.currentUser?.name || 'Система'} удалил(а) статус "${removed.name}"`);
    return true;
  }
};

const Clients = {
  all: ()=> lsGet('crm_clients', []),
  saveAll: (arr)=> lsSet('crm_clients', arr),
  byId: (id)=> Clients.all().find(c=>c.id===id),
  add: (c)=>{ const arr=Clients.all(); arr.push(c); Clients.saveAll(arr); Activity.log(`${state.currentUser?.name || 'Система'} добавил(а) клиента ${c.firstName} ${c.lastName}`); },
  update: (id, upd)=>{
    const arr = Clients.all(); const idx = arr.findIndex(x=>x.id===id); if(idx===-1) return;
    arr[idx] = {...arr[idx], ...upd}; Clients.saveAll(arr); Activity.log(`${state.currentUser?.name || 'Система'} обновил(а) клиента ${arr[idx].firstName} ${arr[idx].lastName}`);
  },
  remove: (id)=>{
    const arr = Clients.all(); const idx=arr.findIndex(x=>x.id===id); if(idx===-1) return;
    const removed = arr.splice(idx,1)[0]; Clients.saveAll(arr); Activity.log(`${state.currentUser?.name || 'Система'} удалил(а) клиента ${removed.firstName} ${removed.lastName}`);
  },
  addComment: (clientId, authorId, text)=>{
    const arr = Clients.all(); const c = arr.find(x=>x.id===clientId); if(!c) return;
    const comment = {id: uid('cm'), authorId, text, at: now()};
    c.comments = c.comments || []; c.comments.unshift(comment);
    c.log = c.log || []; c.log.unshift({at: now(), text:`Комментарий от ${Users.byId(authorId)?.name || 'пользователя'}: ${text}`});
    Clients.saveAll(arr); Activity.log(`${state.currentUser?.name || 'Система'} добавил(а) комментарий к ${c.firstName} ${c.lastName}`);
  },
  addLog: (clientId, text)=>{
    const arr = Clients.all(); const c = arr.find(x=>x.id===clientId); if(!c) return;
    c.log = c.log || []; c.log.unshift({at: now(), text}); Clients.saveAll(arr);
  },
  reassignClientsFromUser: (userId) => {
    const arr = Clients.all(); arr.forEach(c => { if(c.assignedTo === userId){ c.assignedTo = null; c.log = c.log || []; c.log.unshift({at: now(), text: `Пользователь удалён — снято назначение`}); }}); Clients.saveAll(arr);
  }
};

const Activity = {
  all: ()=> lsGet('crm_activity', []),
  saveAll: (arr)=> lsSet('crm_activity', arr),
  log: (text)=>{ const arr = Activity.all(); arr.unshift({at: now(), text}); Activity.saveAll(arr); }
};

/* ---------- Authentication ---------- */
function login(email, password){
  const user = Users.findByEmail(email);
  if(!user) return {ok:false, msg:'Пользователь не найден'};
  if(user.password !== password) return {ok:false, msg:'Неправильный пароль'};
  state.currentUser = user;
  Activity.log(`${user.name} вошёл(ла) в систему`);
  renderApp();
  return {ok:true};
}
function logout(){
  Activity.log(`${state.currentUser?.name || 'Пользователь'} вышел(ла)`);
  state.currentUser = null;
  state.tempClient = null;
  renderApp();
}

/* ---------- UI helpers ---------- */
const el = id => document.getElementById(id);

/* ---------- Admin small stats (sidebar) ---------- */
function renderAdminStats(){
  const stats = el('adminStats');
  if(!stats) return;
  if(state.currentUser?.role !== 'admin'){ stats.style.display = 'none'; stats.innerHTML = ''; return; }
  const allClients = Clients.all();
  const usersCount = Users.all().length;
  const totalClients = allClients.length;
  const newStatus = Statuses.all().find(s=>s.name === 'Новый');
  const newLeads = newStatus ? allClients.filter(c=>c.statusId === newStatus.id).length : 0;
  stats.style.display = '';
  stats.innerHTML = `<div style="font-weight:700;margin-bottom:8px">Статистика</div>
    <div class="meta-row"><div class="small muted">Клиентов всего</div><div class="small">${totalClients}</div></div>
    <div class="meta-row"><div class="small muted">Лидов (Новый)</div><div class="small">${newLeads}</div></div>
    <div class="meta-row"><div class="small muted">Пользователей</div><div class="small">${usersCount}</div></div>
    <div style="margin-top:8px"><button id="moreStatsBtn" class="btn ghost" style="width:100%">Подробная статистика</button></div>`;
  setTimeout(()=> { const b = el('moreStatsBtn'); if(b) b.onclick = ()=> setView('stats'); }, 10);
}

/* ---------- Views & Rendering ---------- */
function setView(v){
  state.view = v;
  document.querySelectorAll('#menu li').forEach(li=> li.classList.toggle('active', li.dataset.view===v));
  if(el('viewTitle')) el('viewTitle').textContent = v === 'leads' ? 'Лиды' : (v==='statuses'? 'Статусы' : (v==='users'? 'Управление' : (v==='activity'?'Журнал':'Статистика')));
  renderView();
}

function renderApp(){
  try{
    const userSummary = el('userSummary');
    if(userSummary) userSummary.innerHTML = '';
    const searchEl = el('globalSearch');
    if(!state.currentUser){
      if(el('loginView')) el('loginView').style.display = 'block';
      if(el('appViews')) el('appViews').style.display = 'none';
      const nav = document.querySelector('nav') || document.querySelector('.sidebar'); if(nav) nav.style.display = 'none';
      if(el('logoutNav')) el('logoutNav').style.display = 'none';
      document.querySelectorAll('#menu li').forEach(li=> li.style.display='none');
      if(searchEl) searchEl.style.display = 'none';
      if(el('downloadCsvTemplateBtn')) el('downloadCsvTemplateBtn').style.display = 'none';
      if(el('importCsvBtn')) el('importCsvBtn').style.display = 'none';
      if(el('openStatsBtn')) el('openStatsBtn').style.display = 'none';
      renderAdminStats();
      return;
    }

    // logged in
    if(searchEl) searchEl.style.display = '';
    if(el('loginView')) el('loginView').style.display = 'none';
    if(el('appViews')) el('appViews').style.display = 'block';
    const nav = document.querySelector('.sidebar'); if(nav) nav.style.display = '';

    document.querySelectorAll('#menu li').forEach(li=>{
      const v = li.dataset.view;
      if(!v){ li.style.display='flex'; return; }
      // pages only for admin
      if(['users','statuses','activity','stats'].includes(v)){
        li.style.display = (state.currentUser.role === 'admin') ? 'flex' : 'none';
      } else {
        li.style.display = 'flex';
      }
    });

    if(el('logoutNav')) el('logoutNav').style.display = 'block';

    if(userSummary){
      const avatar = document.createElement('div'); avatar.className='role-badge'; avatar.textContent = state.currentUser.name;
      const role = document.createElement('div'); role.className='role-badge'; role.textContent = state.currentUser.role.toUpperCase();
      userSummary.appendChild(avatar); userSummary.appendChild(role);
    }
    if(el('currentRole')) el('currentRole').textContent = state.currentUser.role.toUpperCase();

    if(el('createUserBtn')) el('createUserBtn').style.display = (state.currentUser.role === 'admin') ? 'inline-block' : 'none';
    if(el('addClientBtn')) el('addClientBtn').style.display = (state.currentUser.role === 'admin' || state.currentUser.role === 'affiliator') ? 'inline-block' : 'none';
    if(el('addStatusBtn')) el('addStatusBtn').style.display = (state.currentUser.role === 'admin') ? 'inline-block' : 'none';
    if(el('openStatsBtn')) el('openStatsBtn').style.display = (state.currentUser.role === 'admin') ? 'inline-block' : 'none';

    if(el('downloadCsvTemplateBtn')) el('downloadCsvTemplateBtn').style.display = (state.currentUser.role === 'user') ? 'none' : 'inline-block';
    if(el('importCsvBtn')) el('importCsvBtn').style.display = (state.currentUser.role === 'user') ? 'none' : 'inline-block';

    renderAdminStats();
    setView(state.view || 'leads');
  }catch(err){
    console.error('renderApp error', err);
  }
}

function renderView(){
  const container = el('viewContainer');
  if(!container) return;
  container.innerHTML = '';
  if(state.view === 'leads'){
    renderLeads(container);
  } else if(state.view === 'statuses'){
    renderStatuses(container);
  } else if(state.view === 'users'){
    renderUsers(container);
  } else if(state.view === 'activity'){
    renderActivity(container);
  } else if(state.view === 'stats'){
    renderStats(container);
  } else {
    container.textContent = 'Not implemented';
  }
}

/* --- Leads view --- */
function renderLeads(container){
  const title = document.createElement('div'); title.className='small muted'; title.textContent=`Лиды, назначенные: ${state.currentUser.name}`;
  container.appendChild(title);

  const tableWrap = document.createElement('div'); tableWrap.style.marginTop='10px';
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>
    <th>Клиент</th><th>Статус</th><th>Телефон</th><th>Email</th><th>Назначен</th>
  </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');
  const clients = Clients.all().filter(c=>{
    if(state.currentUser.role === 'admin') return true;
    if(state.currentUser.role === 'user') return c.assignedTo === state.currentUser.id;
    if(state.currentUser.role === 'affiliator') return c.createdBy === state.currentUser.id;
    return false;
  }).filter(filterBySearch);

  clients.forEach(c=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${escapeHtml(c.firstName)} ${escapeHtml(c.lastName)}</strong><div class="small muted">${escapeHtml(c.source || '')}</div></td>
      <td>${renderStatusInline(c.statusId)}</td>
      <td>${escapeHtml(c.phone||'')}</td>
      <td>${escapeHtml(c.email||'')}</td>
      <td class="small muted">${Users.byId(c.assignedTo)?.name || '—'}</td>`;
    tr.addEventListener('click', ()=> openClientCard(c.id));
    tbody.appendChild(tr);
  });

  if(clients.length===0){
    const empty = document.createElement('div'); empty.className='muted small'; empty.style.marginTop='12px'; empty.textContent='Нет лидов для отображения';
    container.appendChild(empty);
  }

  tableWrap.appendChild(table);
  container.appendChild(tableWrap);
}

/* --- Statuses management --- */
function renderStatuses(container){
  const statuses = Statuses.all();
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between">
    <div><h3 style="margin:0">Статусы</h3><div class="muted small">Управление статусами клиентов</div></div>
  </div>`;
  const list = document.createElement('div'); list.style.marginTop='12px'; list.style.display='flex'; list.style.flexDirection='column'; list.style.gap='8px';
  statuses.forEach(s=>{
    const row = document.createElement('div'); row.style.display='flex'; row.style.justifyContent='space-between'; row.style.alignItems='center';
    row.innerHTML = `<div style="display:flex;gap:8px;align-items:center"><span class="status-dot" style="background:${s.color}"></span><strong>${escapeHtml(s.name)}</strong></div>
      <div class="small muted"><button class="btn ghost" data-id="${s.id}">Редактировать</button></div>`;
    row.querySelector('button').addEventListener('click', ()=> {
      const newName = prompt('Название статуса', s.name);
      if(newName) {
        const arr = Statuses.all(); const idx = arr.findIndex(x=>x.id===s.id); arr[idx].name = newName; Statuses.saveAll(arr);
        Activity.log(`${state.currentUser.name} изменил(а) статус "${s.name}" -> "${newName}"`);
        renderView();
      }
    });
    list.appendChild(row);
  });

  const addBox = document.createElement('div'); addBox.style.marginTop='12px';
  addBox.innerHTML = `<div style="display:flex;gap:8px;align-items:center"><input id="newStatusName" placeholder="Новое имя статуса" /><input id="newStatusColor" type="color" value="#94a3b8" /><button id="addStatusConfirm" class="btn">Добавить</button></div>`;
  wrap.appendChild(list); wrap.appendChild(addBox);
  container.appendChild(wrap);

  el('addStatusConfirm').onclick = ()=>{
    const name = el('newStatusName').value.trim(); const color = el('newStatusColor').value;
    if(!name){ alert('Введите имя статуса'); return; }
    Statuses.add(name, color);
    el('newStatusName').value = '';
    renderView();
  };
}

/* --- Users management (admin only) --- */
function renderUsers(container){
  if(state.currentUser.role !== 'admin'){
    container.innerHTML = '<div class="muted">Только администратор имеет доступ к управлению пользователями.</div>'; return;
  }
  const users = Users.all();
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
    <div><h3 style="margin:0">Пользователи</h3><div class="muted small">Создавайте, редактируйте и назначайте роли</div></div>
    <div><button id="openCreateUser" class="btn">Новый пользователь</button></div>
  </div>`;

  const table = document.createElement('table'); table.style.marginTop='12px';
  table.innerHTML = `<thead><tr><th>Имя</th><th>Email</th><th>Роль</th><th>Действия</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  users.forEach(u=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(u.name)}</td><td class="small muted">${escapeHtml(u.email)}</td><td class="small">${u.role}</td>
      <td><button class="btn ghost editUser" data-id="${u.id}">Редактировать</button></td>`;
    tbody.appendChild(tr);
  });

  wrap.appendChild(table);
  container.appendChild(wrap);

  el('openCreateUser').onclick = ()=> openUserModal(null);
  document.querySelectorAll('.editUser').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const id = e.currentTarget.dataset.id; openUserModal(id);
    });
  });
}

/* --- Open / Edit user modal --- */
function openUserModal(userId){
  state.editingUserId = userId || null;
  const um = el('userModal'); if(!um) return alert('Модалка пользователей не найдена');
  if(el('userModalMsg')) el('userModalMsg').textContent = '';
  if(!userId){
    if(state.currentUser.role !== 'admin'){ alert('Создавать пользователей может только администратор'); return; }
    if(el('userModalTitle')) el('userModalTitle').textContent = 'Создать пользователя';
    if(el('userModalName')) el('userModalName').value = '';
    if(el('userModalEmail')) el('userModalEmail').value = '';
    if(el('userModalPassword')) el('userModalPassword').value = '';
    if(el('userModalRole')) el('userModalRole').value = 'user';
    if(el('userModalDelete')) el('userModalDelete').style.display = 'none';
  } else {
    const u = Users.byId(userId);
    if(!u) return alert('Пользователь не найден');
    if(el('userModalTitle')) el('userModalTitle').textContent = 'Редактировать пользователя';
    if(el('userModalName')) el('userModalName').value = u.name;
    if(el('userModalEmail')) el('userModalEmail').value = u.email;
    if(el('userModalPassword')) el('userModalPassword').value = (state.currentUser?.role === 'admin') ? (u.password || '') : '';
    if(el('userModalRole')) el('userModalRole').value = u.role;
    if(el('userModalDelete')) el('userModalDelete').style.display = (state.currentUser.role === 'admin' && u.id !== state.currentUser.id) ? 'inline-block' : 'none';
  }
  um.style.display = 'flex';
}

function closeUserModal(){ const um = el('userModal'); if(um) um.style.display = 'none'; state.editingUserId = null; }

function saveUserFromModal(){
  const name = el('userModalName').value.trim();
  const email = el('userModalEmail').value.trim();
  const pw = el('userModalPassword').value;
  const role = el('userModalRole').value;
  if(!name || !email){ if(el('userModalMsg')) el('userModalMsg').textContent = 'Имя и email обязательны'; return; }

  const existing = Users.findByEmail(email);
  if(state.editingUserId){
    const arr = Users.all(); const idx = arr.findIndex(x => x.id === state.editingUserId);
    if(idx === -1){ if(el('userModalMsg')) el('userModalMsg').textContent = 'Пользователь не найден'; return; }
    if(existing && existing.id !== state.editingUserId){ if(el('userModalMsg')) el('userModalMsg').textContent = 'Email уже используется'; return; }
    arr[idx].name = name; arr[idx].email = email;
    if(state.currentUser.role === 'admin'){
      if(role) arr[idx].role = role;
      if(pw) arr[idx].password = pw;
    }
    Users.saveAll(arr);
    Activity.log(`${state.currentUser.name} обновил(а) пользователя ${email}`);
    if(el('userModalMsg')) el('userModalMsg').textContent = 'Сохранено';
  } else {
    if(existing){ if(el('userModalMsg')) el('userModalMsg').textContent = 'Email уже используется'; return; }
    if(!pw){ if(el('userModalMsg')) el('userModalMsg').textContent = 'Задайте пароль для нового пользователя'; return; }
    const newUser = {id: uid('u'), name, email, password: pw, role};
    Users.create(newUser);
    if(el('userModalMsg')) el('userModalMsg').textContent = 'Пользователь создан';
  }
  renderView();
  setTimeout(()=> closeUserModal(), 700);
}

function deleteUserFromModal(){
  if(!state.editingUserId) return;
  if(state.currentUser.role !== 'admin'){ alert('Удалять пользователей может только администратор'); return; }
  if(!confirm('Удалить пользователя? Эта операция необратима.')) return;
  const id = state.editingUserId;
  if(id === state.currentUser.id) return alert('Нельзя удалить текущего пользователя');
  const arr = Users.all(); const idx = arr.findIndex(x => x.id === id);
  if(idx === -1) return alert('Пользователь не найден');
  const removed = arr.splice(idx,1)[0]; Users.saveAll(arr);
  Clients.reassignClientsFromUser(removed.id);
  Activity.log(`${state.currentUser.name} удалил(а) пользователя ${removed.email}`);
  closeUserModal(); renderView();
}

/* --- Activity view --- */
function renderActivity(container){
  if(state.currentUser.role !== 'admin'){ container.innerHTML = '<div class="muted">Только администратор имеет доступ к журналу.</div>'; return; }
  const acts = Activity.all();
  const wrap = document.createElement('div');
  wrap.innerHTML = `<h3>Журнал действий</h3><div class="muted small">Последние события в CRM</div>`;
  const list = document.createElement('div'); list.className = 'log'; list.style.maxHeight='420px'; list.style.marginTop='12px';
  acts.forEach(a=>{
    const row = document.createElement('div'); row.style.padding='8px'; row.style.borderBottom='1px solid rgba(255,255,255,0.02)';
    row.innerHTML = `<div style="font-size:13px">${escapeHtml(a.text)}</div><div class="small muted">${new Date(a.at).toLocaleString()}</div>`;
    list.appendChild(row);
  });
  wrap.appendChild(list);
  container.appendChild(wrap);
}

/* --- Stats view --- */
function renderStats(container){
  if(state.currentUser.role !== 'admin'){ container.innerHTML = '<div class="muted">Только администратор имеет доступ к статистике.</div>'; return; }

  const clients = Clients.all();
  const users = Users.all();
  const statuses = Statuses.all();

  const totalClients = clients.length;
  const totalUsers = users.length;
  const statusCounts = {};
  statuses.forEach(s => statusCounts[s.name] = 0);
  clients.forEach(c => {
    const s = Statuses.byId(c.statusId);
    const name = s ? s.name : '—';
    statusCounts[name] = (statusCounts[name] || 0) + 1;
  });

  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today.getTime() - 24*3600*1000);
  const weekStart = new Date(today.getTime()); weekStart.setDate(today.getDate() - (today.getDay()||7) + 1); weekStart.setHours(0,0,0,0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  function countInRange(from, to){
    return clients.filter(c => { if(!c.createdAt) return false; const t = new Date(c.createdAt); return t >= from && t < to; }).length;
  }
  const todayCount = countInRange(today, new Date(today.getTime()+24*3600*1000));
  const yesterdayCount = countInRange(yesterday, today);
  const weekCount = countInRange(weekStart, new Date(weekStart.getTime() + 7*24*3600*1000));
  const monthCount = countInRange(monthStart, new Date(monthStart.getFullYear(), monthStart.getMonth()+1, 1));

  const title = document.createElement('div'); title.innerHTML = `<h3 style="margin:0">Статистика</h3><div class="muted small">Аналитика по клиентам, статусам и пользователям</div>`;
  container.appendChild(title);

  const grid = document.createElement('div'); grid.className = 'stats-grid'; grid.style.marginTop = '12px';
  const left = document.createElement('div');

  const summary = document.createElement('div'); summary.className = 'summary-cards';
  const cTotal = document.createElement('div'); cTotal.className = 'summary-card'; cTotal.innerHTML = `<div class="small muted">Клиентов всего</div><div style="font-weight:700;font-size:20px">${totalClients}</div>`;
  const cUsers = document.createElement('div'); cUsers.className = 'summary-card'; cUsers.innerHTML = `<div class="small muted">Пользователей</div><div style="font-weight:700;font-size:20px">${totalUsers}</div>`;
  const cToday = document.createElement('div'); cToday.className = 'summary-card'; cToday.innerHTML = `<div class="small muted">Новые сегодня</div><div style="font-weight:700;font-size:20px">${todayCount}</div>`;
  const cYesterday = document.createElement('div'); cYesterday.className = 'summary-card'; cYesterday.innerHTML = `<div class="small muted">Новые вчера</div><div style="font-weight:700;font-size:20px">${yesterdayCount}</div>`;
  const cWeek = document.createElement('div'); cWeek.className = 'summary-card'; cWeek.innerHTML = `<div class="small muted">За неделю</div><div style="font-weight:700;font-size:20px">${weekCount}</div>`;
  const cMonth = document.createElement('div'); cMonth.className = 'summary-card'; cMonth.innerHTML = `<div class="small muted">За месяц</div><div style="font-weight:700;font-size:20px">${monthCount}</div>`;
  summary.appendChild(cTotal); summary.appendChild(cUsers); summary.appendChild(cToday); summary.appendChild(cYesterday); summary.appendChild(cWeek); summary.appendChild(cMonth);
  left.appendChild(summary);

  const statusCard = document.createElement('div'); statusCard.className = 'chart-card'; statusCard.style.marginTop = '12px';
  statusCard.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Клиенты по статусам</div><canvas id="statusBar" width="600" height="220"></canvas>`;
  left.appendChild(statusCard);

  const lineCard = document.createElement('div'); lineCard.className = 'chart-card'; lineCard.style.marginTop = '12px';
  lineCard.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Новые клиенты — последние 30 дней</div><canvas id="newClientsLine" width="600" height="220"></canvas>`;
  left.appendChild(lineCard);

  const right = document.createElement('div');

  const statusDetails = document.createElement('div'); statusDetails.className='card-mini';
  statusDetails.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Статусы — подробности</div>`;
  const sdList = document.createElement('div');
  for(const k in statusCounts){
    const row = document.createElement('div'); row.className='meta-row';
    row.innerHTML = `<div class="small">${escapeHtml(k)}</div><div class="small">${statusCounts[k]}</div>`;
    sdList.appendChild(row);
  }
  statusDetails.appendChild(sdList);
  right.appendChild(statusDetails);

  const usersCard = document.createElement('div'); usersCard.className = 'card-mini'; usersCard.style.marginTop='10px';
  usersCard.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Пользователи</div>`;
  const usersList = document.createElement('div'); usersList.className='small muted';
  Users.all().slice(0,10).forEach(u => { const d = document.createElement('div'); d.textContent = `${u.name} — ${u.email} (${u.role})`; usersList.appendChild(d); });
  usersCard.appendChild(usersList);
  right.appendChild(usersCard);

  // selector for detailed user stats
  const userSelectCard = document.createElement('div'); userSelectCard.className = 'card-mini'; userSelectCard.style.marginTop = '12px';
  userSelectCard.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Подробная статистика по пользователю</div>
    <div style="display:flex;gap:8px;align-items:center"><select id="statsUserSelect" style="width:100%"><option value="">— Выберите пользователя —</option></select></div>
    <div id="userStatsCard" style="margin-top:10px"></div>`;
  right.appendChild(userSelectCard);

  grid.appendChild(left);
  grid.appendChild(right);
  container.appendChild(grid);

  const statusLabels = Object.keys(statusCounts);
  const statusValues = statusLabels.map(l => statusCounts[l]);
  const statusColors = statusLabels.map(l => { const s = Statuses.all().find(x=>x.name===l); return s ? s.color : '#94a3b8'; });

  const days = 30; const labels = []; const values = [];
  for(let i = days-1; i >= 0; i--){ const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-i); const key = d.toISOString().slice(0,10); labels.push(key.slice(5)); const cnt = Clients.all().filter(c => c.createdAt && c.createdAt.slice(0,10) === key).length; values.push(cnt); }

  setTimeout(()=> {
    const barCanvas = el('statusBar'); if(barCanvas) drawBarChart(barCanvas, statusLabels, statusValues, statusColors);
    const lineCanvas = el('newClientsLine'); if(lineCanvas) drawLineChart(lineCanvas, labels, values);

    // fill user select
    const su = el('statsUserSelect'); if(su){ su.innerHTML = '<option value="">— Выберите пользователя —</option>'; Users.all().forEach(u=>{ const opt = document.createElement('option'); opt.value = u.id; opt.textContent = `${u.name} (${u.role})`; su.appendChild(opt); }); }

    // hook change
    if(su) su.addEventListener('change', ()=> updateUserStats(su.value));
  }, 40);
}

/* ---------- User breakdown renderer ---------- */
function updateUserStats(userId){
  const container = el('userStatsCard'); if(!container) return; container.innerHTML = '';
  if(!userId){ container.innerHTML = '<div class="muted small">Выберите пользователя, чтобы увидеть подробную статистику.</div>'; return; }
  const user = Users.byId(userId); if(!user) return container.innerHTML = '<div class="muted small">Пользователь не найден.</div>';

  const assigned = Clients.all().filter(c => c.assignedTo === userId);
  const total = assigned.length;
  const statuses = Statuses.all();
  const counts = {};
  statuses.forEach(s => counts[s.name] = 0);
  assigned.forEach(c => { const s = Statuses.byId(c.statusId); const name = s ? s.name : '—'; counts[name] = (counts[name] || 0) + 1; });

  const header = document.createElement('div'); header.innerHTML = `<div style="font-weight:700">Статистика: ${escapeHtml(user.name)}</div><div class="small muted">Всего лидов: ${total}</div>`;
  container.appendChild(header);

  const table = document.createElement('div'); table.style.marginTop = '8px';
  const rows = document.createElement('div'); rows.style.display = 'flex'; rows.style.flexDirection = 'column'; rows.style.gap = '6px';
  statuses.forEach(s => {
    const cnt = counts[s.name] || 0;
    const pct = total ? Math.round(cnt/total*100) : 0;
    const row = document.createElement('div'); row.className = 'meta-row';
    row.innerHTML = `<div style="display:flex;gap:8px;align-items:center"><span class="status-dot" style="background:${s.color}"></span><div>${escapeHtml(s.name)}</div></div><div class="small">${cnt} (${pct}%)</div>`;
    rows.appendChild(row);
  });
  table.appendChild(rows);
  container.appendChild(table);

  const chartWrap = document.createElement('div'); chartWrap.style.marginTop = '10px'; chartWrap.className = 'chart-card';
  chartWrap.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Разбивка по статусам</div><canvas id="userStatusBar" width="400" height="160"></canvas>`;
  container.appendChild(chartWrap);

  setTimeout(()=>{
    const labels = statuses.map(s => s.name);
    const vals = labels.map(l => counts[l] || 0);
    const cols = statuses.map(s => s.color);
    const can = el('userStatusBar'); if(can) drawBarChart(can, labels, vals, cols);
  }, 40);
}

/* ---------- Chart helpers (canvas) ---------- */
function drawBarChart(canvas, labels, values, colors){
  const ctx = canvas.getContext('2d');
  const DPR = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * DPR; const h = canvas.clientHeight * DPR;
  canvas.width = w; canvas.height = h;
  ctx.clearRect(0,0,w,h);
  const padding = 30 * DPR;
  const chartW = w - padding*2;
  const chartH = h - padding*2;
  const max = Math.max(...values, 1);
  const barWidth = chartW / values.length * 0.7;
  const gap = (chartW - values.length*barWidth) / (values.length-1 || 1);

  ctx.font = `${12*DPR}px sans-serif`; ctx.fillStyle = '#9aa4b2';
  labels.forEach((lab, i) => {
    const x = padding + i*(barWidth + gap) + barWidth/2;
    const y = h - padding + 14*DPR;
    ctx.textAlign = 'center'; ctx.fillText(lab, x, y);
  });

  values.forEach((v,i)=>{
    const x = padding + i*(barWidth + gap);
    const barH = (v / max) * (chartH - 20*DPR);
    const y = padding + (chartH - barH);
    ctx.fillStyle = colors && colors[i] ? colors[i] : '#3b82f6';
    roundRect(ctx, x, y, barWidth, barH, 6*DPR, true, false);
    ctx.fillStyle = '#e6eef8'; ctx.font = `${11*DPR}px sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(String(v), x + barWidth/2, y - 6*DPR);
  });
}

function drawLineChart(canvas, labels, values){
  const ctx = canvas.getContext('2d');
  const DPR = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * DPR; const h = canvas.clientHeight * DPR;
  canvas.width = w; canvas.height = h;
  ctx.clearRect(0,0,w,h);
  const padding = 36 * DPR;
  const chartW = w - padding*2;
  const chartH = h - padding*2;
  const max = Math.max(...values, 1);
  const points = values.map((v,i)=>{
    const x = padding + (i/(values.length-1 || 1)) * chartW;
    const y = padding + (1 - v/max) * (chartH - 10*DPR);
    return {x,y};
  });

  ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
  for(let i=0;i<=4;i++){
    const y = padding + (i/4) * (chartH - 10*DPR);
    ctx.beginPath(); ctx.moveTo(padding, y); ctx.lineTo(padding + chartW, y); ctx.stroke();
  }

  ctx.beginPath(); ctx.lineWidth = 2*DPR; ctx.strokeStyle = '#3b82f6';
  points.forEach((p,i)=> { if(i===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y); });
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, padding, 0, padding+chartH);
  grad.addColorStop(0, 'rgba(59,130,246,0.18)'); grad.addColorStop(1, 'rgba(59,130,246,0.02)');
  ctx.lineTo(padding+chartW, padding+chartH); ctx.lineTo(padding, padding+chartH); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  points.forEach(p=> { ctx.beginPath(); ctx.arc(p.x,p.y,3*DPR,0,Math.PI*2); ctx.fillStyle='#fff'; ctx.fill(); });

  ctx.fillStyle = '#9aa4b2'; ctx.font = `${11*DPR}px sans-serif`; ctx.textAlign = 'center';
  for(let i=0;i<labels.length;i+=Math.max(1,Math.floor(labels.length/6))){
    const lab = labels[i];
    const x = padding + (i/(labels.length-1||1))*chartW;
    ctx.fillText(lab, x, padding+chartH + 14*DPR);
  }
}

function roundRect(ctx,x,y,w,h,r,fill,stroke){ if (typeof r === 'undefined') r = 5; ctx.beginPath(); ctx.moveTo(x+r, y); ctx.arcTo(x+w, y,   x+w, y+h, r); ctx.arcTo(x+w, y+h, x,   y+h, r); ctx.arcTo(x,   y+h, x,   y,   r); ctx.arcTo(x,   y,   x+w, y,   r); ctx.closePath(); if(fill){ ctx.fill(); } if(stroke){ ctx.stroke(); } }

/* ---------- Client modal & management ---------- */
function openClientCard(clientOrId){
  let clientObj = null, isTemp=false;
  if(typeof clientOrId === 'object' && clientOrId !== null){ clientObj = clientOrId; isTemp = !!clientObj.__isTemp; state.tempClient = clientObj; state.selectedClient = null; }
  else { clientObj = Clients.byId(clientOrId); isTemp = false; state.tempClient = null; state.selectedClient = clientOrId; if(!clientObj) return alert('Клиент не найден'); }

  if(el('modalTitle')) el('modalTitle').textContent = `Карточка: ${clientObj.firstName || ''} ${clientObj.lastName || ''}`;
  if(el('clientMeta')) el('clientMeta').textContent = clientObj.createdAt ? `Создан: ${new Date(clientObj.createdAt).toLocaleString()}` : `Новый клиент`;
  if(el('clientAvatar')) el('clientAvatar').textContent = (clientObj.firstName||'')[0] ? ((clientObj.firstName[0] + (clientObj.lastName?clientObj.lastName[0]:'')) .toUpperCase()) : '👤';

  if(el('c_firstName')) el('c_firstName').value = clientObj.firstName || '';
  if(el('c_lastName')) el('c_lastName').value = clientObj.lastName || '';
  if(el('c_email')) el('c_email').value = clientObj.email || '';
  if(el('c_phone')) el('c_phone').value = clientObj.phone || '';
  if(el('c_source')) el('c_source').value = clientObj.source || '';
  if(el('c_card')) el('c_card').value = clientObj.card || '';
  if(el('c_amount')) el('c_amount').value = clientObj.amount || '';
  if(el('c_loss')) el('c_loss').value = clientObj.loss || '';
  if(el('c_regDate')) el('c_regDate').value = clientObj.regDate || '';
  if(el('c_birthDate')) el('c_birthDate').value = clientObj.birthDate || '';
  if(el('c_description')) el('c_description').value = clientObj.description || '';

  const statusSelect = el('c_status'); if(statusSelect) statusSelect.innerHTML = '';
  Statuses.all().forEach(s=>{
    if(statusSelect){
      const opt = document.createElement('option'); opt.value = s.id; opt.textContent = s.name; if(s.id===clientObj.statusId) opt.selected = true;
      statusSelect.appendChild(opt);
    }
  });

  const selStatus = Statuses.byId(clientObj.statusId);
  if(el('statusChip')) el('statusChip').textContent = selStatus ? selStatus.name : '—';

  const right = el('clientRight'); if(right) right.innerHTML = '';
  const createdBy = Users.byId(clientObj.createdBy);

  // Role-aware right column
  if(state.currentUser.role === 'admin'){
    const metaCard = document.createElement('div'); metaCard.className = 'card-mini';
    metaCard.innerHTML = `<div style="font-weight:700;margin-bottom:8px">Сводка</div>
      <div class="meta-row"><div class="small muted">Создан</div><div class="small">${clientObj.createdAt ? new Date(clientObj.createdAt).toLocaleString() : '—'}</div></div>
      <div class="meta-row"><div class="small muted">Создал</div><div class="small">${createdBy?.name || '—'}</div></div>
      <div class="meta-row"><div class="small muted">Статус</div><div class="small">${selStatus ? selStatus.name : '—'}</div></div>
      <div class="meta-row"><div class="small muted">Сумма</div><div class="small">${clientObj.amount || '—'}</div></div>`;
    right.appendChild(metaCard);

    const adminCard = document.createElement('div'); adminCard.className = 'card-mini';
    adminCard.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Управление</div>
      <div style="margin-top:6px"><label>Назначить пользователю</label><select id="assignUserSelectAdmin"></select></div>
      <div style="display:flex;gap:8px;margin-top:10px"><button id="assignUserBtnAdmin" class="btn">Назначить</button><button id="deleteClientBtnAdmin" class="btn" style="background:var(--danger)">Удалить</button></div>`;
    right.appendChild(adminCard);

    const logCard = document.createElement('div'); logCard.className = 'card-mini';
    logCard.innerHTML = `<div style="font-weight:700;margin-bottom:6px">История</div><div id="clientLogAdmin" class="log"></div>`;
    right.appendChild(logCard);

    setTimeout(()=> {
      const assignSelect = el('assignUserSelectAdmin');
      if(assignSelect){ assignSelect.innerHTML = '<option value="">— не назначен —</option>'; Users.all().forEach(u => { const opt = document.createElement('option'); opt.value = u.id; opt.textContent = `${u.name} (${u.role})`; if(u.id === clientObj.assignedTo) opt.selected = true; assignSelect.appendChild(opt); }); }
      if(el('c_statusColorAdmin')) el('c_statusColorAdmin').value = selStatus ? selStatus.color : '#94a3b8';
      const btnAssign = el('assignUserBtnAdmin'); if(btnAssign) btnAssign.onclick = ()=>{ const uidSel = el('assignUserSelectAdmin').value || null; if(state.selectedClient) { Clients.update(state.selectedClient, {assignedTo: uidSel}); Clients.addLog(state.selectedClient, `Назначен: ${Users.byId(uidSel)?.name || '—'}`); openClientCard(state.selectedClient); renderView(); } };
      const btnDel = el('deleteClientBtnAdmin'); if(btnDel) btnDel.onclick = ()=>{ if(!state.selectedClient) return; if(!confirm('Удалить клиента?')) return; Clients.remove(state.selectedClient); closeClientModal(); renderView(); };
      const logEl = el('clientLogAdmin'); if(logEl) { logEl.innerHTML = ''; (clientObj.log || []).forEach(l => { const d = document.createElement('div'); d.style.padding='6px'; d.style.borderBottom='1px dashed rgba(255,255,255,0.02)'; d.innerHTML = `<div class="small muted">${new Date(l.at).toLocaleString()}</div><div>${escapeHtml(l.text)}</div>`; logEl.appendChild(d); }); }
    }, 40);

  } else if(state.currentUser.role === 'affiliator'){
    const affCard = document.createElement('div'); affCard.className = 'card-mini';
    affCard.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Детали</div>
      <div class="meta-row"><div class="small muted">Создал</div><div class="small">${createdBy?.name || '—'}</div></div>
      <div class="meta-row"><div class="small muted">Статус</div><div class="small">${selStatus ? selStatus.name : '—'}</div></div>
      <div style="margin-top:8px"><div class="small muted">Краткая история</div><div id="clientLogAff" class="log"></div></div>`;
    right.appendChild(affCard);
    setTimeout(()=> { const logEl = el('clientLogAff'); if(logEl){ logEl.innerHTML = ''; (clientObj.log || []).slice(0,8).forEach(l => { const d = document.createElement('div'); d.style.padding='6px'; d.style.borderBottom='1px dashed rgba(255,255,255,0.02)'; d.innerHTML = `<div class="small muted">${new Date(l.at).toLocaleString()}</div><div>${escapeHtml(l.text)}</div>`; logEl.appendChild(d); }); } }, 40);
  } else {
    if(right) right.innerHTML = '';
    if(el('assignToMeBtn')) el('assignToMeBtn').style.display = 'none';
  }

  if(isTemp){
    // temp creation: show Delete only for admin (or hide), and do not show assign-to-me
    if(el('assignToMeBtn')) el('assignToMeBtn').style.display = 'none';
    if(el('deleteClientBtn')) el('deleteClientBtn').style.display = 'none';
  }
  else {
    if(el('assignToMeBtn')) el('assignToMeBtn').style.display = 'none';
    if(el('deleteClientBtn')) el('deleteClientBtn').style.display = (state.currentUser.role === 'admin') ? 'inline-block' : 'none';
  }

  if(!isTemp) renderComments(clientObj); else { if(el('commentsList')) el('commentsList').innerHTML = ''; }
  if(el('clientModal')) el('clientModal').style.display = 'flex';
}

function saveClientFromModal(){
  const isCreating = !!(state.tempClient && state.tempClient.__isTemp);
  if(isCreating){
    // validate required fields, do not create empty client on close
    const firstName = el('c_firstName').value.trim();
    if(!firstName){ if(el('clientSaveMsg')) el('clientSaveMsg').textContent = 'Имя обязательно'; return; } else if(el('clientSaveMsg')) el('clientSaveMsg').textContent = '';
    const statusVal = el('c_status')?.value || '';
    if(!statusVal){ if(el('clientSaveMsg')) el('clientSaveMsg').textContent = 'Выберите статус из существующих'; return; }
    const newClient = {
      id: uid('c'),
      firstName,
      lastName: el('c_lastName').value.trim(),
      statusId: statusVal,
      email: el('c_email').value,
      phone: el('c_phone').value,
      source: el('c_source').value,
      card: el('c_card').value,
      amount: el('c_amount').value,
      loss: el('c_loss').value,
      regDate: el('c_regDate').value,
      birthDate: el('c_birthDate').value,
      base: el('c_base') ? el('c_base').value : '',
      lossCompany: el('c_lossCompany') ? el('c_lossCompany').value : '',
      description: el('c_description').value,
      assignedTo: null,
      createdBy: state.currentUser.id,
      createdAt: now(),
      comments: [],
      log: [{at: now(), text: `Создан ${state.currentUser.name}`}]
    };
    Clients.add(newClient);
    state.tempClient = null;
    openClientCard(newClient.id);
    renderView();
  } else {
    const id = state.selectedClient;
    if(!id) return;
    const firstName = el('c_firstName').value.trim();
    if(!firstName){ if(el('clientSaveMsg')) el('clientSaveMsg').textContent = 'Имя обязательно'; return; } else if(el('clientSaveMsg')) el('clientSaveMsg').textContent = '';
    const statusVal = el('c_status')?.value || '';
    if(!statusVal){ if(el('clientSaveMsg')) el('clientSaveMsg').textContent = 'Выберите статус из существующих'; return; }

    const upd = {
      firstName,
      lastName: el('c_lastName').value.trim(),
      statusId: statusVal,
      email: el('c_email').value,
      phone: el('c_phone').value,
      source: el('c_source').value,
      card: el('c_card').value,
      amount: el('c_amount').value,
      loss: el('c_loss').value,
      regDate: el('c_regDate').value,
      birthDate: el('c_birthDate').value,
      description: el('c_description').value,
    };
    Clients.update(id, upd);

    if(state.currentUser.role === 'admin'){
      const colorEl = el('c_statusColorAdmin'); if(colorEl){ const color = colorEl.value; const statuses = Statuses.all(); const idx = statuses.findIndex(s => s.id === upd.statusId); if(idx !== -1 && statuses[idx].color !== color){ statuses[idx].color = color; Statuses.saveAll(statuses); } }
    }

    Clients.addLog(id, `Данные обновлены ${state.currentUser.name}`);
    renderView();
    openClientCard(id);
  }
}

function closeClientModal(){
  // if temp client existed but was not saved, discard it (do not persist empty clients)
  if(state.tempClient && state.tempClient.__isTemp) state.tempClient = null;
  state.selectedClient = null;
  if(el('clientModal')) el('clientModal').style.display = 'none';
}

function renderComments(client){
  const container = el('commentsList'); if(!container) return;
  container.innerHTML = '';
  (client.comments || []).forEach(cm=>{
    const author = Users.byId(cm.authorId);
    const div = document.createElement('div'); div.className='comment';
    div.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
      <div><strong>${escapeHtml(author?.name||'Аноним')}</strong> <span class="small muted">${new Date(cm.at).toLocaleString()}</span></div>
    </div><div style="margin-top:6px">${escapeHtml(cm.text)}</div>`;
    container.appendChild(div);
  });
}

/* --- CSV helpers --- */
function csvTemplateText(){ return ['firstName,lastName,status,email,phone,source,card,amount,loss,regDate,birthDate,base,lossCompany,description,assignedToEmail,createdByEmail,createdAt'].concat(['Иван,Петров,Новый,ivan.petrov@example.com,+373600001,Форма сайта,"**** **** **** 1234",1200,0,2025-09-01,1990-05-12,Основная,,Интересуется пакетом Pro,aff@crm.local,aff@crm.local,2025-09-01T12:00:00Z']).join('\n'); }
function downloadCsvTemplate(){ const blob = new Blob([csvTemplateText()], {type:'text/csv;charset=utf-8;'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'crm_clients_template.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); }
function parseCsvSimple(text){ const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0); if(lines.length < 2) return []; const headers = lines[0].split(',').map(h => h.trim()); const rows = lines.slice(1).map(line => { const values = []; let current = ''; let inQuotes = false; for(let i=0;i<line.length;i++){ const ch = line[i]; if(ch === '"'){ inQuotes = !inQuotes; continue; } if(ch === ',' && !inQuotes){ values.push(current); current = ''; continue; } current += ch; } values.push(current); const obj = {}; headers.forEach((h, idx) => obj[h] = (values[idx] || '').trim()); return obj; }); return rows; }
function importCsvFile(file){ const reader = new FileReader(); reader.onload = (e) => { try{ const rows = parseCsvSimple(e.target.result || ''); if(!rows.length) return alert('Нет строк для импорта или неверный формат CSV.'); let created = 0; rows.forEach(r => { const status = Statuses.all().find(s => s.name === (r.status || '')) || Statuses.all()[0] || null; const assignedUser = Users.findByEmail((r.assignedToEmail||'').trim()); const createdByUser = Users.findByEmail((r.createdByEmail||'').trim()) || state.currentUser; const c = { id: uid('c'), firstName: r.firstName || 'Имя', lastName: r.lastName || '', statusId: status ? status.id : null, email: r.email || '', phone: r.phone || '', source: r.source || '', card: r.card || '', amount: r.amount || '', loss: r.loss || '', regDate: r.regDate || '', birthDate: r.birthDate || '', base: r.base || '', lossCompany: r.lossCompany || '', description: r.description || '', assignedTo: assignedUser ? assignedUser.id : null, createdBy: createdByUser ? createdByUser.id : state.currentUser.id, createdAt: r.createdAt || now(), comments: [], log: [{at: now(), text: `Импортирован из CSV пользователем ${state.currentUser.name}`}] }; Clients.add(c); created++; }); alert(`Импортировано ${created} клиентов.`); renderView(); }catch(err){ console.error(err); alert('Ошибка при импорте CSV: ' + err.message); } }; reader.readAsText(file, 'utf-8'); }

/* --- small helpers --- */
function escapeHtml(s){ if(!s && s!==0) return ''; return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }
function renderStatusInline(statusId){
  const s = Statuses.byId(statusId);
  if(!s) return `<span class="pill">—</span>`;
  return `<span style="display:inline-flex;align-items:center" title="${escapeHtml(s.name)}"><span class="status-dot" style="background:${s.color}"></span>${escapeHtml(s.name)}</span>`;
}
function filterBySearch(c){
  const q = (el('globalSearch')?.value || state.search || '').toLowerCase().trim();
  if(!q) return true;
  return (c.firstName||'').toLowerCase().includes(q) || (c.lastName||'').toLowerCase().includes(q) ||
    (c.email||'').toLowerCase().includes(q) || (c.phone||'').toLowerCase().includes(q);
}

/* ---------- Event bindings ---------- */
document.addEventListener('DOMContentLoaded', ()=> {
  // init theme first
  initTheme();

  // menu clicks
  document.querySelectorAll('#menu li').forEach(li=>{
    const v = li.dataset.view;
    li.addEventListener('click', ()=> {
      if(v) setView(v);
    });
  });

  // logout
  if(el('logoutNav')) el('logoutNav').addEventListener('click', ()=> {
    logout();
  });

  // login
  if(el('loginForm')) el('loginForm').addEventListener('submit', e=>{
    e.preventDefault();
    const email = el('loginEmail').value.trim(); const pw = el('loginPassword').value;
    const res = login(email, pw);
    if(!res.ok) el('loginMsg').textContent = res.msg; else el('loginMsg').textContent = '';
  });

  if(el('demoFill')) el('demoFill').addEventListener('click', ()=>{
    if(el('loginEmail')) el('loginEmail').value = 'admin@crm.local';
    if(el('loginPassword')) el('loginPassword').value = 'admin';
  });

  // search
  if(el('globalSearch')) el('globalSearch').addEventListener('input', ()=> { renderView(); });

  // add client
  if(el('addClientBtn')) el('addClientBtn').addEventListener('click', ()=>{
    if(!(state.currentUser && (state.currentUser.role === 'admin' || state.currentUser.role === 'affiliator'))){
      alert('У вас нет прав для добавления клиента'); return;
    }
    // create temp client object, do not persist until Save
    const tmp = {
      __isTemp: true,
      id: uid('tmp_c'),
      firstName: '',
      lastName: '',
      statusId: Statuses.all()[0]?.id || null,
      email:'',
      phone:'',
      source:'',
      card:'',
      amount:'',
      loss:'',
      regDate: new Date().toISOString().slice(0,10),
      birthDate:'',
      base:'',
      lossCompany:'',
      description:'',
      assignedTo: null,
      createdBy: state.currentUser.id,
      createdAt: null,
      comments: [],
      log: []
    };
    state.tempClient = tmp;
    openClientCard(tmp);
  });

  // add status
  if(el('addStatusBtn')) el('addStatusBtn').addEventListener('click', ()=> {
    const name = prompt('Название статуса'); if(!name) return; const color = prompt('Цвет в hex (например #10b981)', '#94a3b8') || '#94a3b8';
    Statuses.add(name, color);
    renderView();
  });

  // create user
  if(el('createUserBtn')) el('createUserBtn').addEventListener('click', ()=> openUserModal(null));

  // CSV buttons
  if(el('downloadCsvTemplateBtn')) el('downloadCsvTemplateBtn').addEventListener('click', () => downloadCsvTemplate());
  if(el('importCsvBtn')) el('importCsvBtn').addEventListener('click', () => { if(el('csvFileInput')) el('csvFileInput').click(); });
  if(el('csvFileInput')) el('csvFileInput').addEventListener('change', (ev) => { const f = ev.target.files?.[0]; if(!f) return; if(!confirm('Импортировать клиентов из выбранного CSV?')){ ev.target.value=''; return; } importCsvFile(f); ev.target.value=''; });

  // modal buttons
  if(el('closeModal')) el('closeModal').addEventListener('click', closeClientModal);
  if(el('saveClientBtn')) el('saveClientBtn').addEventListener('click', ()=> saveClientFromModal());
  if(el('assignUserBtn')) el('assignUserBtn').addEventListener('click', ()=> {
    const id = state.selectedClient; if(!id) return;
    const userId = el('assignUserSelect')?.value || null;
    Clients.update(id, {assignedTo: userId});
    Clients.addLog(id, `Назначен: ${Users.byId(userId)?.name || '—'}`);
    renderView(); openClientCard(id);
  });
  if(el('assignToMeBtn')) el('assignToMeBtn').addEventListener('click', ()=>{
    const id = state.selectedClient; if(!id) return;
    // removed: user shouldn't accept if already assigned; and earlier requirements said no accept button for user — we hide it in UI; keep safe check
    if(state.currentUser.role !== 'user'){ alert('Только обычный пользователь может брать лиды'); return; }
    Clients.update(id, {assignedTo: state.currentUser.id});
    Clients.addLog(id, `Принят на себя ${state.currentUser.name}`);
    renderView(); openClientCard(id);
  });

  if(el('deleteClientBtn')) el('deleteClientBtn').addEventListener('click', ()=>{
    const id = state.selectedClient; if(!id) return;
    if(!confirm('Удалить клиента?')) return;
    Clients.remove(id);
    closeClientModal(); renderView();
  });

  if(el('addCommentBtn')) el('addCommentBtn').addEventListener('click', ()=>{
    const id = state.selectedClient; if(!id) return;
    const text = el('commentText').value.trim(); if(!text) return;
    Clients.addComment(id, state.currentUser.id, text);
    el('commentText').value = '';
    openClientCard(id);
  });

  // user modal bindings
  if(el('userModalClose')) el('userModalClose').addEventListener('click', closeUserModal);
  if(el('userModalSave')) el('userModalSave').addEventListener('click', saveUserFromModal);
  if(el('userModalDelete')) el('userModalDelete').addEventListener('click', deleteUserFromModal);
  if(el('togglePasswordView')) el('togglePasswordView').addEventListener('click', () => { const pwInput = el('userModalPassword'); if(!pwInput) return; pwInput.type = pwInput.type === 'text' ? 'password' : 'text'; });

  // theme toggle
  if(el('themeToggle')) el('themeToggle').addEventListener('click', () => toggleTheme());

  // keyboard escape to close modal
  document.addEventListener('keydown', e=>{
    if(e.key === 'Escape') {
      if(el('clientModal') && el('clientModal').style.display==='flex') closeClientModal();
      if(el('userModal') && el('userModal').style.display==='flex') closeUserModal();
    }
  });

  // initial draw
  renderApp();
});

/* ---------- Init from URL (placeholder) ---------- */
function initFromUrl(){}
initFromUrl();