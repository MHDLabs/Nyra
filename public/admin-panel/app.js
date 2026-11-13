(function () {
  const $ = (id) => document.getElementById(id);
  const loginView = $("login-view");
  const appView = $("app-view");
  const loginForm = $("login-form");
  const loginError = $("login-error");
  const userList = $("user-list");
  const userDetail = $("user-detail");
  const groupList = $("group-list");
  const groupDetail = $("group-detail");
  const modelList = $("model-list");
  const statsEl = $("stats");

  function theme(name) {
    if (name) document.documentElement.setAttribute("data-theme", name);
    else {
      const cur = document.documentElement.getAttribute("data-theme") || "dark";
      document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
    }
    localStorage.setItem("nyra_admin_theme", document.documentElement.getAttribute("data-theme"));
  }
  theme(localStorage.getItem("nyra_admin_theme") || "dark");
  document.querySelectorAll("[data-theme]").forEach((btn) => {
    btn.addEventListener("click", () => theme(btn.getAttribute("data-theme")));
  });
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => theme());
  });

  async function api(path, options) {
    const opts = options || {};
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: Object.assign({ "content-type": "application/json" }, opts.headers || {}),
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || res.statusText || "request_failed");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    try {
      return new Date(Number(ts) * 1000).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
    } catch (e) {
      return String(ts);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
    await Promise.all([loadStats(), loadUsers(), loadGroups(), loadModels()]);
  }

  async function loadStats() {
    try {
      const s = await api("/admin-api/stats");
      statsEl.textContent = "کاربران " + s.users + " · لاگ " + s.chat_logs + " · مدل " + s.models;
    } catch (e) {
      statsEl.textContent = "";
    }
  }

  async function loadUsers(q) {
    const data = await api("/admin-api/users?limit=100" + (q ? "&q=" + encodeURIComponent(q) : ""));
    userList.innerHTML = "";
    (data.users || []).forEach((u) => {
      const el = document.createElement("div");
      el.className = "list-item";
      el.dataset.id = u.telegram_id;
      const name = u.preferred_name || u.first_name || u.username || u.telegram_id;
      el.innerHTML =
        '<div class="avatar" data-avatar="' + u.telegram_id + '">' + escapeHtml(String(name).slice(0, 1)) + "</div>" +
        '<div class="meta"><strong>' + escapeHtml(name) + '</strong>' +
        '<span>@' + escapeHtml(u.username || "—") + " · " + u.telegram_id + "</span></div>";
      el.addEventListener("click", () => openUser(u.telegram_id, el));
      userList.appendChild(el);
      // Lazy avatar
      const img = new Image();
      img.src = "/admin-api/users/" + u.telegram_id + "/avatar";
      img.onload = function () {
        const box = el.querySelector(".avatar");
        if (box) { box.innerHTML = ""; box.appendChild(img); }
      };
    });
  }

  async function openUser(id, el) {
    document.querySelectorAll("#user-list .list-item").forEach((n) => n.classList.remove("active"));
    if (el) el.classList.add("active");
    userDetail.innerHTML = "<p class='muted center'>در حال بارگذاری...</p>";
    const data = await api("/admin-api/users/" + id);
    const u = data.user;
    const conn = data.connection;
    const memory = data.memory || {};
    const msgs = await api("/admin-api/users/" + id + "/messages?limit=80");
    userDetail.innerHTML =
      '<div class="detail-grid">' +
      '<div style="display:flex;gap:14px;align-items:center">' +
      '<div class="avatar" style="width:64px;height:64px" id="detail-avatar">' + escapeHtml(String(u.first_name || "?").slice(0, 1)) + "</div>" +
      "<div><h2 style='margin:0'>" + escapeHtml(u.preferred_name || u.first_name || "") + "</h2>" +
      "<div class='muted'>@" + escapeHtml(u.username || "—") + " · <code>" + u.telegram_id + "</code></div></div></div>" +
      '<div class="kv">' +
      "<div>شخصیت</div><div>" + escapeHtml(u.personality_id || "—") + "</div>" +
      "<div>حافظه</div><div>" + escapeHtml(u.memory_mode || "—") + "</div>" +
      "<div>مدل فعال</div><div>" + escapeHtml(conn ? (conn.label + " (" + conn.model + ")") : "—") + "</div>" +
      "<div>locale</div><div>" + escapeHtml(u.locale || u.language_code || "—") + "</div>" +
      "<div>آخرین پیام</div><div>" + fmtTime(u.last_inbound_at) + "</div>" +
      "<div>مسدود</div><div>" + (data.blocked ? "بله" : "خیر") + "</div>" +
      "</div>" +
      "<h3>مموری</h3><div class='memory-box'>" + escapeHtml(JSON.stringify(memory, null, 2)) + "</div>" +
      (u.custom_instructions ? "<h3>دستورالعمل سفارشی</h3><div class='memory-box'>" + escapeHtml(u.custom_instructions) + "</div>" : "") +
      '<div class="actions">' +
      '<button class="btn" id="btn-block">' + (data.blocked ? "رفع مسدودیت" : "مسدود کردن") + "</button>" +
      '<button class="btn primary" id="btn-msg" style="width:auto">ارسال پیام</button>' +
      "</div>" +
      "<h3>چت خصوصی</h3><div class='chat-box' id='user-chat'></div>" +
      "</div>";

    const av = new Image();
    av.src = "/admin-api/users/" + id + "/avatar";
    av.onload = function () {
      const box = $("detail-avatar");
      if (box) { box.innerHTML = ""; box.appendChild(av); }
    };

    const chatBox = $("user-chat");
    (msgs.messages || []).forEach((m) => {
      const b = document.createElement("div");
      b.className = "bubble " + (m.role === "assistant" ? "assistant" : "user");
      b.innerHTML = escapeHtml(m.content || "") + '<span class="when">' + fmtTime(m.created_at) + (m.media_type ? " · " + m.media_type : "") + "</span>";
      chatBox.appendChild(b);
    });
    chatBox.scrollTop = chatBox.scrollHeight;

    $("btn-block").onclick = async function () {
      await api("/admin-api/users/" + id, { method: "PATCH", body: { blocked: !data.blocked } });
      openUser(id, el);
    };
    $("btn-msg").onclick = function () {
      document.querySelector('[data-tab="broadcast"]').click();
      $("send-target").value = "one";
      $("send-id").value = String(id);
      $("send-text").focus();
    };
  }

  async function loadGroups() {
    const data = await api("/admin-api/groups?limit=100");
    groupList.innerHTML = "";
    (data.groups || []).forEach((g) => {
      const el = document.createElement("div");
      el.className = "list-item";
      el.innerHTML =
        '<div class="avatar">G</div><div class="meta"><strong>' +
        escapeHtml(g.title || g.chat_id) +
        "</strong><span>" + escapeHtml(g.chat_type || "group") + " · " + g.chat_id +
        " · لاگ " + (g.log_count || 0) + "</span></div>";
      el.addEventListener("click", async () => {
        document.querySelectorAll("#group-list .list-item").forEach((n) => n.classList.remove("active"));
        el.classList.add("active");
        const msgs = await api("/admin-api/chats/" + g.chat_id + "/messages?limit=100");
        groupDetail.innerHTML = "<h2>" + escapeHtml(g.title || String(g.chat_id)) + "</h2>" +
          "<p class='muted'>فقط پیام‌های تریگرشده / پاسخ نایرا</p><div class='chat-box' id='group-chat'></div>";
        const box = $("group-chat");
        (msgs.messages || []).forEach((m) => {
          const b = document.createElement("div");
          b.className = "bubble " + (m.role === "assistant" ? "assistant" : "user");
          b.innerHTML = escapeHtml(m.content || "") + '<span class="when">' + fmtTime(m.created_at) + "</span>";
          box.appendChild(b);
        });
        box.scrollTop = box.scrollHeight;
      });
      groupList.appendChild(el);
    });
  }

  async function loadModels() {
    const data = await api("/admin-api/models");
    modelList.innerHTML = "";
    (data.models || []).forEach((m) => {
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML =
        "<h3>" + escapeHtml(m.label || m.connection_id) + "</h3>" +
        "<div class='muted'>" + escapeHtml(m.model || "") + "</div>" +
        "<div class='muted'>" + escapeHtml(m.provider || "") + "</div>" +
        "<div style='margin-top:8px'>" +
        (m.enabled ? "<span class='badge'>enabled</span>" : "<span class='badge off'>disabled</span>") +
        (m.is_default ? " <span class='badge'>default</span>" : "") +
        (m.is_global ? " <span class='badge'>global</span>" : "") +
        "</div>";
      modelList.appendChild(el);
    });
  }

  // Tabs
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      const tab = $("tab-" + btn.getAttribute("data-tab"));
      if (tab) tab.classList.add("active");
    });
  });

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    try {
      await api("/admin-api/login", { method: "POST", body: { password: $("password").value } });
      await showApp();
    } catch (err) {
      loginError.hidden = false;
      loginError.textContent = err.status === 401 ? "رمز اشتباه است" : (err.message || "خطا");
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    try { await api("/admin-api/logout", { method: "POST" }); } catch (e) {}
    appView.hidden = true;
    loginView.hidden = false;
  });

  let searchTimer;
  $("user-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadUsers($("user-search").value.trim()).catch(() => {}), 250);
  });

  $("send-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const target = $("send-target").value;
    const text = $("send-text").value.trim();
    $("send-result").textContent = "در حال ارسال...";
    try {
      const body = target === "all"
        ? { all: true, text: text }
        : { telegram_id: Number($("send-id").value), text: text };
      const res = await api("/admin-api/send", { method: "POST", body: body });
      $("send-result").textContent = target === "all"
        ? ("ارسال شد: " + res.sent + " / ناموفق: " + res.failed)
        : ("ارسال شد · message_id=" + res.message_id);
    } catch (err) {
      $("send-result").textContent = "خطا: " + (err.message || "send_failed");
    }
  });

  $("send-target").addEventListener("change", () => {
    $("send-id").style.display = $("send-target").value === "all" ? "none" : "block";
  });

  // Session bootstrap
  api("/admin-api/me").then(showApp).catch(() => {
    loginView.hidden = false;
    appView.hidden = true;
  });
})();
