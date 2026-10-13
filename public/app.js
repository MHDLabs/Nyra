// Nyra Mini App - Client-side application
(function() {
  'use strict';

  const tg = window.Telegram.WebApp;
  let state = {
    user: null,
    currentSection: 'chat',
    isAdmin: false,
    messages: [],
    connections: [],
    personalities: [],
    stats: null
  };

  // Initialize app
  function init() {
    tg.ready();
    tg.expand();
    applyTheme();
    
    const initData = tg.initData;
    if (!initData) {
      showError('این برنامه فقط در تلگرام کار می‌کند');
      return;
    }

    authenticate(initData);
  }

  // Apply Telegram theme
  function applyTheme() {
    const root = document.documentElement;
    const params = tg.themeParams;
    if (params.bg_color) root.style.setProperty('--tg-theme-bg-color', params.bg_color);
    if (params.text_color) root.style.setProperty('--tg-theme-text-color', params.text_color);
    if (params.hint_color) root.style.setProperty('--tg-theme-hint-color', params.hint_color);
    if (params.link_color) root.style.setProperty('--tg-theme-link-color', params.link_color);
    if (params.button_color) root.style.setProperty('--tg-theme-button-color', params.button_color);
    if (params.button_text_color) root.style.setProperty('--tg-theme-button-text-color', params.button_text_color);
    if (params.secondary_bg_color) root.style.setProperty('--tg-theme-secondary-bg-color', params.secondary_bg_color);
  }

  // Authenticate with backend
  async function authenticate(initData) {
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData })
      });
      
      if (!res.ok) {
        throw new Error('Authentication failed');
      }
      
      const data = await res.json();
      state.user = data.user;
      state.isAdmin = data.isAdmin;
      
      renderApp();
      loadInitialData();
    } catch (err) {
      showError('خطا در احراز هویت: ' + err.message);
    }
  }

  // Render main app
  function renderApp() {
    const app = document.getElementById('app');
    
    const nav = state.isAdmin 
      ? ['chat', 'settings', 'admin']
      : ['chat', 'settings'];
    
    app.innerHTML = `
      <div class="header">
        <h1>Nyra</h1>
      </div>
      <div class="nav">
        ${nav.map(section => `
          <button class="nav-btn ${section === state.currentSection ? 'active' : ''}" 
                  data-section="${section}">
            ${getSectionName(section)}
          </button>
        `).join('')}
      </div>
      <div class="content">
        <div id="chat-section" class="section ${state.currentSection === 'chat' ? 'active' : ''}">
          ${renderChatSection()}
        </div>
        <div id="settings-section" class="section ${state.currentSection === 'settings' ? 'active' : ''}">
          ${renderSettingsSection()}
        </div>
        ${state.isAdmin ? `
          <div id="admin-section" class="section ${state.currentSection === 'admin' ? 'active' : ''}">
            ${renderAdminSection()}
          </div>
        ` : ''}
      </div>
    `;
    
    attachEventListeners();
  }

  function getSectionName(section) {
    const names = {
      'chat': 'گفتگو',
      'settings': 'تنظیمات',
      'admin': 'مدیریت'
    };
    return names[section] || section;
  }

  function renderChatSection() {
    return `
      <div class="chat-container" id="chat-messages">
        ${state.messages.length === 0 ? '<div class="empty">سلام! پیامی بفرست تا گفتگو را شروع کنیم</div>' : ''}
        ${state.messages.map(msg => `
          <div class="message message-${msg.role}">
            <div class="message-bubble">
              ${escapeHtml(msg.content)}
              <div class="message-time">${formatTime(msg.timestamp)}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="input-container">
        <div class="input-wrapper">
          <input type="text" class="input-field" id="chat-input" placeholder="پیام خود را بنویسید...">
          <button class="send-btn" id="send-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  function renderSettingsSection() {
    return `
      <div class="card">
        <div class="card-title">پروفایل</div>
        <div class="card-row">
          <span class="card-label">نام</span>
          <span class="card-value">${escapeHtml(state.user?.first_name || '')}</span>
        </div>
        <div class="card-row">
          <span class="card-label">شناسه</span>
          <span class="card-value">${state.user?.telegram_id || ''}</span>
        </div>
      </div>
      
      <div class="card">
        <div class="card-title">مدل فعلی</div>
        <div class="card-subtitle" id="active-model">در حال بارگذاری...</div>
        <button class="btn btn-secondary" onclick="window.nyraApp.showConnections()">
          انتخاب مدل
        </button>
      </div>
      
      <div class="card">
        <div class="card-title">شخصیت</div>
        <div class="card-subtitle" id="active-personality">در حال بارگذاری...</div>
        <button class="btn btn-secondary" onclick="window.nyraApp.showPersonalities()">
          تغییر شخصیت
        </button>
      </div>
      
      <div class="card">
        <div class="card-title">حافظه</div>
        <div class="card-row">
          <span class="card-label">حالت</span>
          <span class="card-value" id="memory-mode">${state.user?.memory_mode || 'normal'}</span>
        </div>
        <button class="btn btn-secondary" onclick="window.nyraApp.showMemory()">
          مشاهده و مدیریت حافظه
        </button>
      </div>
      
      <div class="card">
        <div class="card-title">آمار استفاده</div>
        <div id="usage-stats">در حال بارگذاری...</div>
      </div>
    `;
  }

  function renderAdminSection() {
    return `
      <div class="admin-section">
        <div class="card">
          <div class="card-title">آمار سیستم</div>
          <div class="stat-grid" id="admin-stats">
            <div class="stat-card">
              <div class="stat-value">-</div>
              <div class="stat-label">کاربران</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">-</div>
              <div class="stat-label">گروه‌ها</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">-</div>
              <div class="stat-label">درخواست‌ها</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">-</div>
              <div class="stat-label">مدل‌ها</div>
            </div>
          </div>
        </div>
        
        <div class="card">
          <div class="card-title">مدیریت کاربران</div>
          <button class="btn btn-secondary" onclick="window.nyraApp.showUsers()">
            مشاهده کاربران
          </button>
        </div>
        
        <div class="card">
          <div class="card-title">مدیریت گروه‌ها</div>
          <button class="btn btn-secondary" onclick="window.nyraApp.showGroups()">
            مشاهده گروه‌ها
          </button>
        </div>
        
        <div class="card">
          <div class="card-title">مدیریت مدل‌ها</div>
          <button class="btn btn-secondary" onclick="window.nyraApp.showAdminConnections()">
            مشاهده و ویرایش مدل‌ها
          </button>
        </div>
        
        <div class="card">
          <div class="card-title">ارسال پیام گروهی</div>
          <div class="card-subtitle">ارسال پیام به همه کاربران یا گروه‌ها</div>
          <button class="btn" onclick="window.nyraApp.createBroadcast()">
            ایجاد پیام گروهی
          </button>
        </div>
      </div>
    `;
  }

  function attachEventListeners() {
    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const section = e.target.dataset.section;
        switchSection(section);
      });
    });
    
    // Chat input
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    if (chatInput && sendBtn) {
      sendBtn.addEventListener('click', () => sendMessage());
      chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
      });
    }
  }

  function switchSection(section) {
    state.currentSection = section;
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(section + '-section')?.classList.add('active');
    document.querySelector(`[data-section="${section}"]`)?.classList.add('active');
    
    if (section === 'admin') {
      loadAdminStats();
    }
  }

  async function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    
    input.value = '';
    
    // Add user message to UI
    state.messages.push({
      role: 'user',
      content: text,
      timestamp: Date.now()
    });
    updateChatUI();
    
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Init-Data': tg.initData
        },
        body: JSON.stringify({ message: text })
      });
      
      if (!res.ok) throw new Error('Failed to send');
      
      const data = await res.json();
      state.messages.push({
        role: 'assistant',
        content: data.response,
        timestamp: Date.now()
      });
      updateChatUI();
    } catch (err) {
      showError('خطا در ارسال پیام');
    }
  }

  function updateChatUI() {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    
    container.innerHTML = state.messages.map(msg => `
      <div class="message message-${msg.role}">
        <div class="message-bubble">
          ${escapeHtml(msg.content)}
          <div class="message-time">${formatTime(msg.timestamp)}</div>
        </div>
      </div>
    `).join('');
    
    container.scrollTop = container.scrollHeight;
  }

  async function loadInitialData() {
    try {
      const [user, stats] = await Promise.all([
        apiGet('/api/user/profile'),
        apiGet('/api/user/stats')
      ]);
      
      state.user = user;
      state.stats = stats;
      
      updateSettingsUI();
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }

  async function loadAdminStats() {
    try {
      const stats = await apiGet('/api/admin/stats');
      const container = document.getElementById('admin-stats');
      if (container && stats) {
        container.innerHTML = `
          <div class="stat-card">
            <div class="stat-value">${stats.users || 0}</div>
            <div class="stat-label">کاربران</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.chats || 0}</div>
            <div class="stat-label">گروه‌ها</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.requests || 0}</div>
            <div class="stat-label">درخواست‌ها</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${stats.connections || 0}</div>
            <div class="stat-label">مدل‌ها</div>
          </div>
        `;
      }
    } catch (err) {
      console.error('Failed to load admin stats:', err);
    }
  }

  function updateSettingsUI() {
    // Update active model display
    const modelEl = document.getElementById('active-model');
    if (modelEl && state.user?.active_connection) {
      modelEl.textContent = state.user.active_connection.label || 'انتخاب نشده';
    }
    
    // Update personality display
    const persEl = document.getElementById('active-personality');
    if (persEl && state.user?.personality) {
      persEl.textContent = state.user.personality.name || 'پیش‌فرض';
    }
    
    // Update stats
    const statsEl = document.getElementById('usage-stats');
    if (statsEl && state.stats) {
      statsEl.innerHTML = `
        <div class="card-row">
          <span class="card-label">کل درخواست‌ها</span>
          <span class="card-value">${state.stats.total || 0}</span>
        </div>
        <div class="card-row">
          <span class="card-label">موفق</span>
          <span class="card-value">${state.stats.success || 0}</span>
        </div>
        <div class="card-row">
          <span class="card-label">ناموفق</span>
          <span class="card-value">${state.stats.fail || 0}</span>
        </div>
      `;
    }
  }

  async function apiGet(url) {
    const res = await fetch(url, {
      headers: { 'X-Init-Data': tg.initData }
    });
    if (!res.ok) throw new Error('API error');
    return await res.json();
  }

  async function apiPost(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Init-Data': tg.initData
      },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('API error');
    return await res.json();
  }

  function showError(message) {
    tg.showAlert(message);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
  }

  // Public API
  window.nyraApp = {
    showConnections: () => showError('در حال توسعه'),
    showPersonalities: () => showError('در حال توسعه'),
    showMemory: () => showError('در حال توسعه'),
    showUsers: () => showError('در حال توسعه'),
    showGroups: () => showError('در حال توسعه'),
    showAdminConnections: () => showError('در حال توسعه'),
    createBroadcast: () => showError('در حال توسعه')
  };

  // Initialize on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
