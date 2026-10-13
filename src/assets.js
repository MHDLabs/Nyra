// Static assets for Mini App (inlined for Cloudflare Workers)

export const staticAssets = {
  "index.html": `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Nyra</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
:root {
  --tg-theme-bg-color: #1a1a1a;
  --tg-theme-text-color: #ffffff;
  --tg-theme-hint-color: #8e8e93;
  --tg-theme-link-color: #3a9bdc;
  --tg-theme-button-color: #3a9bdc;
  --tg-theme-button-text-color: #ffffff;
  --tg-theme-secondary-bg-color: #2c2c2e;
  --border-color: rgba(255,255,255,0.1);
}
body.light-theme {
  --tg-theme-bg-color: #ffffff;
  --tg-theme-text-color: #000000;
  --tg-theme-hint-color: #8e8e93;
  --tg-theme-link-color: #2481cc;
  --tg-theme-button-color: #2481cc;
  --tg-theme-button-text-color: #ffffff;
  --tg-theme-secondary-bg-color: #f4f4f5;
  --border-color: rgba(0,0,0,0.1);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
  background-color: var(--tg-theme-bg-color);
  color: var(--tg-theme-text-color);
  line-height: 1.5;
  transition: background-color 0.3s, color 0.3s;
}
.loading { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; gap: 16px; }
.spinner { width: 40px; height: 40px; border: 3px solid var(--tg-theme-hint-color); border-top-color: var(--tg-theme-button-color); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.header { background: var(--tg-theme-secondary-bg-color); padding: 16px; border-bottom: 1px solid var(--border-color); position: sticky; top: 0; z-index: 100; display: flex; align-items: center; justify-content: space-between; }
.header h1 { font-size: 24px; font-weight: 600; }
.theme-toggle { width: 40px; height: 40px; border: none; background: transparent; color: var(--tg-theme-text-color); font-size: 20px; cursor: pointer; border-radius: 8px; transition: background 0.2s; }
.theme-toggle:active { background: rgba(128,128,128,0.2); }
.nav { display: flex; gap: 8px; padding: 12px 16px; overflow-x: auto; border-bottom: 1px solid var(--border-color); }
.nav-btn { padding: 8px 16px; border: none; background: transparent; color: var(--tg-theme-hint-color); font-size: 15px; white-space: nowrap; cursor: pointer; border-radius: 12px; transition: all 0.2s; }
.nav-btn.active { background: var(--tg-theme-button-color); color: var(--tg-theme-button-text-color); }
.content { padding: 16px; }
.section { display: none; }
.section.active { display: block; }
.card { background: var(--tg-theme-secondary-bg-color); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
.card-title { font-size: 17px; font-weight: 600; margin-bottom: 8px; }
.card-subtitle { font-size: 14px; color: var(--tg-theme-hint-color); margin-bottom: 12px; }
.card-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border-color); }
.card-row:last-child { border-bottom: none; }
.btn { display: block; width: 100%; padding: 12px; border: none; background: var(--tg-theme-button-color); color: var(--tg-theme-button-text-color); font-size: 16px; border-radius: 12px; cursor: pointer; margin-top: 12px; }
.btn-secondary { background: var(--tg-theme-secondary-bg-color); color: var(--tg-theme-text-color); }
.stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 12px; }
.stat-card { background: var(--tg-theme-secondary-bg-color); padding: 16px; border-radius: 12px; text-align: center; }
.stat-value { font-size: 24px; font-weight: 600; margin-bottom: 4px; }
.stat-label { font-size: 13px; color: var(--tg-theme-hint-color); }
.empty { text-align: center; padding: 40px 20px; color: var(--tg-theme-hint-color); }
  </style>
</head>
<body>
  <div id="app">
    <div class="loading">
      <div class="spinner"></div>
      <p>در حال بارگذاری...</p>
    </div>
  </div>
  <script src="/app.js"></script>
</body>
</html>`,

  "app.js": `(function() {
  'use strict';
  const tg = window.Telegram.WebApp;
  let state = { user: null, currentSection: 'settings', isAdmin: false };
  
  function init() {
    tg.ready();
    tg.expand();
    loadTheme();
    const initData = tg.initData;
    if (!initData) {
      document.getElementById('app').innerHTML = '<div class="empty">این برنامه فقط در تلگرام کار می‌کند</div>';
      return;
    }
    authenticate(initData);
  }
  
  function loadTheme() {
    const theme = localStorage.getItem('nyra-theme') || 'dark';
    if (theme === 'light') document.body.classList.add('light-theme');
  }
  
  window.toggleTheme = function() {
    const isLight = document.body.classList.toggle('light-theme');
    localStorage.setItem('nyra-theme', isLight ? 'light' : 'dark');
    const btn = document.querySelector('.theme-toggle');
    if (btn) btn.textContent = isLight ? '🌙' : '☀️';
  };
  
  async function authenticate(initData) {
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData })
      });
      if (!res.ok) throw new Error('Auth failed');
      const data = await res.json();
      state.user = data.user;
      state.isAdmin = data.isAdmin;
      renderApp();
      loadData();
    } catch (err) {
      document.getElementById('app').innerHTML = '<div class="empty">خطا در احراز هویت</div>';
    }
  }
  
  function renderApp() {
    const nav = state.isAdmin ? ['settings', 'admin'] : ['settings'];
    const isLight = document.body.classList.contains('light-theme');
    document.getElementById('app').innerHTML = \`
      <div class="header">
        <h1>Nyra</h1>
        <button class="theme-toggle" onclick="window.toggleTheme()">\${isLight ? '🌙' : '☀️'}</button>
      </div>
      <div class="nav">
        \${nav.map(s => \`<button class="nav-btn \${s === state.currentSection ? 'active' : ''}" onclick="window.switchSection('\${s}')">\${s === 'settings' ? 'تنظیمات' : 'مدیریت'}</button>\`).join('')}
      </div>
      <div class="content">
        <div id="settings-section" class="section \${state.currentSection === 'settings' ? 'active' : ''}">
          <div class="card">
            <div class="card-title">پروفایل</div>
            <div class="card-row"><span>نام</span><span>\${state.user?.first_name || ''}</span></div>
          </div>
          <div class="card">
            <div class="card-title">آمار</div>
            <div id="stats">در حال بارگذاری...</div>
          </div>
        </div>
        \${state.isAdmin ? \`
          <div id="admin-section" class="section \${state.currentSection === 'admin' ? 'active' : ''}">
            <div class="card">
              <div class="card-title">آمار سیستم</div>
              <div class="stat-grid" id="admin-stats">
                <div class="stat-card"><div class="stat-value">-</div><div class="stat-label">کاربران</div></div>
                <div class="stat-card"><div class="stat-value">-</div><div class="stat-label">گروه‌ها</div></div>
              </div>
            </div>
          </div>
        \` : ''}
      </div>
    \`;
  }
  
  window.switchSection = function(section) {
    state.currentSection = section;
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(section + '-section')?.classList.add('active');
    document.querySelector('[onclick*="' + section + '"]')?.classList.add('active');
    if (section === 'admin') loadAdminStats();
  };
  
  async function loadData() {
    try {
      const stats = await fetch('/api/user/stats', { headers: { 'X-Init-Data': tg.initData } }).then(r => r.json());
      document.getElementById('stats').innerHTML = \`
        <div class="card-row"><span>کل</span><span>\${stats.total || 0}</span></div>
        <div class="card-row"><span>موفق</span><span>\${stats.success || 0}</span></div>
      \`;
    } catch (err) {}
  }
  
  async function loadAdminStats() {
    try {
      const stats = await fetch('/api/admin/stats', { headers: { 'X-Init-Data': tg.initData } }).then(r => r.json());
      const el = document.getElementById('admin-stats');
      if (el) el.innerHTML = \`
        <div class="stat-card"><div class="stat-value">\${stats.users || 0}</div><div class="stat-label">کاربران</div></div>
        <div class="stat-card"><div class="stat-value">\${stats.chats || 0}</div><div class="stat-label">گروه‌ها</div></div>
      \`;
    } catch (err) {}
  }
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`
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
