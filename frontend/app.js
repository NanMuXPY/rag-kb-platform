/* ==========================================================================
   技术支持知识库 · 企业内部版 前端逻辑
   认证：JWT Bearer（登录/注册/审批）；401 自动回到登录页
   接口：POST /chat、/auth/*、/admin/*
   本地直连 14052；经 nginx 部署时走 /api 前缀（自动探测）
   ========================================================================== */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const thread = $("thread"), messages = $("messages"), input = $("input");

  // ---- API 基址探测：同源 /api 优先（nginx 反代），失败回退本地直连 ----
  let API_BASE = "/api";
  async function detectBase() {
    try {
      const r = await fetch("/api/health", { method: "GET" });
      if (r.ok) return;
    } catch (_) { /* fallthrough */ }
    API_BASE = "http://127.0.0.1:14052";
  }

  // ---- 登录态（localStorage 持久化，服务端权威校验） ----
  const store = {
    get token() { return localStorage.getItem("kb_jwt") || ""; },
    set token(v) { v ? localStorage.setItem("kb_jwt", v) : localStorage.removeItem("kb_jwt"); },
    get user() {
      try { return JSON.parse(localStorage.getItem("kb_user") || "null"); }
      catch (_) { return null; }
    },
    set user(u) { u ? localStorage.setItem("kb_user", JSON.stringify(u)) : localStorage.removeItem("kb_user"); },
  };

  let me = null; // 当前登录用户 {username, role, status, ...}

  function authHeaders(json = true) {
    const h = {};
    if (json) h["Content-Type"] = "application/json";
    if (store.token) h["Authorization"] = `Bearer ${store.token}`;
    return h;
  }

  // ---- 认证视图 ----
  function showAuth() {
    me = null;
    $("authView").hidden = false;
    $("shell").style.display = "none";
  }

  function showApp() {
    $("authView").hidden = true;
    $("shell").style.display = "";
    const isAdmin = me.role === "admin" || me.role === "superadmin";
    $("whoName").textContent = me.display_name || me.username;
    // whoRole 是状态圆点，角色文字放 title 提示，避免把长文字塞进 8px 圆点
    const roleEl = $("whoRole");
    roleEl.className = "who-dot" + (isAdmin ? " admin" : "");
    roleEl.title = isAdmin ? (me.role === "superadmin" ? "超级管理员" : "管理员") : "员工";
    $("navAdmin").hidden = !isAdmin;
    if (!isAdmin && activeView === "admin") switchView("chat");
    if (!sessions.length) newSession();
    loadMyKbs().catch(() => {});   // 预取可见库，引用卡能直接显示库名
  }

  // ---- 一级视图切换：问答 / 知识库 / 控制台 ----
  let activeView = "chat";

  function switchView(name) {
    if (name === "admin" && !(me.role === "admin" || me.role === "superadmin")) return;
    activeView = name;
    for (const v of ["chat", "kb", "admin"]) {
      $(`view${v[0].toUpperCase()}${v.slice(1)}`).hidden = v !== name;
    }
    document.querySelectorAll(".vnav").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === name));
    $("rail").classList.remove("open");   // 移动端：切换视图收起会话栏
    if (name === "kb") openFiles().catch(() => {});
    if (name === "admin") {
      Promise.all([refreshAdmin(), refreshUsers()]).catch(() => {});
    }
  }

  document.querySelectorAll(".vnav").forEach((b) => {
    b.onclick = () => switchView(b.dataset.view);
  });

  async function boot() {
    await detectBase();
    if (!store.token) return showAuth();
    try {
      const r = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders(false) });
      if (!r.ok) throw new Error();
      me = await r.json();
      store.user = me;
      showApp();
    } catch (_) {
      store.token = ""; store.user = null;
      showAuth();
    }
  }

  $("tabLogin").onclick = () => switchAuthTab(true);
  $("tabRegister").onclick = () => switchAuthTab(false);
  function switchAuthTab(login) {
    $("tabLogin").classList.toggle("active", login);
    $("tabRegister").classList.toggle("active", !login);
    $("loginForm").hidden = !login;
    $("registerForm").hidden = login;
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("loginMsg");
    msg.textContent = "登录中…"; msg.className = "auth-msg";
    try {
      const r = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: $("loginUser").value.trim(),
          password: $("loginPass").value,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      store.token = d.token;
      store.user = d.user;
      me = d.user;
      $("loginPass").value = "";
      showApp();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "auth-msg err";
    }
  });

  $("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("regMsg");
    msg.textContent = "提交中…"; msg.className = "auth-msg";
    try {
      const r = await fetch(`${API_BASE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: $("regUser").value.trim(),
          password: $("regPass").value,
          display_name: $("regName").value.trim(),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
      msg.textContent = d.message || "注册成功，等待审批";
      msg.className = "auth-msg ok";
      $("regUser").value = ""; $("regPass").value = ""; $("regName").value = "";
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "auth-msg err";
    }
  });

  $("btnLogout").onclick = () => {
    store.token = ""; store.user = null;
    activeView = "chat";
    showAuth();
  };

  // ---- 会话历史（按用户隔离：key 带用户名） ----
  const SKEY = () => `kb_sessions_v3_${(me && me.username) || "anon"}`;
  let sessions = [];

  function loadSessions() {
    try { sessions = JSON.parse(localStorage.getItem(SKEY()) || "[]"); }
    catch (_) { sessions = []; }
  }
  function persistSessions() {
    localStorage.setItem(SKEY(), JSON.stringify(sessions.slice(-30)));
  }

  let current = null;   // {id, title, msgs: [{role, content, sources, trace, route, refused}]}
  let busy = false;

  function newSession() {
    current = { id: "s_" + Date.now(), title: "", msgs: [] };
    sessions.unshift(current);
    persistSessions();
    renderSessionList();
    renderMessages();
    input.focus();
  }

  function openSession(id) {
    current = sessions.find((s) => s.id === id);
    if (!current) return newSession();
    renderSessionList();
    renderMessages();
    $("rail").classList.remove("open");   // 手机端：选完会话收起抽屉
  }

  function renderSessionList() {
    const list = $("sessionList");
    list.innerHTML = "";
    for (const s of sessions) {
      const b = document.createElement("button");
      b.className = "session-item" + (current && s.id === current.id ? " active" : "");
      b.textContent = s.title || "（未命名会话）";
      b.onclick = () => openSession(s.id);
      list.appendChild(b);
    }
  }

  // ---- 消息渲染 ----
  const NODE_NAMES = {
    route: "路由", rewrite: "改写", retrieve: "检索",
    grade_documents: "打分", generate: "生成", chitchat: "闲聊",
  };

  function traceHTML(trace) {
    if (!trace || !trace.length) return "";
    const steps = trace.map((t, i) => {
      const cls = t.node === "chitchat" ? "tstep chitchat" : "tstep";
      const link = i > 0 ? '<span class="link"></span>' : "";
      return `${link}<span class="${cls}"><span class="dot"></span>` +
        `<span class="lbl">${NODE_NAMES[t.node] || t.node}</span>` +
        `<span class="ms">${t.ms}ms</span></span>`;
    }).join("");
    return `<div class="trace"><div class="trace-title">本次回答经过</div>` +
      `<div class="trace-steps">${steps}</div></div>`;
  }

  function kbLabel(kbId) {
    if (!kbId || kbId === "default") return "默认库";
    const kb = myKbs.find((k) => String(k.id) === String(kbId));
    return kb ? kb.name : `知识库 #${kbId}`;
  }
  // 引用展示名：去掉入库时加的 8 位哈希前缀
  function docDisplay(name) {
    return String(name || "").replace(/^[0-9a-f]{8}_/, "");
  }

  function citesHTML(sources) {
    if (!sources || !sources.length) return "";
    const cards = sources.map((s, i) =>
      `<button class="cite-card" data-i="${i}" title="点击查看原文片段">` +
      `<span class="cite-no">[${i + 1}]</span>` +
      `<span class="cite-main"><span class="cite-name">${esc(docDisplay(s.source))}</span>` +
      `<span class="cite-sub">${esc(kbLabel(s.kb_id))} · ${esc((s.preview || "").slice(0, 42))}…</span></span>` +
      `<span class="cite-open">查看片段 ›</span></button>`).join("");
    return `<div class="cites"><div class="cites-title">来源依据（${sources.length} 条，点击查看片段）</div>` +
      `<div class="cite-cards">${cards}</div></div>`;
  }

  // ---- 引用/预览弹窗 ----
  const dd = $("docDialog");
  function openDocDialog({ kind, title, bodyHTML }) {
    $("ddKind").textContent = kind || "来源";
    $("ddTitle").textContent = title || "";
    $("ddBody").innerHTML = bodyHTML;
    if (typeof dd.showModal === "function") dd.showModal();
    else window.alert(`${title}\n\n${$("ddBody").textContent}`);
  }
  $("ddClose").onclick = () => dd.close();
  dd.addEventListener("click", (e) => { if (e.target === dd) dd.close(); });

  function bindCiteCards(rootEl, sources) {
    rootEl.querySelectorAll(".cite-card").forEach((c) => {
      c.onclick = () => {
        const s = sources[+c.dataset.i];
        if (!s) return;
        openDocDialog({
          kind: `依据 [${+c.dataset.i + 1}]`,
          title: docDisplay(s.source),
          bodyHTML: `<p class="dd-kb">所属：${esc(kbLabel(s.kb_id))}</p>` +
            `<blockquote class="dd-quote">${esc(s.preview || "（无片段预览）")}</blockquote>` +
            `<p class="dd-path">文件路径：${esc(s.path || "-")}</p>`,
        });
      };
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- Markdown 渲染（本地 marked + DOMPurify，缺失时降级纯文本） ----
  let _mdReady = false;
  if (window.marked) {
    try { marked.setOptions({ gfm: true, breaks: true }); _mdReady = true; } catch (_) {}
  }
  function mdRender(text) {
    if (_mdReady && window.DOMPurify) {
      try {
        return DOMPurify.sanitize(marked.parse(String(text ?? "")));
      } catch (_) { /* fallthrough */ }
    }
    return `<p>${esc(text).replace(/\n/g, "<br>")}</p>`;
  }

  function renderMessages() {
    messages.innerHTML = "";
    const showEmpty = !current || !current.msgs.length;
    $("empty").style.display = showEmpty ? "" : "none";
    if (showEmpty) return;

    for (const m of current.msgs) {
      const div = document.createElement("div");
      if (m.role === "user") {
        div.className = "msg msg-user";
        div.innerHTML = `<div class="bubble">${esc(m.content)}</div>`;
      } else {
        div.className = "msg msg-bot" + (m.refused ? " refused" : "");
        const badge = m.refused ? `<span class="refuse-badge">知识库无依据 · 已拒答</span>` : "";
        div.innerHTML = `<div class="bubble">${badge}` +
          `<div class="answer-text md">${mdRender(m.content)}</div>` +
          `${citesHTML(m.sources)}${traceHTML(m.trace)}</div>`;
        bindCiteCards(div, m.sources || []);
      }
      messages.appendChild(div);
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function appendMsg(m) {
    current.msgs.push(m);
    if (!current.title && m.role === "user") {
      current.title = m.content.slice(0, 22);
      renderSessionList();
    }
    persistSessions();
    renderMessages();
  }

  // ---- 发送（SSE 流式） ----
  // 后端走 /chat/stream，事件：step（节点进度）/ token（正文增量）/ reset（重试清屏）/ final
  const STAGE_LABEL = {
    route: "正在理解问题…",
    rewrite: "正在改写检索词…",
    retrieve: "正在检索知识库…",
    grade_documents: "正在筛选相关段落…",
    generate: "正在组织回答…",
    chitchat: "正在回复…",
  };

  async function send(question) {
    if (busy || !question.trim()) return;
    busy = true;
    $("btnSend").disabled = true;

    appendMsg({ role: "user", content: question });

    // 占位气泡：路由/检索这几秒只更新阶段文案，不出字
    const pdiv = document.createElement("div");
    pdiv.className = "msg msg-bot pending";
    pdiv.innerHTML = `<div class="bubble"><span class="pulse"></span><span class="stage">正在理解问题…</span></div>`;
    messages.appendChild(pdiv);
    thread.scrollTop = thread.scrollHeight;
    let stageEl = pdiv.querySelector(".stage");
    let live = null;                       // 正文容器，第一个 token 才创建
    let streamed = "";                     // 已显示的增量文本

    const ensureLive = () => {
      if (live) return live;
      pdiv.className = "msg msg-bot";
      pdiv.innerHTML = `<div class="bubble"><div class="answer-text md"></div></div>`;
      live = pdiv.querySelector(".answer-text");
      return live;
    };

    try {
      const r = await fetch(`${API_BASE}/chat/stream`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ question, session_id: current.id }),
      });
      if (r.status === 401) { store.token = ""; store.user = null; showAuth(); return; }
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.detail || `HTTP ${r.status}`);
      }

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "", finalPayload = null, failure = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut).trim();
          buf = buf.slice(cut + 2);
          if (!block.startsWith("data:")) continue;
          let ev;
          try { ev = JSON.parse(block.slice(5).trim()); } catch { continue; }

          if (ev.type === "step") {
            if (stageEl) stageEl.textContent = STAGE_LABEL[ev.node] || "处理中…";
          } else if (ev.type === "token") {
            streamed += ev.text;
            ensureLive().innerHTML = mdRender(streamed);
            thread.scrollTop = thread.scrollHeight;
          } else if (ev.type === "reset") {
            // 质检没过、要重新生成：清空并明确告知，否则用户会以为卡住了
            streamed = "";
            live = null;
            pdiv.className = "msg msg-bot pending";
            pdiv.innerHTML = `<div class="bubble"><span class="pulse"></span>` +
              `<span class="stage">正在重新核对资料…</span></div>`;
            stageEl = pdiv.querySelector(".stage");
            thread.scrollTop = thread.scrollHeight;
          } else if (ev.type === "final") {
            finalPayload = ev;
          } else if (ev.type === "error") {
            failure = ev.detail;
          }
        }
      }

      if (failure) throw new Error(failure);
      if (!finalPayload) throw new Error("连接中断，未收到完整回答");

      // G2 引用校验在生成结束后做，final 里的 answer 是校验后的最终版（引用行已规范化）
      const answer = finalPayload.answer || streamed || "（无内容）";
      const refused = finalPayload.route === "vectorstore" &&
        /无法确定|官方支持渠道|资料未包含|知识库中没有/.test(answer);
      appendMsg({
        role: "assistant", content: answer,
        sources: finalPayload.sources, trace: finalPayload.trace,
        route: finalPayload.route, refused,
      });
    } catch (err) {
      appendMsg({
        role: "assistant",
        content: `请求失败：${err.message}`,
        refused: true,
      });
    } finally {
      pdiv.remove();
      busy = false;
      $("btnSend").disabled = !input.value.trim();
    }
  }

  // ---- 控制台（一级视图） ----
  let userFilter = "all";

  $("tabKb").onclick = () => switchDrawerTab(true);
  $("tabUsers").onclick = () => switchDrawerTab(false);
  function switchDrawerTab(kb) {
    $("tabKb").classList.toggle("active", kb);
    $("tabUsers").classList.toggle("active", !kb);
    $("paneKb").hidden = !kb;
    $("paneUsers").hidden = kb;
  }

  document.querySelectorAll(".ufilter").forEach((b) => {
    b.onclick = () => {
      userFilter = b.dataset.f;
      document.querySelectorAll(".ufilter").forEach((x) =>
        x.classList.toggle("active", x === b));
      renderUsers();
    };
  });

  const STATUS_CN = { pending: "待审批", active: "已激活", disabled: "已停用" };

  async function refreshUsers() {
    try {
      const r = await fetch(`${API_BASE}/admin/users`, { headers: authHeaders(false) });
      if (r.status === 403) throw new Error("需要管理员权限");
      if (r.status === 401) { showAuth(); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      allUsers = await r.json();
      const pending = allUsers.filter((u) => u.status === "pending").length;
      const badge = $("pendingBadge");
      badge.hidden = pending === 0;
      badge.textContent = pending;
      renderUsers();
    } catch (err) {
      $("userList").innerHTML = `<div class="admin-hint err">${esc(err.message)}</div>`;
    }
  }

  let allUsers = [];

  function renderUsers() {
    const el = $("userList");
    const rows = allUsers.filter((u) => userFilter === "all" || u.status === userFilter);
    el.innerHTML = "";
    if (!rows.length) { el.innerHTML = '<div class="admin-hint">暂无该状态的用户</div>'; return; }
    for (const u of rows) {
      const div = document.createElement("div");
      div.className = "user-row";
      const actions = [];
      if (u.status === "pending") {
        actions.push(`<button class="uact ok" data-a="approve" data-u="${esc(u.username)}">批准</button>`);
        actions.push(`<button class="uact" data-a="reject" data-u="${esc(u.username)}">拒绝</button>`);
      } else if (u.status === "active") {
        if (u.username !== me.username) {
          actions.push(`<button class="uact" data-a="disable" data-u="${esc(u.username)}">停用</button>`);
          actions.push(`<button class="uact danger" data-a="del" data-u="${esc(u.username)}">删除</button>`);
        }
        if (u.role === "admin" && u.username !== me.username) {
          actions.push(`<button class="uact" data-a="demote" data-u="${esc(u.username)}">降为员工</button>`);
        } else if (u.role === "user") {
          actions.push(`<button class="uact" data-a="promote" data-u="${esc(u.username)}">设为管理员</button>`);
        }
      } else if (u.status === "disabled") {
        actions.push(`<button class="uact ok" data-a="enable" data-u="${esc(u.username)}">恢复</button>`);
        actions.push(`<button class="uact danger" data-a="del" data-u="${esc(u.username)}">删除</button>`);
      }
      div.innerHTML =
        `<div class="uinfo"><span class="uname">${esc(u.display_name || u.username)}</span>` +
        `<span class="uacct">${esc(u.username)}${u.role === "admin" ? " · 管理员" : ""}</span>` +
        `${u.group ? `<span class="ugroup">${esc(u.group)}</span>` : ""}</div>` +
        `<span class="ustatus s-${u.status}">${STATUS_CN[u.status] || u.status}</span>` +
        `<div class="uacts">` +
        `<button class="uact" data-a="setgroup" data-u="${esc(u.username)}">设分组</button>` +
        actions.join("") + `</div>`;
      el.appendChild(div);
    }
    el.querySelectorAll(".uact").forEach((b) => {
      b.onclick = () => userAction(b.dataset.a, b.dataset.u);
    });
  }

  async function userAction(action, username) {
    const confirmMap = { del: `删除账号「${username}」？`, disable: `停用「${username}」？` };
    if (confirmMap[action] && !confirm(confirmMap[action])) return;
    // 设分组：弹输入框，空串 = 清除分组
    let groupValue = "";
    if (action === "setgroup") {
      const cur = (allUsers.find((u) => u.username === username) || {}).group || "";
      const input = prompt(`为「${username}」设置分组（部门/团队），留空清除：`, cur);
      if (input === null) return;   // 取消
      groupValue = input.trim();
    }
    const urlMap = {
      approve: `/admin/users/${encodeURIComponent(username)}/approve`,
      reject: `/admin/users/${encodeURIComponent(username)}/reject`,
      disable: `/admin/users/${encodeURIComponent(username)}/disable`,
      enable: `/admin/users/${encodeURIComponent(username)}/enable`,
      promote: `/admin/users/${encodeURIComponent(username)}/role?role=admin`,
      demote: `/admin/users/${encodeURIComponent(username)}/role?role=user`,
      setgroup: `/admin/users/${encodeURIComponent(username)}/group?group=${encodeURIComponent(groupValue)}`,
      del: `/admin/users/${encodeURIComponent(username)}`,
    };
    const method = action === "del" ? "DELETE" : "POST";
    try {
      const r = await fetch(`${API_BASE}${urlMap[action]}`, {
        method, headers: authHeaders(false),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      await refreshUsers();
    } catch (err) { alert(`操作失败：${err.message}`); }
  }

  // ---- 知识库管理 ----
  async function refreshAdmin() {
    $("indexState").textContent = "加载中…";
    $("indexState").className = "index-state";
    try {
      const r = await fetch(`${API_BASE}/admin/documents`, { headers: authHeaders(false) });
      if (r.status === 403) throw new Error("需要管理员权限");
      if (r.status === 401) { showAuth(); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const st = d.state || {};
      $("indexState").textContent =
        `chunks: ${st.chunks ?? "-"}\nbuilt_at: ${st.built_at ?? "-"}\n` +
        `building: ${st.building}` + (st.error ? `\nerror: ${st.error}` : "");
      if (st.error) $("indexState").className = "index-state err";

      const el = $("docList");
      el.innerHTML = "";
      for (const g of d.builtin || []) {
        const div = document.createElement("div");
        div.className = "doc-group";
        div.innerHTML = `<div class="doc-group-name">${esc(g.group)}（${g.count}）</div>`;
        for (const f of g.files) {
          const row = document.createElement("div");
          row.className = "doc-file";
          row.innerHTML = `<span class="name">${esc(f)}</span>`;
          div.appendChild(row);
        }
        el.appendChild(div);
      }
      if ((d.uploaded || []).length) {
        const div = document.createElement("div");
        div.className = "doc-group";
        div.innerHTML = `<div class="doc-group-name">自传文档</div>`;
        for (const u of d.uploaded) {
          const row = document.createElement("div");
          row.className = "doc-file doc-uploaded";
          row.innerHTML = `<span class="name" title="${esc(u.name)}">${esc(u.name)}</span>` +
            `<button class="doc-del" data-name="${esc(u.name)}">删除</button>`;
          div.appendChild(row);
        }
        el.appendChild(div);
      }
      el.querySelectorAll(".doc-del").forEach((b) => {
        b.onclick = () => deleteDoc(b.dataset.name);
      });
    } catch (err) {
      $("indexState").textContent = err.message;
      $("indexState").className = "index-state err";
      $("docList").innerHTML = "";
    }
  }

  async function deleteDoc(name) {
    if (!confirm(`删除「${name}」并重建索引？`)) return;
    try {
      const r = await fetch(`${API_BASE}/admin/documents/${encodeURIComponent(name)}`, {
        method: "DELETE", headers: authHeaders(false),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      await refreshAdmin();
    } catch (err) { alert(`删除失败：${err.message}`); }
  }

  async function uploadFile(file) {
    const out = $("uploadResult");
    out.className = "upload-result";
    out.textContent = `上传中：${file.name} …`;
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`${API_BASE}/admin/upload`, {
        method: "POST", headers: { Authorization: `Bearer ${store.token}` }, body: fd,
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const d = await r.json();
      out.className = "upload-result ok";
      out.textContent = `已入库：${d.name}（${d.chars} 字），索引重建已启动。`;
      setTimeout(refreshAdmin, 2500);
    } catch (err) {
      out.className = "upload-result err";
      out.textContent = `上传失败：${err.message}`;
    }
  }

  async function rebuild() {
    try {
      const r = await fetch(`${API_BASE}/admin/rebuild`, {
        method: "POST", headers: authHeaders(false),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTimeout(refreshAdmin, 2500);
    } catch (err) { alert(`重建失败：${err.message}`); }
  }

  // ---- 事件绑定 ----
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    input.style.height = "auto";
    send(q);
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
    $("btnSend").disabled = busy || !input.value.trim();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("samples").addEventListener("click", (e) => {
    const b = e.target.closest(".sample");
    if (b) send(b.dataset.q);
  });
  $("btnNew").onclick = () => { newSession(); $("rail").classList.remove("open"); };
  $("btnRebuild").onclick = rebuild;

  const dz = $("dropzone"), fi = $("fileInput");
  dz.onclick = () => fi.click();
  fi.onchange = () => fi.files[0] && uploadFile(fi.files[0]);
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("over"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); dz.classList.remove("over");
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });

  // 移动端会话栏开关（按钮在 index.html 顶栏内）
  $("railToggle").onclick = (e) => {
    e.stopPropagation();
    $("rail").classList.toggle("open");
  };
  document.addEventListener("click", (e) => {
    if (!$("rail").contains(e.target) && !$("railToggle").contains(e.target)) {
      $("rail").classList.remove("open");
    }
  });

  // ---- 知识库（一级视图） ----
  let myKbs = [], currentKb = null, currentKbRole = null;

  function openFiles() {
    $("kbCreateWrap").hidden = !(me.role === "superadmin");
    $("crossSearchWrap").hidden = !(me.role === "superadmin");
    return loadMyKbs();
  }

  async function loadMyKbs() {
    const r = await fetch(`${API_BASE}/kbs`, { headers: authHeaders(false) });
    if (r.status === 401) return showAuth();
    myKbs = await r.json();
    const chips = $("kbChips");
    chips.innerHTML = "";
    for (const kb of myKbs) {
      const b = document.createElement("button");
      b.className = "kb-chip" + (currentKb === kb.id ? " active" : "");
      const roleCN = { viewer: "只读", editor: "可传", kb_admin: "库管", super: "超管" };
      b.innerHTML = `${esc(kb.name)} <span class="kb-role">${roleCN[kb.my_role] || kb.my_role} · ${kb.file_count ?? 0}文件</span>`;
      b.onclick = () => selectKb(kb);
      chips.appendChild(b);
    }
    if (!currentKb && myKbs.length) selectKb(myKbs[0]);
  }

  function selectKb(kb) {
    currentKb = kb.id;
    currentKbRole = kb.my_role;
    document.querySelectorAll(".kb-chip").forEach((c) => c.classList.remove("active"));
    [...$("kbChips").children].forEach((c, i) => {
      if (myKbs[i] && myKbs[i].id === kb.id) c.classList.add("active");
    });
    const canUpload = ["editor", "kb_admin", "super"].includes(kb.my_role);
    const canManage = ["kb_admin", "super"].includes(kb.my_role);
    $("fileDropzone").hidden = !canUpload;
    $("memberSec").hidden = !canManage;
    $("fileSecTitle").textContent = `文件 · ${kb.name}`;
    $("fileSecHint").textContent =
      canManage ? "你是该库管理员：可上传（直接入库）、审批他人上传、删除（进回收站）。"
      : canUpload ? "你是可上传成员：上传后需库管理员审批，批准后才进入问答索引。"
      : "你是只读成员：可查询与下载，如需上传请联系库管理员。";
    loadKbFiles();
    if (canManage) loadMembers();
  }

  async function loadKbFiles() {
    const el = $("fileList");
    el.innerHTML = "加载中…";
    try {
      const r = await fetch(`${API_BASE}/kbs/${currentKb}/files`, { headers: authHeaders(false) });
      if (r.status === 401) return showAuth();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      el.innerHTML = "";
      if (!d.files.length) { el.innerHTML = '<div class="admin-hint">暂无文件</div>'; return; }
      const stCN = { approved: "已入库", pending: "待审批", rejected: "已拒绝" };
      for (const f of d.files) {
        const row = document.createElement("div");
        row.className = "file-row" + (f.status === "pending" ? " pending" : "");
        const acts = [];
        const previewable = /\.(md|txt)$/i.test(f.name);
        if (f.status === "approved" && previewable) {
          acts.push(`<button class="uact" data-a="pv" data-id="${f.id}">预览</button>`);
        }
        if (f.status === "approved" || currentKbRole === "kb_admin" || currentKbRole === "super" || f.uploader === me.username) {
          acts.push(`<button class="uact" data-a="dl" data-id="${f.id}">下载</button>`);
        }
        if (f.status === "pending" && ["kb_admin", "super"].includes(currentKbRole)) {
          acts.push(`<button class="uact ok" data-a="ok" data-id="${f.id}">批准入库</button>`);
          acts.push(`<button class="uact" data-a="no" data-id="${f.id}">拒绝</button>`);
        }
        if (["kb_admin", "super"].includes(currentKbRole)) {
          acts.push(`<button class="uact danger" data-a="del" data-id="${f.id}">删除</button>`);
        }
        row.innerHTML =
          `<div class="finfo"><span class="fname">${esc(f.name)}</span>` +
          `<span class="fmeta">v${f.version} · ${(f.size / 1024).toFixed(1)}KB · ${esc(f.uploader)}` +
          `${f.chunks ? ` · ${f.chunks} chunks` : ""}</span></div>` +
          `<span class="ustatus s-${f.status}">${stCN[f.status] || f.status}</span>` +
          `<div class="uacts">${acts.join("")}</div>`;
        el.appendChild(row);
      }
      el.querySelectorAll(".uact").forEach((b) => {
        b.onclick = () => fileAction(b.dataset.a, +b.dataset.id);
      });
    } catch (err) {
      el.innerHTML = `<div class="admin-hint err">${esc(err.message)}</div>`;
    }
  }

  async function fileAction(action, fid) {
    if (action === "dl") return downloadFile(fid);
    if (action === "pv") return previewFile(fid);
    const label = { ok: "批准入库", no: "拒绝", del: "删除（移入回收站，可恢复）" }[action];
    if (!confirm(`确认${label}？`)) return;
    const url = action === "del" ? `/files/${fid}`
      : action === "ok" ? `/files/${fid}/approve` : `/files/${fid}/reject`;
    try {
      const r = await fetch(`${API_BASE}${url}`, {
        method: action === "del" ? "DELETE" : "POST", headers: authHeaders(false),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      loadKbFiles(); loadMyKbs();
    } catch (err) { alert(`操作失败：${err.message}`); }
  }

  async function downloadFile(fid) {
    try {
      const r = await fetch(`${API_BASE}/kbs/${currentKb}/files/${fid}/download`, {
        headers: authHeaders(false),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const blob = await r.blob();
      const dispo = r.headers.get("Content-Disposition") || "";
      const m = dispo.match(/filename\*=UTF-8''([^;]+)/);
      const name = m ? decodeURIComponent(m[1]) : `file_${fid}`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { alert(`下载失败：${err.message}`); }
  }

  // 预览 .md/.txt 原文（Markdown 渲染后弹窗展示）
  async function previewFile(fid) {
    try {
      const r = await fetch(`${API_BASE}/kbs/${currentKb}/files/${fid}/download`, {
        headers: authHeaders(false),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const dispo = r.headers.get("Content-Disposition") || "";
      const m = dispo.match(/filename\*=UTF-8''([^;]+)/);
      const name = m ? decodeURIComponent(m[1]) : `file_${fid}`;
      const text = await r.text();
      openDocDialog({
        kind: "原文预览",
        title: name,
        bodyHTML: `<div class="md doc-preview">${mdRender(text.slice(0, 50000))}</div>`,
      });
    } catch (err) { alert(`预览失败：${err.message}`); }
  }

  async function uploadKbFile(file) {
    const out = $("kbUploadResult");
    out.className = "upload-result";
    out.textContent = `上传中：${file.name} …`;
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`${API_BASE}/kbs/${currentKb}/upload`, {
        method: "POST", headers: { Authorization: `Bearer ${store.token}` }, body: fd,
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const d = await r.json();
      out.className = "upload-result ok";
      out.textContent = d.status === "approved"
        ? `已直接入库：${d.name}（${d.chunks ?? 0} chunks）`
        : `已提交，等待库管理员审批：${d.name}`;
      loadKbFiles(); loadMyKbs();
    } catch (err) {
      out.className = "upload-result err";
      out.textContent = `上传失败：${err.message}`;
    }
  }

  // ---- 成员管理 ----
  async function loadMembers() {
    try {
      const r = await fetch(`${API_BASE}/kbs/${currentKb}/members`, { headers: authHeaders(false) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = await r.json();
      const el = $("memberList");
      el.innerHTML = "";
      const roleCN = { viewer: "只读", editor: "可上传", kb_admin: "库管理员" };
      for (const m of list) {
        const div = document.createElement("div");
        div.className = "user-row";
        div.innerHTML =
          `<div class="uinfo"><span class="uname">${esc(m.username)}</span>` +
          `<span class="uacct">授权人 ${esc(m.granted_by || "-")}</span></div>` +
          `<span class="ustatus s-active">${roleCN[m.role] || m.role}</span>` +
          `<div class="uacts">${m.role !== "kb_admin" ? `<button class="uact danger" data-u="${esc(m.username)}">移除</button>` : ""}</div>`;
        el.appendChild(div);
      }
      el.querySelectorAll(".uact.danger").forEach((b) => {
        b.onclick = async () => {
          if (!confirm(`移除成员 ${b.dataset.u}？`)) return;
          await fetch(`${API_BASE}/kbs/${currentKb}/members/${encodeURIComponent(b.dataset.u)}`,
            { method: "DELETE", headers: authHeaders(false) });
          loadMembers();
        };
      });
    } catch (err) {
      $("memberList").innerHTML = `<div class="admin-hint err">${esc(err.message)}</div>`;
    }
    loadGroupGrants();
  }

  // 分组授权列表 + 授权/收回
  async function loadGroupGrants() {
    const el = $("groupGrantList");
    try {
      const r = await fetch(`${API_BASE}/kbs/${currentKb}/groups`, { headers: authHeaders(false) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = await r.json();
      el.innerHTML = "";
      if (!list.length) {
        el.innerHTML = '<div class="admin-hint">尚未授权任何分组（该库仅对个人成员与默认库读者可见）</div>';
        return;
      }
      const roleCN = { viewer: "只读", editor: "可上传", kb_admin: "库管理员" };
      for (const g of list) {
        const div = document.createElement("div");
        div.className = "user-row";
        div.innerHTML =
          `<div class="uinfo"><span class="uname">${esc(g.grp)}</span>` +
          `<span class="uacct">整组授权 · 操作人 ${esc(g.granted_by || "-")}</span></div>` +
          `<span class="ustatus s-active">${roleCN[g.role] || g.role}</span>` +
          `<div class="uacts"><button class="uact danger">收回</button></div>`;
        div.querySelector(".uact.danger").onclick = async () => {
          if (!confirm(`收回分组「${g.grp}」的访问权？该组将无法再检索本库。`)) return;
          await fetch(`${API_BASE}/kbs/${currentKb}/groups/${encodeURIComponent(g.grp)}`,
            { method: "DELETE", headers: authHeaders(false) });
          loadGroupGrants();
        };
        el.appendChild(div);
      }
    } catch (err) {
      el.innerHTML = `<div class="admin-hint err">${esc(err.message)}</div>`;
    }
  }

  $("btnGrantGroup").onclick = async () => {
    const grp = $("grantGroup").value.trim(), role = $("grantGroupRole").value;
    if (!grp) return alert("请填写分组名（需与用户管理中的分组一致）");
    try {
      const r = await fetch(`${API_BASE}/kbs/${currentKb}/groups`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ group: grp, role }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      $("grantGroup").value = "";
      loadGroupGrants();
    } catch (err) { alert(`授权失败：${err.message}`); }
  };

  $("btnCreateKb").onclick = async () => {
    const name = $("kbName").value.trim();
    if (!name) return;
    try {
      const r = await fetch(`${API_BASE}/admin/kbs`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ name, description: "" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      $("kbName").value = "";
      await loadMyKbs();
    } catch (err) { alert(`创建失败：${err.message}`); }
  };
  $("btnAddMember").onclick = async () => {
    const username = $("memberUser").value.trim(), role = $("memberRole").value;
    if (!username) return;
    try {
      const r = await fetch(`${API_BASE}/kbs/${currentKb}/members`, {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ username, role }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      $("memberUser").value = "";
      loadMembers();
    } catch (err) { alert(`授权失败：${err.message}`); }
  };
  $("btnCrossSearch").onclick = async () => {
    const q = $("crossQ").value.trim();
    if (!q) return;
    const el = $("crossResults");
    el.innerHTML = "搜索中…";
    try {
      const r = await fetch(`${API_BASE}/admin/search?q=${encodeURIComponent(q)}`,
        { headers: authHeaders(false) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const d = await r.json();
      el.innerHTML = d.results.length
        ? d.results.map((x) =>
          `<div class="xhit"><span class="xkb">${esc(x.kb)}</span>` +
          `<span class="xsrc">${esc(x.source)}</span><p>${esc(x.preview)}…</p></div>`).join("")
        : '<div class="admin-hint">无结果</div>';
    } catch (err) {
      el.innerHTML = `<div class="admin-hint err">${esc(err.message)}</div>`;
    }
  };

  const fdz = $("fileDropzone"), kfi = $("kbFileInput");
  fdz.onclick = () => kfi.click();
  kfi.onchange = () => kfi.files[0] && uploadKbFile(kfi.files[0]);
  fdz.addEventListener("dragover", (e) => { e.preventDefault(); fdz.classList.add("over"); });
  fdz.addEventListener("dragleave", () => fdz.classList.remove("over"));
  fdz.addEventListener("drop", (e) => {
    e.preventDefault(); fdz.classList.remove("over");
    if (e.dataTransfer.files[0]) uploadKbFile(e.dataTransfer.files[0]);
  });

  // ---- 审计日志 ----
  let auditFilterVal = "";
  document.querySelectorAll("#auditFilter .ufilter").forEach((b) => {
    b.onclick = () => {
      auditFilterVal = b.dataset.f;
      document.querySelectorAll("#auditFilter .ufilter").forEach((x) =>
        x.classList.toggle("active", x === b));
      loadAudit();
    };
  });

  async function loadAudit() {
    const el = $("auditList");
    el.innerHTML = "加载中…";
    try {
      const r = await fetch(
        `${API_BASE}/admin/audit?limit=150${auditFilterVal ? `&action=${auditFilterVal}` : ""}`,
        { headers: authHeaders(false) });
      if (r.status === 401) return showAuth();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = await r.json();
      el.innerHTML = "";
      if (!list.length) { el.innerHTML = '<div class="admin-hint">暂无记录</div>'; return; }
      for (const a of list) {
        const div = document.createElement("div");
        div.className = "audit-row";
        const t = new Date(a.ts * 1000).toLocaleString("zh-CN", { hour12: false });
        div.innerHTML = `<span class="atime">${t}</span><span class="auser">${esc(a.username)}</span>` +
          `<span class="aact">${esc(a.action)}</span>` +
          `<span class="atgt" title="${esc(a.detail)}">${esc(a.target || "")}</span>`;
        el.appendChild(div);
      }
    } catch (err) {
      el.innerHTML = `<div class="admin-hint err">${esc(err.message)}</div>`;
    }
  }

  // ---- 管理抽屉页签（3 个） ----
  $("tabAudit").onclick = () => {
    ["tabKb", "tabUsers", "tabAudit"].forEach((t) =>
      $(t).classList.toggle("active", t === "tabAudit"));
    $("paneKb").hidden = true;
    $("paneUsers").hidden = true;
    $("paneAudit").hidden = false;
    loadAudit();
  };
  const _origTabKb = $("tabKb").onclick, _origTabUsers = $("tabUsers").onclick;
  $("tabKb").onclick = () => { _origTabKb && _origTabKb(); loadMyKbs().catch(() => {}); };

  // ---- 启动 ----
  boot();
})();
