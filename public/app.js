/* ============================================
   Nyra AI — Telegram Mini App
   Management interface (no chat UI).
   ============================================ */
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  var state = {
    user: null, isAdmin: false, section: 'models',
    i18n: {}, locale: 'en-US', dir: 'ltr',
    connections: [], routes: [], personalities: null
  };

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function t(key, params) {
    var msg = state.i18n[key] || key;
    if (!params) return msg;
    return msg.replace(/\{(\w+)\}/g, function (m, name) {
      return params[name] !== undefined ? String(params[name]) : m;
    });
  }

  function toast(msg) {
    var toastEl = el('toast');
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2500);
  }

  function ApiError(status, message) {
    var e = new Error(message || ('HTTP ' + status));
    e.status = status;
    return e;
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
      return r.text().catch(function () { return ''; }).then(function (raw) {
        var data = {};
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = { error: raw.slice(0, 200) }; } }
        if (!r.ok) throw ApiError(r.status, data.error);
        return data;
      });
    });
  }

  function errorHtml(err) {
    var msg = err && err.message ? err.message : t('error.server');
    var hint = '';
    if (err && err.status === 401) hint = '<br><button class="btn-ghost" style="margin-top:12px" onclick="window.location.reload()">' + t('action.retry') + '</button>';
    else if (err && err.status === 403) hint = '<br><span style="font-size:12px">' + t('error.forbidden') + '</span>';
    else if (err && err.status === 404) hint = '<br><span style="font-size:12px">' + t('error.not_found') + '</span>';
    return '<div class="empty" style="color:var(--danger)">' + esc(msg) + hint + '</div>';
  }

  // --- INITIALIZATION ------------------------------------------------------
  function init() {
    if (tg) { tg.ready(); tg.expand(); }
    loadTheme();
    initStarfield();

    var initData = tg ? tg.initData : '';
    if (!initData) {
      el('loading').innerHTML = '<div style="color:var(--danger)">⚠️ This app only works inside Telegram</div>';
      return;
    }

    api('/api/auth', { method: 'POST', body: { initData: initData }, headers: { 'X-Init-Data': '' } })
      .then(function (data) {
        state.user = data.user;
        state.isAdmin = !!data.isAdmin;
        return api('/api/i18n');
      })
      .then(function (i18nData) {
        state.locale = i18nData.locale || 'en-US';
        state.dir = i18nData.dir || 'ltr';
        state.i18n = i18nData.strings || {};

        document.documentElement.lang = state.locale;
        document.documentElement.dir = state.dir;

        var nameEl = el('user-name');
        if (nameEl && state.user && state.user.first_name) nameEl.textContent = state.user.first_name;

        var loadingText = el('loading-text');
        if (loadingText) loadingText.textContent = t('state.loading');

        el('loading').classList.add('hidden');
        el('shell').classList.remove('hidden');

        renderTabs();
        switchSection('models');
      })
      .catch(function (err) {
        el('loading').innerHTML = '<div style="color:var(--danger)">' + esc(err.message || 'Failed to load') + '</div>';
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
    toast(t(light ? 'toast.theme_light' : 'toast.theme_dark'));
  };

  window.toggleLanguage = function () {
    var newLocale = state.locale === 'en-US' ? 'fa-IR' : 'en-US';
    api('/api/user/locale', { method: 'POST', body: { locale: newLocale } })
      .then(function (data) {
        state.locale = data.locale;
        state.dir = data.dir;
        state.i18n = data.strings || {};
        document.documentElement.lang = state.locale;
        document.documentElement.dir = state.dir;
        toast(t('toast.language_changed'));
        renderTabs();
        switchSection(state.section);
      })
      .catch(function (err) { toast(err.message); });
  };

  // --- NAVIGATION ----------------------------------------------------------
  function getTabs() {
    var tabs = [
      { id: 'models', label: t('nav.models') },
      { id: 'preferences', label: t('nav.preferences') }
    ];
    if (state.isAdmin) {
      tabs.push({ id: 'routing', label: t('nav.routing') });
      tabs.push({ id: 'usage', label: t('nav.usage') });
      tabs.push({ id: 'admin', label: t('nav.admin') });
    }
    return tabs;
  }

  function renderTabs() {
    var container = el('tabs-container');
    if (!container) return;
    container.innerHTML = getTabs().map(function (tab) {
      return '<button class="tab' + (tab.id === state.section ? ' active' : '') +
        '" data-tab="' + tab.id + '" onclick="window.switchSection(\'' + tab.id + '\')">' + esc(tab.label) + '</button>';
    }).join('');
  }

  window.switchSection = function (sec) {
    state.section = sec;
    Array.prototype.forEach.call(document.querySelectorAll('.section'), function (s) { s.classList.remove('active'); });
    var target = el('sec-' + sec);
    if (target) target.classList.add('active');
    renderTabs();

    if (sec === 'models') loadModels();
    else if (sec === 'routing') loadRouting();
    else if (sec === 'preferences') renderPreferences();
    else if (sec === 'usage') loadUsage();
    else if (sec === 'admin') loadAdmin();
  };

  // --- MODELS & CONNECTIONS ------------------------------------------------
  function loadModels() {
    var box = el('sec-models');
    if (!box) return;
    box.innerHTML = '<div class="empty">' + t('models.loading') + '</div>';

    api('/api/user/connections').then(function (data) {
      state.connections = data.connections || [];
      var active = state.connections.filter(function (c) { return c.active; })[0];

      var html = '<div class="card"><div class="card-title">' + t('models.active_model') + '</div>' +
        '<div class="card-sub">' + (active ? esc(active.label + ' — ' + active.model) : t('models.no_active_model')) + '</div></div>';

      html += '<div class="card"><div class="card-title">' + t('models.title') + '</div>';
      if (!state.connections.length) html += '<div class="empty">' + t('models.empty') + '</div>';
      else html += state.connections.map(function (c) {
        var caps = [];
        if (c.is_fast) caps.push('Fast');
        if (c.supports_vision) caps.push('Vision');
        return '<div class="row"><div class="grow">' +
          '<div class="name">' + esc(c.label) + '</div>' +
          '<div class="meta mono">' + esc(c.provider) + ' • ' + esc(c.model) +
            (c.is_global ? ' • ' + t('models.shared') : ' • ' + t('models.personal')) +
            (caps.length ? ' • ' + caps.join('/') : '') + '</div>' +
          '</div>' +
          (c.active
            ? '<span class="badge ok">' + t('status.enabled') + '</span>'
            : '<button class="btn-ghost" onclick="window.setActiveModel(\'' + esc(c.connection_id) + '\')">' + t('action.select') + '</button>') +
          '</div>';
      }).join('');
      html += '</div>';

      if (!state.isAdmin) {
        html += '<div class="card"><button class="btn" onclick="window.openPersonalModal()">' + t('models.add_connection') + '</button></div>';
      }
      box.innerHTML = html;
    }).catch(function (e) { box.innerHTML = errorHtml(e); });
  }

  window.setActiveModel = function (id) {
    api('/api/user/active-connection', { method: 'POST', body: { connection_id: id } })
      .then(function () { toast(t('toast.saved')); loadModels(); })
      .catch(function (e) { toast(e.message); });
  };

  window.openPersonalModal = function () {
    var m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = '<div class="modal">' +
      '<h2 style="margin-bottom:16px">' + t('models.add_connection') + '</h2>' +
      '<label>' + t('models.label') + '</label><input id="p-label" placeholder="My GPT-4">' +
      '<label>' + t('models.provider') + '</label><select id="p-provider">' +
        '<option value="openai-compatible">OpenAI Compatible</option>' +
        '<option value="anthropic">Anthropic</option></select>' +
      '<label>' + t('models.base_url') + '</label><input id="p-url" placeholder="https://api.openai.com/v1">' +
      '<label>' + t('models.model_id') + '</label><input id="p-model" placeholder="gpt-4o">' +
      '<label>' + t('models.api_key') + '</label><input id="p-key" type="password" placeholder="sk-...">' +
      '<div class="card-sub" style="margin-top:8px">' + t('models.test_hint') + '</div>' +
      '<div style="display:flex;gap:10px;margin-top:20px">' +
      '<button class="btn" onclick="window.createPersonal()">' + t('action.save') + '</button>' +
      '<button class="btn-ghost" style="flex:1" onclick="window.closeModal()">' + t('action.cancel') + '</button>' +
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
    if (!body.label || !body.model || !body.api_key) {
      toast(t('models.label_required'));
      return;
    }
    api('/api/user/personal-models', { method: 'POST', body: body })
      .then(function () { window.closeModal(); toast(t('models.created')); loadModels(); })
      .catch(function (e) { toast(e.message); });
  };


  // --- ROUTING (ADMIN) -----------------------------------------------------
  function loadRouting() {
    var box = el('sec-routing');
    if (!box) return;
    box.innerHTML = '<div class="empty">' + t('state.loading') + '</div>';

    api('/api/admin/routes').then(function (data) {
      state.routes = data.routes || [];
      var html = '<div class="card"><div class="card-title">' + t('routing.title') + '</div>' +
        '<div class="card-sub">' + t('routing.subtitle') + '</div>' +
        '<button class="btn" onclick="window.openRouteModal()">' + t('routing.add_profile') + '</button></div>';

      if (!state.routes.length) html += '<div class="empty">' + t('routing.empty') + '</div>';
      else html += state.routes.map(function (r) {
        var models = r.models || [];
        return '<div class="card">' +
          '<div class="card-title">' + esc(r.label) + (r.is_default ? '<span class="badge ok">' + t('routing.default') + '</span>' : '') + '</div>' +
          '<div class="card-sub mono">' + esc(r.provider) + ' • ' + t('models.models_count', {count: models.length}) + ' • ' +
            r.enabled_token_count + '/' + r.token_count + ' tokens</div>' +
          '<div class="chips" style="justify-content:flex-start;margin-bottom:8px">' +
            models.map(function (mm) { return '<span class="chip">' + esc(mm.model) + (mm.is_default ? ' ⭐' : '') + '</span>'; }).join('') +
          '</div>' +
          '<div class="btn-row">' +
            (r.is_default ? '' : '<button class="btn-ghost" onclick="window.routeAction(\'' + esc(r.route_id) + '\', \'default\', {})">' + t('routing.make_default') + '</button>') +
            '<button class="btn-danger" onclick="window.deleteRoute(\'' + esc(r.route_id) + '\')">' + t('action.delete') + '</button>' +
          '</div></div>';
      }).join('');
      box.innerHTML = html;
    }).catch(function (e) { box.innerHTML = errorHtml(e); });
  }

  window.openRouteModal = function () {
    var m = document.createElement('div');
    m.className = 'modal-backdrop';
    m.innerHTML = '<div class="modal"><h2>' + t('routing.new_profile') + '</h2>' +
      '<label>' + t('routing.label') + '</label><input id="new-route-label" placeholder="Primary">' +
      '<label>' + t('models.provider') + '</label><select id="new-route-provider">' +
        '<option value="openai">OpenAI-compatible</option>' +
        '<option value="anthropic">Anthropic</option></select>' +
      '<label>' + t('models.base_url') + '</label><input id="new-route-url" placeholder="https://api.openai.com/v1">' +
      '<label>' + t('models.models') + '</label><input id="new-route-models" placeholder="gpt-4o-mini, gpt-4o">' +
      '<div class="btn-row"><button class="btn-ghost" onclick="window.closeModal()">' + t('action.cancel') + '</button>' +
      '<button class="btn" onclick="window.createRoute()">' + t('action.create') + '</button></div></div>';
    m.addEventListener('click', function (e) { if (e.target === m) window.closeModal(); });
    document.body.appendChild(m);
  };

  window.createRoute = function () {
    var models = el('new-route-models').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var body = {
      label: el('new-route-label').value.trim(),
      provider: el('new-route-provider').value,
      base_url: el('new-route-url').value.trim(),
      models: models
    };
    if (!body.label) { toast(t('routing.label_required')); return; }
    api('/api/admin/routes', { method: 'POST', body: body })
      .then(function () { window.closeModal(); toast(t('toast.saved')); loadRouting(); })
      .catch(function (e) { toast(e.message); });
  };

  window.deleteRoute = function (id) {
    if (!window.confirm(t('routing.delete_confirm'))) return;
    api('/api/admin/routes/' + id, { method: 'DELETE' })
      .then(function () { toast(t('action.delete')); loadRouting(); })
      .catch(function (e) { toast(e.message); });
  };

  window.routeAction = function (id, action, body) {
    api('/api/admin/routes/' + id + '/' + action, { method: 'POST', body: body })
      .then(function () { toast(t('toast.saved')); loadRouting(); })
      .catch(function (e) { toast(e.message); });
  };


  // --- PREFERENCES ---------------------------------------------------------
  function renderPreferences() {
    var box = el('sec-preferences');
    if (!box) return;
    box.innerHTML = '<div class="empty">' + t('state.loading') + '</div>';

    Promise.all([
      api('/api/user/personality'),
      api('/api/user/memory'),
      api('/api/user/custom-instructions')
    ]).then(function (results) {
      var personalities = results[0].personalities || [];
      var current = results[0].current || 'default';
      var memory = results[1];
      var customInst = results[2].text || '';

      var html = '<div class="card"><div class="card-title">' + t('prefs.personality') + '</div>';
      html += personalities.map(function (p) {
        return '<button class="chip' + (p.id === current ? ' active' : '') +
          '" onclick="window.setPersonality(\'' + p.id + '\')">' + esc(p.name) + '</button>';
      }).join('');
      html += '</div>';

      html += '<div class="card"><div class="card-title">' + t('prefs.memory_mode') + '</div>' +
        '<select id="memory-mode" onchange="window.setMemoryMode(this.value)">' +
        '<option value="off"' + (memory.mode === 'off' ? ' selected' : '') + '>' + t('prefs.memory_off') + '</option>' +
        '<option value="session"' + (memory.mode === 'session' ? ' selected' : '') + '>' + t('prefs.memory_session') + '</option>' +
        '<option value="always"' + (memory.mode === 'always' ? ' selected' : '') + '>' + t('prefs.memory_always') + '</option>' +
        '</select></div>';

      html += '<div class="card"><div class="card-title">' + t('prefs.custom_instructions') + '</div>' +
        '<textarea id="custom-inst" rows="4" maxlength="1000" placeholder="' + t('prefs.custom_hint') + '">' + esc(customInst) + '</textarea>' +
        '<button class="btn" onclick="window.saveCustomInstructions()">' + t('action.save') + '</button></div>';

      box.innerHTML = html;
    }).catch(function (e) { box.innerHTML = errorHtml(e); });
  }

  window.setPersonality = function (id) {
    api('/api/user/personality', { method: 'POST', body: { personality_id: id } })
      .then(function () { toast(t('toast.saved')); renderPreferences(); })
      .catch(function (e) { toast(e.message); });
  };

  window.setMemoryMode = function (mode) {
    api('/api/user/memory', { method: 'POST', body: { mode: mode } })
      .then(function () { toast(t('toast.saved')); })
      .catch(function (e) { toast(e.message); });
  };

  window.saveCustomInstructions = function () {
    var text = el('custom-inst').value.trim();
    api('/api/user/custom-instructions', { method: 'POST', body: { text: text } })
      .then(function () { toast(t('toast.saved')); })
      .catch(function (e) { toast(e.message); });
  };

  // --- USAGE (ADMIN) -------------------------------------------------------
  function loadUsage() {
    var box = el('sec-usage');
    if (!box) return;
    box.innerHTML = '<div class="empty">' + t('state.loading') + '</div>';

    Promise.all([
      api('/api/admin/connection-usage?days=7'),
      api('/api/admin/shared-usage?days=7')
    ]).then(function (results) {
      var connUsage = results[0].usage || [];
      var sharedUsage = results[1].usage || [];

      var html = '<div class="card"><div class="card-title">' + t('usage.connection_title') + '</div>';
      if (!connUsage.length) html += '<div class="empty">' + t('state.empty') + '</div>';
      else html += '<table><tr><th>' + t('usage.connection') + '</th><th>' + t('usage.requests') + '</th><th>' + t('usage.tokens') + '</th></tr>' +
        connUsage.map(function (u) {
          return '<tr><td>' + esc(u.label || u.connection_id) + '</td><td>' + u.requests + '</td><td>' + u.tokens + '</td></tr>';
        }).join('') + '</table>';
      html += '</div>';

      html += '<div class="card"><div class="card-title">' + t('usage.shared_title') + '</div>';
      if (!sharedUsage.length) html += '<div class="empty">' + t('state.empty') + '</div>';
      else html += '<table><tr><th>' + t('usage.user') + '</th><th>' + t('usage.requests') + '</th><th>' + t('usage.tokens') + '</th></tr>' +
        sharedUsage.map(function (u) {
          return '<tr><td>' + esc(u.first_name || 'User ' + u.telegram_id) + '</td><td>' + u.requests + '</td><td>' + u.tokens + '</td></tr>';
        }).join('') + '</table>';
      html += '</div>';

      box.innerHTML = html;
    }).catch(function (e) { box.innerHTML = errorHtml(e); });
  }


  // --- ADMIN ---------------------------------------------------------------
  function loadAdmin() {
    var box = el('sec-admin');
    if (!box) return;
    box.innerHTML = '<div class="empty">' + t('state.loading') + '</div>';

    api('/api/admin/stats').then(function (data) {
      var html = '<div class="card"><div class="card-title">' + t('admin.stats') + '</div>' +
        '<div class="stat-grid">' +
        '<div><strong>' + (data.total_users || 0) + '</strong><br>' + t('admin.total_users') + '</div>' +
        '<div><strong>' + (data.active_today || 0) + '</strong><br>' + t('admin.active_today') + '</div>' +
        '<div><strong>' + (data.total_chats || 0) + '</strong><br>' + t('admin.total_chats') + '</div>' +
        '<div><strong>' + (data.requests_today || 0) + '</strong><br>' + t('admin.requests_today') + '</div>' +
        '</div></div>';

      html += '<div class="card"><div class="card-title">' + t('admin.shared_service') + '</div>';
      html += '<label>' + t('admin.service_enabled') + '</label>' +
        '<select id="shared-enabled"><option value="1">' + t('status.enabled') + '</option><option value="0">' + t('status.disabled') + '</option></select>';
      html += '<label>' + t('admin.daily_request_limit') + '</label><input id="shared-req-limit" type="number" value="100">';
      html += '<label>' + t('admin.daily_token_limit') + '</label><input id="shared-tok-limit" type="number" value="50000">';
      html += '<button class="btn" onclick="window.saveSharedSettings()">' + t('action.save') + '</button></div>';

      html += '<div class="card"><div class="card-title">' + t('admin.maintenance') + '</div>' +
        '<button class="btn-danger" onclick="window.toggleMaintenance()">' + t('admin.toggle_maintenance') + '</button></div>';

      html += '<div class="card"><div class="card-title">' + t('admin.shared_models') + '</div>' +
        '<button class="btn" onclick="window.manageSharedModels()">' + t('admin.manage_shared') + '</button></div>';

      box.innerHTML = html;
    }).catch(function (e) { box.innerHTML = errorHtml(e); });
  }

  window.saveSharedSettings = function () {
    var body = {
      shared_service_enabled: parseInt(el('shared-enabled').value, 10),
      shared_daily_request_limit: parseInt(el('shared-req-limit').value, 10),
      shared_daily_token_limit: parseInt(el('shared-tok-limit').value, 10)
    };
    api('/api/admin/settings', { method: 'POST', body: body })
      .then(function () { toast(t('toast.saved')); })
      .catch(function (e) { toast(e.message); });
  };

  window.toggleMaintenance = function () {
    if (!window.confirm(t('admin.maintenance_confirm'))) return;
    api('/api/admin/settings', { method: 'POST', body: { maintenance_mode: 1 } })
      .then(function () { toast(t('admin.maintenance_enabled')); })
      .catch(function (e) { toast(e.message); });
  };

  window.manageSharedModels = function () {
    toast(t('admin.shared_models_hint'));
  };

  // --- STARFIELD BACKGROUND ------------------------------------------------
  function initStarfield() {
    var canvas = el('space-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    var stars = [];
    for (var i = 0; i < 100; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.5,
        v: Math.random() * 0.5 + 0.1
      });
    }
    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        ctx.globalAlpha = Math.random() * 0.7 + 0.3;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
        s.y += s.v;
        if (s.y > canvas.height) s.y = 0;
      }
      requestAnimationFrame(animate);
    }
    animate();
    window.addEventListener('resize', function () {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    });
  }

  // Bind language toggle
  var langBtn = el('lang-btn');
  if (langBtn) langBtn.addEventListener('click', window.toggleLanguage);

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
