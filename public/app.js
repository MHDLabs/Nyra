/* ============================================
   Nyra AI — Telegram Mini App
   BlackHole UI, wired to the Worker's real /api surface.
   ============================================ */
(function () {
  'use strict';

  // --- GLOBAL STATE & UTILS ------------------------------------------------
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
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2500);
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    headers['X-Init-Data'] = tg ? tg.initData : '';
    if (opts.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined
        ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
        : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  // --- INITIALIZATION ------------------------------------------------------
  function init() {
    if (tg) { tg.ready(); tg.expand(); }
    loadTheme();
    initStarfield();
    initBlackHole();

    var initData = tg ? tg.initData : '';
    if (!initData) {
      el('loading').innerHTML = '<div style="color:var(--danger)">⚠️ این برنامه فقط داخل تلگرام کار می‌کند</div>';
      return;
    }

    api('/api/auth', { method: 'POST', body: { initData: initData }, headers: { 'X-Init-Data': '' } })
      .then(function (data) {
        state.user = data.user;
        state.isAdmin = !!data.isAdmin;
        state.personalAllowed = !!data.personal_models_allowed;
        state.personalLimit = data.personal_model_limit || 5;

        var nameEl = el('user-name');
        if (nameEl) nameEl.textContent = state.user && state.user.first_name ? state.user.first_name : '';

        el('loading').classList.add('hidden');
        el('shell').classList.remove('hidden');

        renderTabs();
        switchSection('chat');
      })
      .catch(function (err) {
        el('loading').innerHTML = '<div style="color:var(--danger)">خطا در اتصال: ' + esc(err.message) + '</div>';
      });
  }

  function loadTheme() {
    var light = localStorage.getItem('nyra-theme') === 'light';
    document.body.classList.toggle('light', light);
    var b = el('theme-btn');
    if (b) b.textContent = light ? '🌙' : '☀️';
  }

  window.toggleTheme = function () {
    var light = document.body.classList.toggle('light');
    localStorage.setItem('nyra-theme', light ? 'light' : 'dark');
    var b = el('theme-btn');
    if (b) b.textContent = light ? '🌙' : '☀️';
    toast(light ? 'تم روشن' : 'تم تاریک');
  };

  // --- NAVIGATION ----------------------------------------------------------
  function getTabs() {
    var tabs = [{ id: 'chat', label: '💬 گفتگو' }, { id: 'models', label: '🔑 مدل‌ها' }];
    if (state.isAdmin) tabs.push({ id: 'routes', label: '🧭 مسیرها' });
    if (state.personalAllowed && !state.isAdmin) tabs.push({ id: 'personal', label: '🧩 شخصی' });
    tabs.push({ id: 'settings', label: '⚙️ تنظیمات' });
    if (state.isAdmin) tabs.push({ id: 'admin', label: '🛠 مدیریت' });
    return tabs;
  }

  function renderTabs() {
    var container = el('tabs-container');
    if (!container) return;
    container.innerHTML = getTabs().map(function (t) {
      return '<button class="tab' + (t.id === state.section ? ' active' : '') +
        '" data-tab="' + t.id + '" onclick="window.switchSection(\'' + t.id + '\')">' + t.label + '</button>';
    }).join('');
  }

  window.switchSection = function (sec) {
    state.section = sec;
    Array.prototype.forEach.call(document.querySelectorAll('.section'), function (s) { s.classList.remove('active'); });
    var target = el('sec-' + sec);
    if (target) target.classList.add('active');
    renderTabs();

    if (sec === 'chat') { renderChat(); bindChatBox(); }
    else if (sec === 'models') loadModels();
    else if (sec === 'routes') loadRoutes();
    else if (sec === 'personal') loadPersonal();
    else if (sec === 'settings') renderSettings();
    else if (sec === 'admin') loadAdmin();
  };

  // --- CHAT LOGIC ----------------------------------------------------------
  function renderChat() {
    var log = el('chat-log');
    var welcome = el('welcome-screen');
    if (!log || !welcome) return;

    if (state.chat.length === 0) {
      log.classList.add('hidden');
      welcome.classList.remove('hidden');
    } else {
      welcome.classList.add('hidden');
      log.classList.remove('hidden');
      renderChatLog();
    }
  }

  function renderChatLog() {
    var log = el('chat-log');
    if (!log) return;
    log.innerHTML = state.chat.map(function (m) {
      if (m.role === 'pending') return '<div class="typing-indicator"><span></span><span></span><span></span></div>';
      if (m.role === 'error') return '<div class="msg err">' + esc(m.text) + '</div>';
      return '<div class="msg ' + (m.role === 'user' ? 'user' : 'bot') + '">' +
        esc(m.text).replace(/\n/g, '<br>') + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  function bindChatBox() {
    var ta = el('chat-input');
    var sendBtn = el('send-btn');
    if (!ta || !sendBtn || ta._bound) return;
    ta._bound = true;

    ta.addEventListener('input', function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
      sendBtn.disabled = !ta.value.trim();
    });

    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.sendMessage(); }
    });

    sendBtn.addEventListener('click', window.sendMessage);

    Array.prototype.forEach.call(document.querySelectorAll('.chip[data-msg]'), function (c) {
      if (c._bound) return;
      c._bound = true;
      c.addEventListener('click', function () {
        ta.value = c.getAttribute('data-msg');
        ta.dispatchEvent(new Event('input'));
        window.sendMessage();
      });
    });
  }

  window.sendMessage = function () {
    var ta = el('chat-input');
    var sendBtn = el('send-btn');
    if (!ta || !sendBtn) return;

    var text = ta.value.trim();
    if (!text) return;

    ta.value = ''; ta.style.height = 'auto'; sendBtn.disabled = true;
    state.chat.push({ role: 'user', text: text });
    state.chat.push({ role: 'pending', text: '' });
    renderChat();

    api('/api/chat', { method: 'POST', body: { message: text } })
      .then(function (res) {
        state.chat = state.chat.filter(function (m) { return m.role !== 'pending'; });
        state.chat.push({ role: 'bot', text: res.response });
      })
      .catch(function (err) {
        state.chat = state.chat.filter(function (m) { return m.role !== 'pending'; });
        state.chat.push({ role: 'error', text: 'خطا: ' + err.message });
      })
      .then(function () {
        renderChatLog();
        sendBtn.disabled = !ta.value.trim();
      });
  };

  // --- MODELS & PERSONAL ---------------------------------------------------
  function loadModels() {
    var box = el('sec-models');
    if (!box) return;
    box.innerHTML = '<div class="empty">در حال دریافت لیست مدل‌ها...</div>';

    api('/api/user/connections').then(function (data) {
      state.connections = data.connections || [];
      var active = state.connections.filter(function (c) { return c.active; })[0];

      var html = '<div class="card"><div class="card-title">مدل فعال فعلی</div>' +
        '<div class="card-sub">' + (active ? esc(active.label + ' — ' + active.model) : 'هیچ مدلی انتخاب نشده') + '</div></div>';
      html += '<div class="card"><div class="card-title">مدل‌های موجود</div>';

      if (!state.connections.length) html += '<div class="empty">مدلی یافت نشد</div>';
      else html += state.connections.map(function (c) {
        return '<div class="row"><div class="grow">' +
          '<div class="name">' + esc(c.label) + '</div>' +
          '<div class="meta mono">' + esc(c.provider) + ' • ' + esc(c.model) + (c.is_global ? ' • عمومی' : ' • شخصی') + '</div>' +
          '</div>' +
          (c.active
            ? '<span class="badge ok">فعال</span>'
            : '<button class="btn-ghost" onclick="window.setActiveModel(\'' + c.connection_id + '\')">انتخاب</button>') +
          '</div>';
      }).join('');

      html += '</div>';
      if (state.personalAllowed) {
        html += '<div class="card"><div class="card-title">مدل شخصی</div>' +
          '<button class="btn" onclick="window.switchSection(\'personal\')">مدیریت مدل‌های شخصی</button></div>';
      }
      box.innerHTML = html;
    }).catch(function (e) { box.innerHTML = '<div class="empty" style="color:var(--danger)">' + esc(e.message) + '</div>'; });
  }

  window.setActiveModel = function (id) {
    api('/api/user/active-connection', { method: 'POST', body: { connection_id: id } })
      .then(function () { toast('مدل تغییر کرد'); loadModels(); })
      .catch(function (e) { toast('خطا: ' + e.message); });
  };

  function loadPersonal() {
    var box = el('sec-personal');
    if (!box) return;
    box.innerHTML = '<div class="empty">در حال بارگذاری...</div>';

    api('/api/user/personal-models').then(function (data) {
      state.personal = data.models || [];
      state.personalLimit = data.limit || state.personalLimit;

      var html = '<div class="card"><div class="card-title">مدل‌های شخصی (' + state.personal.length + '/' + state.personalLimit + ')</div>' +
        '<button class="btn" onclick="window.openPersonalModal()"' +
        (state.personal.length >= state.personalLimit ? ' disabled' : '') + '>+ افزودن مدل جدید</button></div>';

      if (!state.personal.length) html += '<div class="empty">هنوز مدلی اضافه نکرده‌اید</div>';
      else html += state.personal.map(function (m) {
        return '<div class="card">' +
          '<div class="card-title">' + esc(m.label) + (m.enabled ? '' : ' <span class="badge">غیرفعال</span>') + '</div>' +
          '<div class="card-sub mono">' + esc(m.provider) + ' • ' + esc(m.model) + '</div>' +
          '<button class="btn-danger" onclick="window.deletePersonal(\'' + m.connection_id + '\')">حذف</button></div>';
      }).join('');

      box.innerHTML = html;
    }).catch(function (e) {
      box.innerHTML = '<div class="empty">' + (e.message === 'Forbidden' ? 'دسترسی مدل شخصی فعال نیست' : esc(e.message)) + '</div>';
    });
  }

  window.openPersonalModal = function () {
    var m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = '<div class="modal">' +
      '<h2 style="margin-bottom:16px">افزودن مدل شخصی</h2>' +
      '<label>عنوان</label><input id="p-label" placeholder="مثلا GPT-4 من">' +
      '<label>Provider</label><select id="p-provider"><option value="openai">OpenAI Compatible</option><option value="anthropic">Anthropic</option></select>' +
      '<label>Base URL</label><input id="p-url" placeholder="https://api.openai.com/v1">' +
      '<label>Model Name</label><input id="p-model" placeholder="gpt-4o">' +
      '<label>API Key</label><input id="p-key" type="password" placeholder="sk-...">' +
      '<div style="display:flex;gap:10px;margin-top:20px">' +
      '<button class="btn" onclick="window.createPersonal()">ذخیره</button>' +
      '<button class="btn-ghost" style="flex:1" onclick="window.closeModal()">انصراف</button>' +
      '</div></div>';
    m.addEventListener('click', function (e) { if (e.target === m) window.closeModal(); });
    document.body.appendChild(m);
  };

  window.closeModal = function () {
    var m = document.querySelector('.modal-backdrop');
    if (m) m.remove();
  };

  window.createPersonal = function () {
    var body = {
      label: el('p-label').value.trim(),
      provider: el('p-provider').value,
      base_url: el('p-url').value.trim(),
      model: el('p-model').value.trim(),
      api_key: el('p-key').value.trim()
    };
    if (!body.label || !body.model || !body.api_key) { toast('فیلدهای ضروری را پر کنید'); return; }
    api('/api/user/personal-models', { method: 'POST', body: body })
      .then(function () { window.closeModal(); toast('مدل اضافه شد'); loadPersonal(); })
      .catch(function (e) { toast(e.message); });
  };

  window.deletePersonal = function (id) {
    if (!window.confirm('آیا مطمئن هستید؟')) return;
    api('/api/user/personal-models/' + id, { method: 'DELETE' })
      .then(function () { toast('حذف شد'); loadPersonal(); })
      .catch(function (e) { toast(e.message); });
  };

  // --- ROUTES (ADMIN) ------------------------------------------------------
  function loadRoutes() {
    var box = el('sec-routes');
    if (!box) return;
    box.innerHTML = '<div class="empty">در حال بارگذاری مسیرها...</div>';

    api('/api/admin/routes').then(function (data) {
      state.routes = data.routes || [];
      var html = '<button class="btn" onclick="window.openRouteModal()">+ مسیر جدید</button><br><br>';
      if (!state.routes.length) html += '<div class="empty">مسیری تعریف نشده</div>';
      else html += state.routes.map(function (r) {
        var models = r.models || [];
        return '<div class="card">' +
          '<div class="card-title">' + esc(r.label) + (r.is_default ? '<span class="badge ok">پیش‌فرض</span>' : '') + '</div>' +
          '<div class="card-sub mono">' + esc(r.provider) + ' • ' + models.length + ' مدل • ' +
            r.enabled_token_count + '/' + r.token_count + ' توکن فعال</div>' +
          '<div class="chips" style="justify-content:flex-start;margin-bottom:8px">' +
            models.map(function (mm) { return '<span class="chip">' + esc(mm.model) + (mm.is_default ? ' ⭐' : '') + '</span>'; }).join('') +
          '</div>' +
          '<div class="btn-row">' +
            '<button class="btn-ghost" onclick="window.openRouteDetail(\'' + r.route_id + '\')">مدیریت</button>' +
            (r.is_default ? '' : '<button class="btn-ghost" onclick="window.routeAction(\'' + r.route_id + '\', \'default\', {})">پیش‌فرض</button>') +
            '<button class="btn-danger" onclick="window.deleteRoute(\'' + r.route_id + '\')">حذف</button>' +
          '</div></div>';
      });
      box.innerHTML = html;
    }).catch(function (e) { box.innerHTML = '<div class="empty" style="color:var(--danger)">' + esc(e.message) + '</div>'; });
  }

  window.openRouteModal = function () {
    var m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = '<div class="modal"><h2>مسیر جدید</h2>' +
      '<label>عنوان</label><input id="new-route-label" placeholder="OpenAI اصلی">' +
      '<label>ارائه‌دهنده</label><select id="new-route-provider"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option></select>' +
      '<label>Base URL (اختیاری)</label><input id="new-route-url" placeholder="https://api.openai.com/v1">' +
      '<label>مدل‌ها (با کاما)</label><input id="new-route-models" placeholder="gpt-4o-mini, gpt-4o">' +
      '<div class="btn-row"><button class="btn-ghost" onclick="window.closeModal()">انصراف</button>' +
      '<button class="btn" onclick="window.createRoute()">ایجاد</button></div></div>';
    m.addEventListener('click', function (e) { if (e.target === m) window.closeModal(); });
    document.body.appendChild(m);
  };

  window.createRoute = function () {
    var label = el('new-route-label').value.trim();
    var provider = el('new-route-provider').value;
    var baseUrl = el('new-route-url').value.trim();
    var models = el('new-route-models').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!label || !models.length) { toast('عنوان و حداقل یک مدل لازم است'); return; }
    api('/api/admin/routes', { method: 'POST', body: { label: label, provider: provider, base_url: baseUrl, models: models, tokens: [] } })
      .then(function () { window.closeModal(); toast('مسیر ساخته شد'); loadRoutes(); })
      .catch(function (e) { toast('خطا: ' + e.message); });
  };

  window.openRouteDetail = function (routeId) {
    var route = state.routes.filter(function (r) { return r.route_id === routeId; })[0];
    if (!route) return;
    var models = route.models || [];
    var m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = '<div class="modal"><h2>' + esc(route.label) + '</h2>' +
      '<div class="card-sub">' + esc(route.provider) + '</div>' +
      '<div class="card"><div class="card-title">مدل‌ها</div>' +
      (models.length ? models.map(function (mm) {
        return '<div class="row"><div class="grow"><div class="name">' + esc(mm.model) + (mm.is_default ? ' ⭐' : '') + '</div></div>' +
          (mm.is_default ? '' : '<button class="btn-ghost" onclick="window.routeAction(\'' + routeId + '\', \'model-default\', {model_id:\'' + mm.model_id + '\'})">پیش‌فرض</button>') +
          '<button class="btn-danger" onclick="window.routeAction(\'' + routeId + '\', \'model-remove\', {model_id:\'' + mm.model_id + '\'})">حذف</button></div>';
      }).join('') : '<div class="empty">مدلی نیست</div>') +
      '</div>' +
      '<div class="card"><div class="card-title">افزودن مدل</div><input id="add-model-input" placeholder="نام مدل">' +
      '<button class="btn" onclick="window.routeAction(\'' + routeId + '\', \'model-add\', {model: el(\'add-model-input\').value.trim()})">افزودن</button></div>' +
      '<div class="card"><div class="card-title">توکن‌ها</div>' +
      '<div class="card-sub">' + route.enabled_token_count + ' از ' + route.token_count + ' فعال</div>' +
      '<label>افزودن توکن</label><input id="add-token-input" type="password" placeholder="کلید API">' +
      '<button class="btn" onclick="window.routeAction(\'' + routeId + '\', \'token-add\', {api_key: el(\'add-token-input\').value.trim()})">افزودن توکن</button></div>' +
      '<button class="btn-ghost" style="width:100%;padding:12px" onclick="window.closeModal()">بستن</button></div>';
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
    if (!window.confirm('مسیر حذف شود؟')) return;
    api('/api/admin/routes/' + routeId, { method: 'DELETE' })
      .then(function () { toast('حذف شد'); loadRoutes(); })
      .catch(function (e) { toast('خطا: ' + e.message); });
  };

  // --- SETTINGS & ADMIN ----------------------------------------------------
  function renderSettings() {
    var box = el('sec-settings');
    var u = state.user || {};
    if (!box) return;
    box.innerHTML = '<div class="card"><div class="card-title">پروفایل کاربری</div>' +
      '<div class="row"><span class="grow">نام</span><span>' + esc(u.first_name) + '</span></div>' +
      '<div class="row"><span class="grow">ID تلگرام</span><span class="mono">' + esc(u.telegram_id) + '</span></div>' +
      '<div class="row"><span class="grow">حالت حافظه</span><span>' + esc(u.memory_mode) + '</span></div></div>' +
      '<div class="card"><div class="card-title">حالت توسعه‌دهنده</div>' +
      '<div class="row"><span class="grow">فعال‌سازی Coding Mode</span>' +
      '<label class="switch"><input type="checkbox" id="coding-toggle"' + (u.coding_mode ? ' checked' : '') +
      '><span class="slider"></span></label></div></div>' +
      '<div class="card"><div class="card-title">آمار</div><div id="user-stats"><div class="empty">در حال بارگذاری...</div></div></div>';

    var toggle = el('coding-toggle');
    if (toggle) toggle.addEventListener('change', function () {
      api('/api/user/coding-mode', { method: 'POST', body: { enabled: toggle.checked } })
        .then(function () { state.user.coding_mode = toggle.checked ? 1 : 0; toast('ذخیره شد'); })
        .catch(function (err) { toast('خطا: ' + err.message); toggle.checked = !toggle.checked; });
    });

    api('/api/user/stats').then(function (s) {
      var host = el('user-stats');
      if (!host) return;
      host.innerHTML = '<div class="row"><span class="grow">کل پیام‌ها</span><span>' + (s.total || 0) + '</span></div>' +
        '<div class="row"><span class="grow">موفق</span><span>' + (s.success || 0) + '</span></div>' +
        '<div class="row"><span class="grow">ناموفق</span><span>' + (s.fail || 0) + '</span></div>';
    }).catch(function () {});
  }

  function loadAdmin() {
    var box = el('sec-admin');
    if (!box) return;
    box.innerHTML = '<div class="empty">در حال دریافت آمار...</div>';

    Promise.all([api('/api/admin/stats'), api('/api/admin/settings')]).then(function (res) {
      state.adminStats = res[0];
      var settings = res[1];
      box.innerHTML =
        '<div class="stat-grid">' +
          '<div class="stat-card"><div class="stat-val">' + (state.adminStats.users || 0) + '</div><div class="stat-lbl">کاربران</div></div>' +
          '<div class="stat-card"><div class="stat-val">' + (state.adminStats.requests || 0) + '</div><div class="stat-lbl">درخواست‌ها</div></div>' +
          '<div class="stat-card"><div class="stat-val">' + (state.adminStats.chats || 0) + '</div><div class="stat-lbl">گروه‌ها</div></div>' +
          '<div class="stat-card"><div class="stat-val">' + (state.adminStats.connections || 0) + '</div><div class="stat-lbl">اتصال‌ها</div></div>' +
        '</div>' +
        '<div class="card"><div class="card-title">تنظیمات جهانی</div>' +
          '<div class="row"><span class="grow">اجازه مدل شخصی</span>' +
          '<label class="switch"><input type="checkbox" id="adm-pers"' + (settings.allow_personal_models ? ' checked' : '') +
          '><span class="slider"></span></label></div>' +
          '<label>سقف مدل شخصی</label>' +
          '<input type="number" id="adm-limit" min="1" value="' + (settings.personal_model_limit || 5) + '">' +
          '<button class="btn" onclick="window.saveAdminSettings()">ذخیره تنظیمات</button>' +
        '</div>' +
        '<div class="card"><div class="card-title">کاربران</div><div id="admin-users"><div class="empty">در حال بارگذاری...</div></div>' +
          '<div class="pager">' +
            '<button class="btn-ghost" onclick="window.adminUsersPage(-1)">‹ قبلی</button>' +
            '<span id="admin-page-label">1</span>' +
            '<button class="btn-ghost" onclick="window.adminUsersPage(1)">بعدی ›</button>' +
          '</div></div>' +
        '<div class="card"><div class="card-title">مسیرها</div>' +
          '<button class="btn" onclick="window.switchSection(\'routes\')">مدیریت مسیرها</button></div>';
      loadAdminUsers();
    }).catch(function (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  window.saveAdminSettings = function () {
    api('/api/admin/settings', {
      method: 'POST',
      body: {
        allow_personal_models: el('adm-pers').checked,
        personal_model_limit: parseInt(el('adm-limit').value, 10) || 5
      }
    }).then(function (s) {
      toast('تنظیمات ذخیره شد');
      state.personalAllowed = s.allow_personal_models;
      state.personalLimit = s.personal_model_limit;
    }).catch(function (e) { toast(e.message); });
  };

  function loadAdminUsers() {
    api('/api/admin/users?page=' + state.adminPage).then(function (data) {
      var users = data.users || [];
      var box = el('admin-users');
      if (!box) return;
      box.innerHTML = users.length === 0 ? '<div class="empty">کاربری نیست</div>' :
        users.map(function (u) {
          return '<div class="row"><div class="grow">' +
            '<div class="name">' + esc(u.first_name || u.username || u.telegram_id) + '</div>' +
            '<div class="meta mono">' + esc(u.telegram_id) + '</div></div></div>';
        }).join('');
      var label = el('admin-page-label');
      if (label) label.textContent = String(state.adminPage + 1);
    }).catch(function () {});
  }

  window.adminUsersPage = function (delta) {
    state.adminPage = Math.max(0, state.adminPage + delta);
    loadAdminUsers();
  };

  // Inline `onclick` attributes run in the global scope, so the DOM helper the
  // route-detail modal uses (`el('add-model-input')`) must be reachable there.
  window.el = el;

  // --- VISUALS: STARFIELD & BLACK HOLE -------------------------------------
  function initStarfield() {
    var cvs = el('space-canvas');
    if (!cvs) return;
    var ctx = cvs.getContext('2d');
    var stars = [];
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      cvs.width = window.innerWidth;
      cvs.height = window.innerHeight;
      stars = [];
      for (var i = 0; i < 80; i++) {
        stars.push({
          x: Math.random() * cvs.width, y: Math.random() * cvs.height,
          s: Math.random() * 1.5, o: Math.random(), sp: Math.random() * 0.02
        });
      }
    }
    window.addEventListener('resize', resize);
    resize();

    var rgb = [200, 200, 255];
    (function anim() {
      ctx.clearRect(0, 0, cvs.width, cvs.height);
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        s.o += s.sp;
        var a = Math.abs(Math.sin(s.o)) * 0.8;
        ctx.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';
        ctx.beginPath(); ctx.arc(s.x, s.y, s.s, 0, Math.PI * 2); ctx.fill();
      }
      if (!reduce && !document.hidden) requestAnimationFrame(anim);
      else if (!reduce) setTimeout(anim, 400);
    })();
  }

  function initBlackHole() {
    var cvs = el('blackhole-canvas');
    if (!cvs) return;
    var ctx = cvs.getContext('2d');
    var size = 260;
    cvs.width = size * 2; cvs.height = size * 2;
    ctx.scale(2, 2);
    var c = size / 2;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var particles = [];
    for (var i = 0; i < 120; i++) {
      var r = 45 + Math.random() * 60;
      var t = (r - 45) / 60;
      var col = t < 0.3 ? 'hsla(220,90%,75%,' : t < 0.6 ? 'hsla(280,85%,65%,' : 'hsla(20,95%,55%,';
      particles.push({
        a: Math.random() * Math.PI * 2, r: r, br: r,
        sp: 0.01 + Math.random() * 0.015, s: 0.5 + Math.random() * 2,
        col: col, op: 0.5 + Math.random() * 0.5
      });
    }

    function frame() {
      ctx.clearRect(0, 0, size, size);

      // Accretion glow
      var g = ctx.createRadialGradient(c, c, 30, c, c, 120);
      g.addColorStop(0, 'rgba(124,92,255,0.1)');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(c, c, 120, 0, Math.PI * 2); ctx.fill();

      // Orbiting particles
      particles.sort(function (a, b) {
        return (Math.sin(a.a) * a.r) - (Math.sin(b.a) * b.r);
      });
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.a += p.sp;
        var wob = p.br + Math.sin(p.a * 3) * 3;
        var x = c + Math.cos(p.a) * wob;
        var y = c + Math.sin(p.a) * wob * 0.35; // flattened disc
        var depth = (Math.sin(p.a) + 1) / 2;
        var alpha = p.op * (0.4 + depth * 0.6);
        ctx.fillStyle = p.col + alpha + ')';
        ctx.beginPath(); ctx.arc(x, y, p.s * (0.6 + depth * 0.6), 0, Math.PI * 2); ctx.fill();
      }

      // Event horizon
      var h = ctx.createRadialGradient(c, c, 0, c, c, 30);
      h.addColorStop(0, '#000');
      h.addColorStop(0.8, '#050508');
      h.addColorStop(1, '#0a0a12');
      ctx.fillStyle = h;
      ctx.beginPath(); ctx.arc(c, c, 30, 0, Math.PI * 2); ctx.fill();

      // Photon ring
      ctx.strokeStyle = 'rgba(200,180,255,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(c, c, 32, 0, Math.PI * 2); ctx.stroke();
    }

    (function loop() {
      frame();
      if (!reduce) requestAnimationFrame(loop);
    })();
  }

  // --- BOOT ----------------------------------------------------------------
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
