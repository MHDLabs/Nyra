// Static assets for Mini App (inlined for Cloudflare Workers)

export const staticAssets = {
  "index.html": `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Nyra</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div id="app">
    <div class="loading">
      <div class="spinner"></div>
      <p>در حال بارگذاری...</p>
    </div>
  </div>
  <div id="toast" class="toast" hidden></div>
  <script src="/app.js"></script>
</body>
</html>`,

  "app.js": `(function () {
  'use strict';
  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  var state = {
    user: null, isAdmin: false, personalAllowed: false, personalLimit: 5,
    section: 'chat', chat: [], connections: [], routes: [], personal: [],
    adminStats: null, adminPage: 0
  };

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg) {
    var t = el('toast');
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2200);
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    headers['X-Init-Data'] = tg ? tg.initData : '';
    if (opts.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function init() {
    if (tg) { tg.ready(); tg.expand(); }
    loadTheme();
    var initData = tg ? tg.initData : '';
    if (!initData) { el('app').innerHTML = '<div class="empty">این برنامه فقط داخل تلگرام کار می‌کند</div>'; return; }
    api('/api/auth', { method: 'POST', body: { initData: initData }, headers: { 'X-Init-Data': '' } })
      .then(function (data) {
        state.user = data.user;
        state.isAdmin = !!data.isAdmin;
        state.personalAllowed = !!data.personal_models_allowed;
        state.personalLimit = data.personal_model_limit || 5;
        renderShell();
        loadSection(state.section);
      })
      .catch(function () { el('app').innerHTML = '<div class="empty">خطا در احراز هویت</div>'; });
  }

  function loadTheme() {
    if (localStorage.getItem('nyra-theme') === 'light') document.body.classList.add('light');
  }
  window.toggleTheme = function () {
    var light = document.body.classList.toggle('light');
    localStorage.setItem('nyra-theme', light ? 'light' : 'dark');
    var b = el('theme-btn'); if (b) b.textContent = light ? '🌙' : '☀️';
  };

  function tabs() {
    var list = [{ id: 'chat', label: '💬 گفتگو' }, { id: 'models', label: '🔑 مدل‌ها' }];
    if (state.isAdmin) list.push({ id: 'routes', label: '🧭 مسیرها' });
    if (state.personalAllowed && !state.isAdmin) list.push({ id: 'personal', label: '🧩 مدل شخصی' });
    list.push({ id: 'settings', label: '⚙️ تنظیمات' });
    if (state.isAdmin) list.push({ id: 'admin', label: '🛠 مدیریت' });
    return list;
  }

  function renderShell() {
    var light = document.body.classList.contains('light');
    var head = '<div class="header"><h1>Nyra <span class="sub">' + esc(state.user && state.user.first_name ? state.user.first_name : '') + '</span></h1>' +
      '<button id="theme-btn" class="icon-btn" onclick="window.toggleTheme()">' + (light ? '🌙' : '☀️') + '</button></div>';
    var nav = '<div class="tabs">' + tabs().map(function (t) {
      return '<button class="tab' + (t.id === state.section ? ' active' : '') + '" data-tab="' + t.id + '" onclick="window.switchSection(\\'' + t.id + '\\')">' + t.label + '</button>';
    }).join('') + '</div>';
    var body = '<div class="content">' +
      '<div id="sec-chat" class="section"></div>' +
      '<div id="sec-models" class="section"></div>' +
      (state.isAdmin ? '<div id="sec-routes" class="section"></div>' : '') +
      (state.personalAllowed && !state.isAdmin ? '<div id="sec-personal" class="section"></div>' : '') +
      '<div id="sec-settings" class="section"></div>' +
      (state.isAdmin ? '<div id="sec-admin" class="section"></div>' : '') +
      '</div>';
    el('app').innerHTML = head + nav + body;
  }

  window.switchSection = function (section) {
    state.section = section;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === section);
    });
    loadSection(section);
  };

  function loadSection(section) {
    Array.prototype.forEach.call(document.querySelectorAll('.section'), function (s) { s.classList.remove('active'); });
    var current = el('sec-' + section);
    if (current) current.classList.add('active');
    if (section === 'chat') renderChat();
    else if (section === 'models') loadModels();
    else if (section === 'routes') loadRoutes();
    else if (section === 'personal') loadPersonal();
    else if (section === 'settings') renderSettings();
    else if (section === 'admin') loadAdmin();
  }

  function renderChat() {
    var box = el('sec-chat');
    if (!box) return;
    box.innerHTML = '<div class="chat"><div class="chat-log" id="chat-log"></div>' +
      '<div class="chat-input"><textarea id="chat-text" rows="1" placeholder="پیام خود را بنویسید..."></textarea>' +
      '<button class="btn" id="chat-send" onclick="window.sendChat()">➤</button></div></div>';
    renderChatLog();
    var ta = el('chat-text');
    ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendChat(); }
    });
  }

  function renderChatLog() {
    var log = el('chat-log');
    if (!log) return;
    if (state.chat.length === 0) { log.innerHTML = '<div class="empty">گفتگو را آغاز کنید.</div>'; return; }
    log.innerHTML = state.chat.map(function (m) {
      if (m.role === 'error') return '<div class="msg err">' + esc(m.text) + '</div>';
      if (m.role === 'pending') return '<div class="typing">در حال نوشتن...</div>';
      return '<div class="msg ' + (m.role === 'user' ? 'user' : 'bot') + '">' + esc(m.text) + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  window.sendChat = function () {
    var ta = el('chat-text');
    if (!ta) return;
    var text = ta.value.trim();
    if (!text) return;
    ta.value = ''; ta.style.height = 'auto';
    state.chat.push({ role: 'user', text: text });
    state.chat.push({ role: 'pending', text: '' });
    renderChatLog();
    var btn = el('chat-send'); if (btn) btn.disabled = true;
    api('/api/chat', { method: 'POST', body: { message: text } })
      .then(function (data) {
        state.chat = state.chat.filter(function (m) { return m.role !== 'pending'; });
        state.chat.push({ role: 'bot', text: data.response });
      })
      .catch(function (err) {
        state.chat = state.chat.filter(function (m) { return m.role !== 'pending'; });
        state.chat.push({ role: 'error', text: 'خطا: ' + err.message });
      })
      .then(function () {
        var b = el('chat-send'); if (b) b.disabled = false;
        renderChatLog();
      });
  };

  function loadModels() {
    var box = el('sec-models');
    if (!box) return;
    box.innerHTML = '<div class="empty">در حال بارگذاری...</div>';
    api('/api/user/connections').then(function (data) {
      state.connections = data.connections || [];
      var active = state.connections.filter(function (c) { return c.active; })[0];
      var parts = ['<div class="card"><div class="card-title">مدل فعال</div><div class="card-subtitle">' +
        (active ? esc(active.label + ' — ' + active.model) : 'هیچ مدلی انتخاب نشده') + '</div></div>'];
      parts.push('<div class="card"><div class="card-title">مدل‌های موجود</div>');
      if (state.connections.length === 0) parts.push('<div class="empty">مدلی موجود نیست.</div>');
      else parts.push(state.connections.map(function (c) {
        return '<div class="list-item"><div class="grow"><div class="name">' + esc(c.label) + '</div><div class="meta">' +
          esc(c.provider + ' • ' + c.model) + (c.is_global ? ' • عمومی' : ' • شخصی') + '</div></div>' +
          (c.active ? '<span class="badge ok">فعال</span>' :
            '<button class="btn btn-sm btn-ghost" onclick="window.setActiveConnection(\\'' + c.connection_id + '\\')">فعال کن</button>') + '</div>';
      }).join(''));
      parts.push('</div>');
      if (state.personalAllowed) parts.push('<div class="card"><div class="card-title">مدل شخصی</div>' +
        '<button class="btn" onclick="window.switchSection(\\'personal\\')">مدیریت مدل‌های شخصی</button></div>');
      box.innerHTML = parts.join('');
    }).catch(function (err) { box.innerHTML = '<div class="empty">خطا: ' + esc(err.message) + '</div>'; });
  }

  window.setActiveConnection = function (id) {
    api('/api/user/active-connection', { method: 'POST', body: { connection_id: id } })
      .then(function () { toast('مدل فعال تغییر کرد'); loadModels(); })
      .catch(function (e) { toast('خطا: ' + e.message); });
  };

  function loadRoutes() {
    var box = el('sec-routes');
    if (!box) return;
    box.innerHTML = '<div class="empty">در حال بارگذاری...</div>';
    api('/api/admin/routes').then(function (data) {
      state.routes = data.routes || [];
      var parts = ['<button class="btn" onclick="window.openRouteModal()">+ مسیر جدید</button>'];
      if (state.routes.length === 0) parts.push('<div class="empty">هیچ مسیری ساخته نشده است.</div>');
      parts = parts.concat(state.routes.map(function (r) {
        return '<div class="card"><div class="card-title">' + esc(r.label) + (r.is_default ? '<span class="badge ok">پیش‌فرض</span>' : '') + '</div>' +
          '<div class="card-subtitle">' + esc(r.provider) + ' • ' + r.models.length + ' مدل • ' + r.enabled_token_count + '/' + r.token_count + ' توکن فعال</div>' +
          '<div class="chips">' + r.models.map(function (m) { return '<span class="chip">' + esc(m.model) + (m.is_default ? ' ⭐' : '') + '</span>'; }).join('') + '</div>' +
          '<div class="btn-row"><button class="btn btn-sm btn-ghost" onclick="window.openRouteDetail(\\'' + r.route_id + '\\')">مدیریت</button>' +
          (r.is_default ? '' : '<button class="btn btn-sm btn-ghost" onclick="window.routeAction(\\'' + r.route_id + '\\', \\'default\\', {})">پیش‌فرض</button>') +
          '<button class="btn btn-sm btn-danger" onclick="window.deleteRoute(\\'' + r.route_id + '\\')">حذف</button></div></div>';
      }));
      box.innerHTML = parts.join('');
    }).catch(function (err) { box.innerHTML = '<div class="empty">خطا: ' + esc(err.message) + '</div>'; });
  }

  window.openRouteModal = function () {
    var m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = '<div class="modal"><h2>مسیر جدید</h2>' +
      '<label>عنوان</label><input id="new-route-label" placeholder="OpenAI اصلی">' +
      '<label>ارائه‌دهنده</label><select id="new-route-provider"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select>' +
      '<label>Base URL (اختیاری)</label><input id="new-route-url" placeholder="https://api.openai.com/v1">' +
      '<label>مدل‌ها (با کاما)</label><input id="new-route-models" placeholder="gpt-4o-mini, gpt-4o">' +
      '<div class="btn-row"><button class="btn btn-ghost" onclick="window.closeModal()">انصراف</button>' +
      '<button class="btn" onclick="window.createRoute()">ایجاد</button></div></div>';
    m.addEventListener('click', function (e) { if (e.target === m) window.closeModal(); });
    document.body.appendChild(m);
  };
  window.closeModal = function () { var m = document.querySelector('.modal-backdrop'); if (m) m.remove(); };

  window.createRoute = function () {
    var label = el('new-route-label').value.trim();
    var provider = el('new-route-provider').value;
    var baseUrl = el('new-route-url').value.trim();
    var models = el('new-route-models').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!label || models.length === 0) { toast('عنوان و حداقل یک مدل لازم است'); return; }
    api('/api/admin/routes', { method: 'POST', body: { label: label, provider: provider, base_url: baseUrl, models: models, tokens: [] } })
      .then(function () { window.closeModal(); toast('مسیر ساخته شد'); loadRoutes(); })
      .catch(function (e) { toast('خطا: ' + e.message); });
  };

  window.openRouteDetail = function (routeId) {
    var route = state.routes.filter(function (r) { return r.route_id === routeId; })[0];
    if (!route) return;
    var m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = '<div class="modal"><h2>' + esc(route.label) + '</h2>' +
      '<div class="card-subtitle">' + esc(route.provider) + '</div>' +
      '<div class="card"><div class="card-title">مدل‌ها</div>' +
      (route.models.length ? route.models.map(function (mm) {
        return '<div class="list-item"><div class="grow"><div class="name">' + esc(mm.model) + (mm.is_default ? ' ⭐' : '') + '</div></div>' +
          (mm.is_default ? '' : '<button class="btn btn-sm btn-ghost" onclick="window.routeAction(\\'' + routeId + '\\', \\'model-default\\', {model_id:\\'' + mm.model_id + '\\'})">پیش‌فرض</button>') +
          '<button class="btn btn-sm btn-danger" onclick="window.routeAction(\\'' + routeId + '\\', \\'model-remove\\', {model_id:\\'' + mm.model_id + '\\'})">حذف</button></div>';
      }).join('') : '<div class="empty">مدلی نیست</div>') +
      '</div>' +
      '<div class="card"><div class="card-title">افزودن مدل</div><input id="add-model-input" placeholder="نام مدل">' +
      '<button class="btn btn-sm" onclick="window.routeAction(\\'' + routeId + '\\', \\'model-add\\', {model: el(\\'add-model-input\\').value.trim()})">افزودن</button></div>' +
      '<div class="card"><div class="card-title">توکن‌ها</div><div class="card-subtitle">' + route.enabled_token_count + ' از ' + route.token_count + ' فعال</div>' +
      '<label>افزودن توکن</label><input id="add-token-input" placeholder="کلید API" type="password">' +
      '<button class="btn btn-sm" onclick="window.routeAction(\\'' + routeId + '\\', \\'token-add\\', {api_key: el(\\'add-token-input\\').value.trim()})">افزودن توکن</button></div>' +
      '<button class="btn btn-ghost" onclick="window.closeModal()">بستن</button></div>';
    m.addEventListener('click', function (e) { if (e.target === m) window.closeModal(); });
    document.body.appendChild(m);
  };

  window.routeAction = function (routeId, action, body) {
    api('/api/admin/routes/' + routeId + '/' + action, { method: 'POST', body: body })
      .then(function () {
        toast('انجام شد');
        if (document.querySelector('.modal-backdrop')) window.closeModal();
        loadRoutes();
      })
      .catch(function (e) { toast('خطا: ' + e.message); });
  };
  window.deleteRoute = function (routeId) {
    api('/api/admin/routes/' + routeId, { method: 'DELETE' })
      .then(function () { toast('حذف شد'); loadRoutes(); })
      .catch(function (e) { toast('خطا: ' + e.message); });
  };

  function loadPersonal() {
    var box = el('sec-personal');
    if (!box) return;
    box.innerHTML = '<div class="empty">در حال بارگذاری...</div>';
    api('/api/user/personal-models').then(function (data) {
      state.personal = data.models || [];
      state.personalLimit = data.limit || state.personalLimit;
      var parts = ['<div class="card"><div class="card-title">مدل‌های شخصی</div>' +
        '<div class="card-subtitle">' + state.personal.length + ' از ' + state.personalLimit + ' استفاده شده</div>' +
        '<button class="btn" onclick="window.openPersonalModal()"' + (state.personal.length >= state.personalLimit ? ' disabled' : '') + '>+ افزودن مدل</button></div>'];
      if (state.personal.length === 0) parts.push('<div class="empty">هنوز مدلی اضافه نکرده‌اید.</div>');
      parts = parts.concat(state.personal.map(function (c) {
        return '<div class="card"><div class="card-title">' + esc(c.label) + (c.enabled ? '' : ' <span class="badge">غیرفعال</span>') + '</div>' +
          '<div class="card-subtitle">' + esc(c.provider + ' • ' + c.model) + '</div>' +
          '<button class="btn btn-sm btn-danger" onclick="window.deletePersonal(\\'' + c.connection_id + '\\')">حذف</button></div>';
      }));
      box.innerHTML = parts.join('');
    }).catch(function (err) { box.innerHTML = '<div class="empty">' + (err.message === 'Forbidden' ? 'دسترسی مدل شخصی فعال نیست.' : 'خطا: ' + esc(err.message)) + '</div>'; });
  }

  window.openPersonalModal = function () {
    var m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = '<div class="modal"><h2>مدل شخصی جدید</h2>' +
      '<label>عنوان</label><input id="p-label" placeholder="مدل من">' +
      '<label>ارائه‌دهنده</label><select id="p-provider"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select>' +
      '<label>Base URL (اختیاری)</label><input id="p-url" placeholder="https://api.openai.com/v1">' +
      '<label>مدل</label><input id="p-model" placeholder="gpt-4o-mini">' +
      '<label>کلید API</label><input id="p-key" type="password" placeholder="sk-...">' +
      '<div class="btn-row"><button class="btn btn-ghost" onclick="window.closeModal()">انصراف</button>' +
      '<button class="btn" onclick="window.createPersonal()">ذخیره</button></div></div>';
    m.addEventListener('click', function (e) { if (e.target === m) window.closeModal(); });
    document.body.appendChild(m);
  };

  window.createPersonal = function () {
    var body = {
      label: el('p-label').value.trim(), provider: el('p-provider').value,
      base_url: el('p-url').value.trim(), model: el('p-model').value.trim(),
      api_key: el('p-key').value.trim()
    };
    if (!body.label || !body.model || !body.api_key) { toast('عنوان، مدل و کلید لازم است'); return; }
    api('/api/user/personal-models', { method: 'POST', body: body })
      .then(function () { window.closeModal(); toast('ذخیره شد'); loadPersonal(); })
      .catch(function (e) { toast('خطا: ' + e.message); });
  };

  window.deletePersonal = function (id) {
    api('/api/user/personal-models/' + id, { method: 'DELETE' })
      .then(function () { toast('حذف شد'); loadPersonal(); })
      .catch(function (e) { toast('خطا: ' + e.message); });
  };

  function renderSettings() {
    var box = el('sec-settings');
    if (!box) return;
    box.innerHTML = '<div class="card"><div class="card-title">پروفایل</div>' +
      '<div class="row"><span class="grow">نام</span><span>' + esc(state.user.first_name || '') + '</span></div>' +
      '<div class="row"><span class="grow">شناسه</span><span class="mono">' + esc(state.user.telegram_id) + '</span></div>' +
      '<div class="row"><span class="grow">حالت حافظه</span><span>' + esc(state.user.memory_mode) + '</span></div></div>' +
      '<div class="card"><div class="card-title">حالت کدنویسی</div>' +
      '<div class="row"><span class="grow">فعال</span><label class="switch"><input type="checkbox" id="coding-toggle"' + (state.user.coding_mode ? ' checked' : '') + '><span class="track"><span class="thumb"></span></span></label></div></div>' +
      '<div class="card"><div class="card-title">آمار</div><div id="user-stats">در حال بارگذاری...</div></div>';
    var toggle = el('coding-toggle');
    if (toggle) toggle.addEventListener('change', function () {
      api('/api/user/coding-mode', { method: 'POST', body: { enabled: toggle.checked } })
        .then(function () { state.user.coding_mode = toggle.checked ? 1 : 0; toast('ذخیره شد'); })
        .catch(function (e) { toast('خطا: ' + e.message); });
    });
    api('/api/user/stats').then(function (s) {
      el('user-stats').innerHTML = '<div class="row"><span class="grow">کل پیام‌ها</span><span>' + (s.total || 0) + '</span></div>' +
        '<div class="row"><span class="grow">موفق</span><span>' + (s.success || 0) + '</span></div>' +
        '<div class="row"><span class="grow">ناموفق</span><span>' + (s.fail || 0) + '</span></div>';
    }).catch(function () {});
  }

  function loadAdmin() {
    var box = el('sec-admin');
    if (!box) return;
    box.innerHTML = '<div class="empty">در حال بارگذاری...</div>';
    Promise.all([api('/api/admin/stats'), api('/api/admin/settings')]).then(function (res) {
      state.adminStats = res[0];
      var settings = res[1];
      box.innerHTML = '<div class="stat-grid">' +
        '<div class="stat-card"><div class="stat-value">' + (state.adminStats.users || 0) + '</div><div class="stat-label">کاربران</div></div>' +
        '<div class="stat-card"><div class="stat-value">' + (state.adminStats.chats || 0) + '</div><div class="stat-label">گروه‌ها</div></div>' +
        '<div class="stat-card"><div class="stat-value">' + (state.adminStats.connections || 0) + '</div><div class="stat-label">اتصال‌ها</div></div>' +
        '<div class="stat-card"><div class="stat-value">' + (state.adminStats.requests || 0) + '</div><div class="stat-label">درخواست‌ها</div></div></div>' +
        '<div class="card" style="margin-top:10px"><div class="card-title">تنظیمات سراسری</div>' +
        '<div class="row"><span class="grow">اجازه مدل شخصی</span><label class="switch"><input type="checkbox" id="allow-personal"' + (settings.allow_personal_models ? ' checked' : '') + '><span class="track"><span class="thumb"></span></span></label></div>' +
        '<label>سقف مدل شخصی</label><input id="personal-limit" type="number" min="1" value="' + (settings.personal_model_limit || 5) + '">' +
        '<button class="btn btn-sm" onclick="window.saveAdminSettings()">ذخیره تنظیمات</button></div>' +
        '<div class="card"><div class="card-title">کاربران</div><div id="admin-users">در حال بارگذاری...</div>' +
        '<div class="pager"><button class="btn btn-sm btn-ghost" onclick="window.adminUsersPage(-1)">‹ قبلی</button>' +
        '<span id="admin-page-label">1</span>' +
        '<button class="btn btn-sm btn-ghost" onclick="window.adminUsersPage(1)">بعدی ›</button></div></div>' +
        '<div class="card"><div class="card-title">مسیرها</div><button class="btn" onclick="window.switchSection(\\'routes\\')">مدیریت مسیرها</button></div>';
      loadAdminUsers();
    }).catch(function (err) { box.innerHTML = '<div class="empty">خطا: ' + esc(err.message) + '</div>'; });
  }

  window.saveAdminSettings = function () {
    api('/api/admin/settings', { method: 'POST', body: { allow_personal_models: el('allow-personal').checked, personal_model_limit: parseInt(el('personal-limit').value, 10) || 5 } })
      .then(function (s) { toast('ذخیره شد'); state.personalAllowed = s.allow_personal_models; state.personalLimit = s.personal_model_limit; })
      .catch(function (e) { toast('خطا: ' + e.message); });
  };

  function loadAdminUsers() {
    api('/api/admin/users?page=' + state.adminPage).then(function (data) {
      var users = data.users || [];
      var box = el('admin-users');
      if (!box) return;
      box.innerHTML = users.length === 0 ? '<div class="empty">کاربری نیست</div>' :
        users.map(function (u) {
          return '<div class="list-item"><div class="grow"><div class="name">' + esc(u.first_name || u.username || u.telegram_id) + '</div>' +
            '<div class="meta mono">' + esc(u.telegram_id) + '</div></div></div>';
        }).join('');
      el('admin-page-label').textContent = String(state.adminPage + 1);
    }).catch(function () {});
  }
  window.adminUsersPage = function (delta) { state.adminPage = Math.max(0, state.adminPage + delta); loadAdminUsers(); };
  window.el = el;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();`,

  "styles.css": `:root {
  --bg: var(--tg-theme-bg-color, #1a1a1a);
  --text: var(--tg-theme-text-color, #ffffff);
  --hint: var(--tg-theme-hint-color, #8e8e93);
  --link: var(--tg-theme-link-color, #3a9bdc);
  --accent: var(--tg-theme-button-color, #3a9bdc);
  --accent-text: var(--tg-theme-button-text-color, #ffffff);
  --surface: var(--tg-theme-secondary-bg-color, #2c2c2e);
  --border: rgba(128, 128, 128, 0.22);
  --danger: #ff453a;
  --ok: #32d74b;
  --radius: 14px;
}
body.light { --bg: #ffffff; --text: #000000; --surface: #f4f4f5; --border: rgba(0,0,0,0.12); }
* { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.55; padding-bottom: env(safe-area-inset-bottom); }
.loading { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 16px; color: var(--hint); }
.spinner { width: 36px; height: 36px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.header { background: var(--surface); padding: 14px 16px; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; }
.header h1 { font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.header .sub { font-size: 12px; color: var(--hint); font-weight: 400; }
.icon-btn { width: 38px; height: 38px; border: none; background: transparent; color: var(--text); font-size: 18px; border-radius: 10px; cursor: pointer; }
.icon-btn:active { background: var(--border); }
.tabs { display: flex; gap: 6px; padding: 10px 12px; overflow-x: auto; border-bottom: 1px solid var(--border); position: sticky; top: 57px; z-index: 19; background: var(--bg); }
.tabs::-webkit-scrollbar { display: none; }
.tab { padding: 8px 14px; border: none; background: var(--surface); color: var(--hint); font-size: 14px; white-space: nowrap; cursor: pointer; border-radius: 999px; display: flex; align-items: center; gap: 6px; }
.tab.active { background: var(--accent); color: var(--accent-text); }
.content { padding: 14px 12px 90px; }
.section { display: none; }
.section.active { display: block; animation: fade 0.18s ease; }
@keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.card { background: var(--surface); border-radius: var(--radius); padding: 14px; margin-bottom: 10px; border: 1px solid var(--border); }
.card-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card-subtitle { font-size: 12.5px; color: var(--hint); margin-bottom: 10px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border); }
.row:last-child { border-bottom: none; }
.row .grow { flex: 1; min-width: 0; }
.row .name { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .meta { font-size: 12px; color: var(--hint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--border); color: var(--hint); white-space: nowrap; }
.badge.ok { color: var(--ok); }
.btn { display: block; width: 100%; padding: 12px; border: none; background: var(--accent); color: var(--accent-text); font-size: 15px; font-weight: 500; border-radius: var(--radius); cursor: pointer; margin-top: 10px; }
.btn:active { opacity: 0.85; }
.btn:disabled { opacity: 0.5; }
.btn-sm { padding: 7px 12px; font-size: 13px; width: auto; margin: 0; }
.btn-ghost { background: transparent; color: var(--accent); border: 1px solid var(--border); }
.btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--border); }
.btn-row { display: flex; gap: 8px; margin-top: 10px; }
.btn-row .btn { margin-top: 0; }
input, textarea, select { width: 100%; padding: 11px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 14px; font-family: inherit; margin-top: 8px; }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
label { font-size: 12.5px; color: var(--hint); display: block; margin-top: 10px; }
.stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.stat-card { background: var(--surface); border: 1px solid var(--border); padding: 14px; border-radius: var(--radius); text-align: center; }
.stat-value { font-size: 22px; font-weight: 600; }
.stat-label { font-size: 12px; color: var(--hint); }
.chat { display: flex; flex-direction: column; height: calc(100vh - 180px); }
.chat-log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
.msg { max-width: 84%; padding: 10px 13px; border-radius: 16px; font-size: 14.5px; white-space: pre-wrap; word-break: break-word; }
.msg.user { align-self: flex-start; background: var(--accent); color: var(--accent-text); border-bottom-left-radius: 4px; }
.msg.bot { align-self: flex-end; background: var(--surface); border: 1px solid var(--border); border-bottom-right-radius: 4px; }
.msg.err { align-self: center; color: var(--danger); font-size: 12.5px; }
.chat-input { display: flex; gap: 8px; align-items: flex-end; margin-top: 8px; }
.chat-input textarea { margin-top: 0; resize: none; max-height: 120px; }
.chat-input .btn { width: 52px; height: 44px; margin: 0; padding: 0; font-size: 18px; }
.typing { color: var(--hint); font-size: 13px; }
.empty { text-align: center; padding: 32px 16px; color: var(--hint); font-size: 13.5px; }
.list-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.list-item:last-child { border-bottom: none; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); font-size: 12.5px; }
.switch { position: relative; width: 46px; height: 27px; flex: none; }
.switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.switch .track { position: absolute; inset: 0; background: var(--border); border-radius: 999px; transition: background 0.2s; }
.switch .thumb { position: absolute; top: 3px; right: 3px; width: 21px; height: 21px; border-radius: 50%; background: #fff; transition: transform 0.2s; }
.switch input:checked + .track { background: var(--accent); }
.switch input:checked + .track .thumb { transform: translateX(-19px); }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 10px 16px; border-radius: 999px; font-size: 13px; z-index: 50; box-shadow: 0 6px 24px rgba(0,0,0,0.3); }
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 60; display: flex; align-items: flex-end; }
.modal { background: var(--bg); width: 100%; border-radius: 18px 18px 0 0; padding: 18px 16px calc(18px + env(safe-area-inset-bottom)); max-height: 88vh; overflow-y: auto; }
.modal h2 { font-size: 17px; margin-bottom: 6px; }
.pager { display: flex; justify-content: center; align-items: center; gap: 12px; margin-top: 12px; font-size: 13px; color: var(--hint); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }`
};

export function getStaticAsset(filename) {
  return staticAssets[filename] || null;
}

export function getContentType(filename) {
  if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filename.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/plain';
}
