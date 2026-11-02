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
    if (!isAdmin && parseHash().module === "admin") {
      history.replaceState(null, "", "#chat");
    }
    loadSessions();                // 本地历史必须先读回来，否则首屏会用一个空会话覆盖掉它
    if (!sessions.length) newSession();
    else if (!current) current = sessions[0];
    renderSessionList();
    renderSamples();
    loadMyKbs().catch(() => {});   // 预取可见库，引用卡能直接显示库名
    applyRoute();                  // 按当前 hash 渲染首个视图
  }

  // ---- 一级视图切换：只负责“显示哪个 section”，导航本身由 hash 驱动 ----
  let activeView = "chat";

  function showView(name) {
    if (name === "admin" && !isSysAdmin()) return;
    activeView = name;
    for (const v of ["chat", "kb", "admin"]) {
      $(`view${v[0].toUpperCase()}${v.slice(1)}`).hidden = v !== name;
    }
    document.querySelectorAll(".vnav").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === name));
    $("rail").classList.remove("open");   // 移动端：切换视图收起会话栏
    // 后台页不需要会话列表，窄屏折叠 rail（状态 class，不是断点）
    // 判据必须是视图白名单（kb / admin）：门户与对话同属 chat，会话栏要一直留着
    $("shell").classList.toggle("rail-collapsed",
      (name === "kb" || name === "admin") && window.innerWidth < 1180);
  }

  function navigate(hash, replace) {
    const cur = location.hash || "#chat";
    if (cur === hash) { applyRoute(); return; }
    if (replace) history.replaceState(null, "", hash);
    else location.hash = hash;
    if (replace) applyRoute();      // replaceState 不触发 hashchange
  }

  function switchView(name) {        // 兼容旧调用点
    navigate(name === "kb" ? "#kb" : name === "admin" ? "#admin/index" : "#chat");
  }

  document.querySelectorAll(".vnav").forEach((b) => {
    b.onclick = () => navigate(b.dataset.view === "kb" ? "#kb"
      : b.dataset.view === "admin" ? "#admin/index" : "#chat");
  });
  window.addEventListener("hashchange", () => applyRoute());

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
  // 会话结构：[{id, title, msgs: [{role, content, sources, trace, route, refused, ts}]}]
  // 顺序语义 = 最近使用在前（appendMsg 后 touchSession 置顶）
  const SKEY = () => `kb_sessions_v3_${(me && me.username) || "anon"}`;
  const SESSION_MAX = 30;
  let sessions = [];

  function loadSessions() {
    try { sessions = JSON.parse(localStorage.getItem(SKEY()) || "[]"); }
    catch (_) { sessions = []; }
    if (!Array.isArray(sessions)) sessions = [];
  }

  // 落盘规则（交互规范 §2.4）：
  // ① 保留最新 30 条（新会话 unshift 到头部 → slice(0,30)，不是 slice(-30)：后者会写掉最新那条）
  // ② 当前会话永不淘汰
  // ③ 0 消息的会话不落盘（当前会话除外，它可能正等第一条消息）
  function persistSessions() {
    const keep = [];
    for (const s of sessions) {
      if (s !== current && (!s.msgs || !s.msgs.length)) continue;
      if (keep.length >= SESSION_MAX && s !== current) continue;
      keep.push(s);
    }
    let arr = keep;
    for (let i = 0; i <= 5; i++) {
      try { localStorage.setItem(SKEY(), JSON.stringify(arr)); return; }
      catch (_) {
        // 配额兜底：从尾部（最旧）删 1 个再试，最多 5 次
        if (arr.length <= 1) break;
        arr = arr.slice(0, arr.length - 1);
        if (!arr.includes(current)) arr.push(current);
      }
    }
    toast("本地历史已满，最早 5 个会话已清理", "err");
  }

  let current = null;   // {id, title, msgs: [{role, content, sources, trace, route, refused, ts}]}
  let busy = false;
  let pendingAnchor = null;   // {sessionId, msgIndex}：从「最近提问」进来时滚到那一条，用完即清

  function newSession() {
    current = { id: "s_" + Date.now(), title: "", msgs: [] };
    sessions.unshift(current);
    persistSessions();
    renderSessionList();
    return current;
  }

  // 唯一的新会话判据（门户页发送时用）：当前会话还有内容就新开，空会话复用
  function ensureFreshSession() {
    if (current && current.msgs.length === 0) return current;
    return newSession();
  }

  // 会话置顶：最近用过的排最前，rail 与「最近提问」共用这个顺序
  function touchSession() {
    if (!current) return;
    const i = sessions.indexOf(current);
    if (i > 0) { sessions.splice(i, 1); sessions.unshift(current); }
    persistSessions();
    renderSessionList();
  }

  function openSession(id) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return false;
    current = s;
    renderSessionList();
    $("rail").classList.remove("open");   // 手机端：选完会话收起抽屉
    return true;
  }

  function renderSessionList() {
    const list = $("sessionList");
    list.innerHTML = "";
    for (const s of sessions) {
      const b = document.createElement("button");
      b.className = "session-item" +
        (chatMode === "thread" && current && s.id === current.id ? " active" : "");
      b.textContent = s.title || "（未命名会话）";
      b.title = s.title || "（未命名会话）";
      b.onclick = () => goSession(s.id);
      list.appendChild(b);
    }
  }

  // rail 里点会话：不新开（openSession），对话之间用 replace，门户进来用 push
  function goSession(id) {
    if (!openSession(id)) return;
    goThread(id, chatMode === "thread");
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
    else {
      // 极端退化：不支持 <dialog> 的浏览器用页面级提示，不用原生 alert
      toast(`${title || ""}：内容无法在此浏览器内展开，请升级浏览器`, "err");
    }
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
    // #empty 常驻 DOM（作为 .messages 的空态），只清消息节点，别把它一起删掉
    messages.querySelectorAll(".msg").forEach((n) => n.remove());
    const showEmpty = !current || !current.msgs.length;
    $("empty").style.display = showEmpty ? "" : "none";
    if (showEmpty) return;

    current.msgs.forEach((m, i) => {
      const div = document.createElement("div");
      div.dataset.i = String(i);
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
    });

    // 从「最近提问」点进来：滚到那一条并高亮 1.2s（锚点只在内存，不进 URL）
    if (pendingAnchor && current && pendingAnchor.sessionId === current.id) {
      const idx = pendingAnchor.msgIndex;
      pendingAnchor = null;
      requestAnimationFrame(() => {
        const el = messages.querySelector(`.msg[data-i="${idx}"]`);
        if (!el) { thread.scrollTop = thread.scrollHeight; return; }
        el.scrollIntoView({ block: "center" });
        el.classList.add("msg-flash");
        setTimeout(() => el.classList.remove("msg-flash"), 1200);
      });
      return;
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function appendMsg(m) {
    const msg = Object.assign({ ts: Date.now() }, m);
    current.msgs.push(msg);
    if (!current.title && msg.role === "user") {
      current.title = msg.content.slice(0, 22);
    }
    touchSession();
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

  // ======================================================================
  // 门户首页 —— #chat 的 idle 态（不是第 4 个页签）
  // 形态：docs/门户首页设计.md ｜ 行为：docs/门户首页交互.md
  // 硬约束：门户零新增请求，三段数据源 = myKbs / localStorage 会话 / SAMPLES
  // ======================================================================
  let chatMode = "portal";      // "portal"（门户） | "thread"（对话）
  let portalKbState = "idle";   // idle | loading | ready | error
  let portalNarrow = false;     // 容器 < 420：最近提问整段收进 <details>
  let portalScroll = 0;         // 门户滚动位置只在内存里记

  // 常用问题 / 对话空态样例：全站唯一一份数据（对话页 #samples 由它渲染）
  const SAMPLES = [
    { q: "腾讯云对象存储怎么创建存储桶？", label: "对象存储怎么创建存储桶？" },
    { q: "企业微信如何获取 access_token？", label: "企业微信如何获取 access_token？" },
    { q: "腾讯会议怎么预定会议？", label: "腾讯会议怎么预定会议？" },
    { q: "微信小程序服务器域名怎么配置？", label: "小程序服务器域名怎么配置？" },
    { q: "腾讯云服务器如何重置密码？", label: "云服务器如何重置密码？" },
  ];

  function renderSamples() {
    $("samples").innerHTML = SAMPLES.map((s, i) =>
      `<button class="sample" data-i="${i}" data-q="${esc(s.q)}">${esc(s.label)}</button>`).join("");
  }

  const ROLE_W = { super: 3, kb_admin: 3, editor: 2, viewer: 1 };

  function greetText() {
    const h = new Date().getHours();
    const w = h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
    const name = (me && (me.display_name || me.username)) || "";
    return name ? `${w}，${name}` : w;
  }

  // 「最近提问」：跨会话摊平 user 消息，ts 倒序、空白归一化后全等去重
  function recentQuestions(limit = 5) {
    const items = [];
    sessions.forEach((s, si) => {
      (s.msgs || []).forEach((m, mi) => {
        if (m.role !== "user") return;
        items.push({ s, m, si, mi });
      });
    });
    // 旧数据没有 ts（=0）落在所有新消息之后，彼此按会话序 + 消息倒序，与补 ts 之前的观感一致
    items.sort((a, b) =>
      (b.m.ts || 0) - (a.m.ts || 0) || a.si - b.si || b.mi - a.mi);
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const key = String(it.m.content || "").replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(it);
      if (out.length === limit) break;
    }
    return out;
  }

  // 来源库：该会话最后一条 assistant 消息的 sources[0]，读不到就整段不渲染
  function sessionKbName(s) {
    const msgs = s.msgs || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "assistant" && m.sources && m.sources.length) {
        const kbId = m.sources[0].kb_id;
        if (kbId === undefined || kbId === null || kbId === "") return "";  // 没有这个字段 → 整段不渲染
        return kbLabel(kbId);
      }
    }
    return "";
  }

  function lastAskedTs() {
    let t = 0;
    for (const s of sessions) for (const m of s.msgs || []) {
      if (m.role === "user" && m.ts > t) t = m.ts;
    }
    return t;
  }

  function portalKbSorted() {
    // 先按库内角色权重（能管理的在前），同权重按最后更新降序
    return myKbs.slice().sort((a, b) =>
      (ROLE_W[b.my_role] || 0) - (ROLE_W[a.my_role] || 0)
      || ((b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0))
      || a.id - b.id);
  }

  function renderPortalSub() {
    const parts = [];
    if (portalKbState === "loading" || portalKbState === "idle") parts.push("正在读取知识库…");
    else if (portalKbState === "error") parts.push("知识库列表暂时读取失败");
    else parts.push(`你有 ${myKbs.length} 个知识库的访问权限`);
    const t = lastAskedTs();
    if (t) parts.push(`上次提问 ${tsInfo(Math.floor(t / 1000)).text}`);
    $("portalSub").textContent = parts.join(" · ");
  }

  function portalCardHTML(kb) {
    const t = tsInfo(kb.updated_at || kb.created_at || 0);
    const files = kb.id === 1
      ? `<span class="dash" title="默认库是内置语料">内置语料</span>`
      : (kb.file_count ? `<span class="pcard-num">${kb.file_count}</span>` : `<span class="dash">—</span>`);
    const role = ROLE_CN[kb.my_role] || "";
    return `<a class="pcard" href="#kb/${kb.id}/files"
        title="你是这个库的${role || "成员"} · 打开该库的文件列表">
      <span class="pcard-main">
        <span class="pcard-name">${esc(kb.name)}</span>
        ${levelTag(kb.level)}${statusTag(kb.status)}
      </span>
      <span class="pcard-sub">
        <span class="pcard-code">${kb.code ? esc(kb.code) : "未编码"}</span>
        <span class="pcard-dept">${kb.dept ? esc(kb.dept) : "—"}</span>
        <span class="pcard-role">${esc(role)}</span>
        <span class="pcard-files">${files}</span>
        <span class="pcard-time" title="更新：${esc(t.full)}">${esc(t.text)}</span>
      </span>
    </a>`;
  }

  function renderPortalKbs() {
    const cards = $("portalCards");
    const strip = $("portalStrip");
    const act = $("portalAllKb");
    $("portalKbCount").textContent = "";
    cards.setAttribute("aria-busy", portalKbState === "loading" ? "true" : "false");
    act.hidden = true;

    if (portalKbState === "loading") {
      cards.innerHTML = `<div class="pcard pcard-skel" aria-hidden="true">
        <span class="sk sk-w1"></span><span class="sk sk-w2 sk-mt"></span></div>`.repeat(3);
      strip.hidden = true;
      renderPortalSub();
      return;
    }
    if (portalKbState === "error") {
      cards.innerHTML = `<div class="portal-err">
        <span>读取知识库列表超时（5s）</span>
        <button class="portal-retry" id="portalRetry">重试</button></div>`;
      strip.hidden = true;
      renderPortalSub();
      $("portalRetry").onclick = () => retryPortalKbs();
      return;
    }

    const all = portalKbSorted();
    cards.innerHTML = all.slice(0, 3).map(portalCardHTML).join("");
    // 段头动作与卡片同一阈值：只有 >3 个库时才有「查看全部 N 个 →」
    if (all.length > 3) {
      act.hidden = false;
      act.textContent = `查看全部 ${all.length} 个 →`;
      act.onclick = () => navigate("#kb");
    }
    // 最近更新 strip：段 1 的脚注，与卡片行同源，随段 1 同生共死
    const recent = all.slice().sort((a, b) =>
      (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
    if (recent.length) {
      strip.hidden = false;
      strip.innerHTML = `<span class="pstrip-label">最近更新：</span>` +
        recent.slice(0, 3).map((k) => {
          const t = tsInfo(k.updated_at || k.created_at || 0);
          return `<span class="pstrip-item">${esc(k.name)} ` +
            `<span class="pstrip-t">${esc(t.text)}</span></span>`;
        }).join(`<span class="pstrip-sep" aria-hidden="true">·</span>`);
      strip.title = "最近更新：" + recent.slice(0, 3)
        .map((k) => `${k.name} ${tsInfo(k.updated_at || k.created_at || 0).text}`).join(" · ");
    } else {
      strip.hidden = true;
    }
    renderPortalSub();
  }

  function renderPortalRecent() {
    const box = $("portalRecent");
    const title = $("portalRecentTitle");
    const items = recentQuestions(5);
    title.hidden = false;
    if (!items.length) {
      // 空态用 32px hint-bar，不是 64px 空态块
      box.innerHTML = `<div class="hint-bar">还没有提问记录 · 在下面挑一个问题开始</div>`;
      return;
    }
    const rows = items.slice(0, 4).map(({ s, m, mi }) => {
      const q = String(m.content || "").replace(/\s+/g, " ").trim() || "（空问题）";
      const rounds = (s.msgs || []).filter((x) => x.role === "user").length;
      const kb = sessionKbName(s);
      const t = m.ts ? tsInfo(Math.floor(m.ts / 1000)) : { text: "较早", full: "旧数据没有时间戳" };
      return `<button class="recent-row" data-sid="${esc(s.id)}" data-idx="${mi}">
        <span class="rr-q" title="${esc(q.slice(0, 120))}">${esc(q)}</span>
        ${rounds > 1 ? `<span class="rr-round">· ${rounds} 轮</span>` : ""}
        ${kb ? `<span class="rr-kb" title="${esc(kb)}">${esc(kb)}</span>` : ""}
        <span class="rr-time" title="${esc(t.full)}">${esc(t.text)}</span>
        <span class="rr-arrow" aria-hidden="true">›</span>
      </button>`;
    }).join("");

    if (portalNarrow) {
      title.hidden = true;    // 折叠时标题进 summary，避免两层标题
      box.innerHTML = `<details class="recent-details"><summary>最近提问（${items.length}）</summary>` +
        `<div class="recent-body">${rows}</div></details>`;
    } else {
      box.innerHTML = rows;
    }

    box.onclick = (e) => {
      const b = e.target.closest(".recent-row");
      if (!b) return;
      const sid = b.dataset.sid;
      if (!openSession(sid)) { goPortal(true); return; }
      // 只回看、不重问：进原会话并滚到那一条，不发任何请求
      pendingAnchor = { sessionId: sid, msgIndex: Number(b.dataset.idx) };
      goThread(sid, false);
    };
  }

  function renderPortalSamples() {
    $("portalSamples").innerHTML = SAMPLES.map((s, i) =>
      `<button class="psample" data-i="${i}"><span class="psdot" aria-hidden="true">·</span>` +
      `<span class="pstext">${esc(s.label)}</span></button>`).join("");
    $("portalSamples").onclick = (e) => {
      const b = e.target.closest(".psample");
      if (!b) return;
      const s = SAMPLES[+b.dataset.i];
      if (s) sendViaComposer(s.q);
    };
  }

  function renderPortal() {
    if (!me) return;
    $("portalGreet").textContent = greetText();
    // 权限：普通员工这里 nodes 不存在（不是 hidden）
    const actBox = $("portalHeadAct");
    actBox.innerHTML = isSysAdmin()
      ? `<button class="portal-act" id="portalAdmin">控制台 ›</button>` : "";
    if (isSysAdmin()) $("portalAdmin").onclick = () => navigate("#admin/index");
    refreshPortalKbs();     // myKbs 命中内存 → 0 请求；否则复用 in-flight Promise
    renderPortalRecent();
    renderPortalSamples();
  }

  function refreshPortalKbs() {
    if (myKbs.length) {
      portalKbState = "ready";
      renderPortalKbs();
      return;
    }
    portalKbState = "loading";
    renderPortalKbs();
    loadMyKbs()
      .then(() => {
        portalKbState = "ready";
        renderPortalKbs();
        renderPortalRecent();   // 库名映射依赖 myKbs：数据晚到时补一次，否则遗留「知识库 #3」
      })
      .catch((e) => {
        if (e && e.status === 401) { showAuth(); return; }   // 登录过期必须回登录页，不降级
        portalKbState = "error";
        renderPortalKbs();
      });
  }

  function retryPortalKbs() {
    portalKbState = "loading";
    renderPortalKbs();
    loadMyKbs(true)
      .then(() => { portalKbState = "ready"; renderPortalKbs(); })
      .catch((e) => {
        if (e && e.status === 401) { showAuth(); return; }
        portalKbState = "error";
        renderPortalKbs();
      });
  }

  function saveChatScroll() {
    if (chatMode === "portal") portalScroll = thread.scrollTop;
  }

  function routePortal() {
    chatMode = "portal";
    $("portal").hidden = false;
    messages.hidden = true;
    document.title = "技术支持知识库 · 企业内部版";
    renderSessionList();     // 门户没有"当前会话"，rail 不高亮
    renderPortal();
    watchPortalWidth();
    requestAnimationFrame(() => { thread.scrollTop = portalScroll; });
  }

  function routeThread(id) {
    const s = sessions.find((x) => x.id === id);
    if (!s) { goPortal(true); return; }   // 静默回落到门户，不 toast（会话 id 是本机的）
    chatMode = "thread";
    current = s;
    portalScroll = 0;
    $("portal").hidden = true;
    messages.hidden = false;
    renderSessionList();
    renderMessages();
    input.focus();
  }

  function goPortal(replace) {
    const hash = "#chat";
    if ((location.hash || hash) !== hash) {
      if (replace) history.replaceState(null, "", hash);
      else history.pushState(null, "", hash);
    }
    routePortal();
  }

  function goThread(id, replace) {
    const hash = `#chat/s/${id}`;
    if ((location.hash || "") !== hash) {
      if (replace) history.replaceState(null, "", hash);
      else history.pushState(null, "", hash);
    }
    routeThread(id);
  }

  // 容器 < 420（不是视口）：最近提问整段收进 <details>，常用问题永不折叠
  let portalRO = null;
  function watchPortalWidth() {
    if (portalRO || !window.ResizeObserver) return;
    const host = document.querySelector(".portal-inner");
    if (!host) return;
    portalRO = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      const narrow = w < 420;
      if (narrow !== portalNarrow) {
        portalNarrow = narrow;
        if (chatMode === "portal") renderPortalRecent();
      }
    });
    portalRO.observe(host);
  }

  // ---- 控制台（一级视图） ----
  let userFilter = "all";

  // 控制台页签：语料索引 / 用户管理 / 权限矩阵 / 审计日志 / 接口（由 hash 决定）
  const ADMIN_TAB_IDS = {
    index: ["tabKb", "paneKb"],
    users: ["tabUsers", "paneUsers"],
    matrix: ["tabMatrix", "paneMatrix"],
    audit: ["tabAudit", "paneAudit"],
    api: ["tabApi", "paneApi"],
  };

  function applyAdminTab(tab) {
    if (!ADMIN_TAB_IDS[tab]) tab = "index";
    for (const k of Object.keys(ADMIN_TAB_IDS)) {
      const [tid, pid] = ADMIN_TAB_IDS[k];
      $(tid).classList.toggle("active", k === tab);
      $(tid).setAttribute("aria-selected", k === tab ? "true" : "false");
      $(pid).hidden = k !== tab;
    }
    // 接口面板：父级用 flex 列撑满视口（不写 calc(100vh − 常量)），仅供 api 页签
    $("viewAdmin").classList.toggle("is-api", tab === "api");
    if (tab === "index") refreshAdmin().catch(() => {});
    if (tab === "users") refreshUsers().catch(() => {});
    if (tab === "matrix") renderMatrix().catch(() => {});
    if (tab === "audit") loadAudit().catch(() => {});
    if (tab === "api") renderApiPanel();
  }

  for (const k of Object.keys(ADMIN_TAB_IDS)) {
    $(ADMIN_TAB_IDS[k][0]).onclick = () => navigate(`#admin/${k}`);
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
    const u = allUsers.find((x) => x.username === username) || {};
    const shown = u.display_name || username;
    if (action === "del") {
      const ok = await confirmDialog({
        title: `删除账号「${shown}」？`,
        body: `<p>账号将被彻底删除，其历史审计记录保留。</p>
          <p class="cf-warn">此操作不可撤销。</p>`,
        danger: true,
        okText: "删除账号",
      });
      if (!ok) return;
    }
    if (action === "disable") {
      const ok = await confirmDialog({
        title: `停用「${shown}」？`,
        body: `<p>停用后该账号立即失效、无法登录。随时可以恢复。</p>`,
        okText: "停用",
      });
      if (!ok) return;
    }
    // 设分组：输入框，空串 = 清除分组
    let groupValue = "";
    if (action === "setgroup") {
      const val = await inputDialog({
        title: `为「${shown}」设置分组`,
        body: `<p>分组是部门 / 团队名。权限矩阵的列与知识库的「整组授权」都按它匹配，
          同名分组的人会共享分组授权。</p><p>留空表示清除分组。</p>`,
        label: "分组名",
        value: u.group || "",
        placeholder: "如：财务组",
        okText: "保存",
      });
      if (val === null) return;   // 取消
      groupValue = val;
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
      const doneMsg = {
        approve: `已批准「${shown}」的注册`, reject: `已拒绝「${shown}」的注册`,
        disable: `已停用「${shown}」`, enable: `已恢复「${shown}」`,
        promote: `已把「${shown}」设为管理员`, demote: `已把「${shown}」降为员工`,
        setgroup: groupValue ? `已把「${shown}」的分组设为「${groupValue}」` : `已清除「${shown}」的分组`,
        del: `已删除账号「${shown}」`,
      }[action];
      if (doneMsg) toast(doneMsg);
      await refreshUsers();
      if (action === "setgroup" || action === "approve" || action === "enable" || action === "del") {
        // 分组变化会改矩阵的列，顺手让人看到最新数据
        mxData = null;
      }
    } catch (err) { toast(errText(err, "操作失败"), "err"); }
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
    const ok = await confirmDialog({
      title: `删除文档「${name}」？`,
      body: `<p>删除后会立即重建索引，问答将不再引用这份文档。</p>
        <p class="cf-warn">此操作不可撤销，需要重新上传。</p>`,
      danger: true,
      okText: "删除并重建",
    });
    if (!ok) return;
    try {
      const r = await fetch(`${API_BASE}/admin/documents/${encodeURIComponent(name)}`, {
        method: "DELETE", headers: authHeaders(false),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      toast(`已删除「${name}」，索引重建已启动`);
      await refreshAdmin();
    } catch (err) { toast(errText(err, "删除失败"), "err"); }
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
      toast("已开始重建索引，期间问答不中断");
      setTimeout(refreshAdmin, 2500);
    } catch (err) { toast(errText(err, "重建失败"), "err"); }
  }

  // ---- 事件绑定 ----
  // 发送的唯一入口：门户态先按 ensureFreshSession 定会话再进 thread；thread 态追问永不新开
  function startSend(q) {
    const text = String(q || "").trim();
    if (!text || busy) return;
    if (chatMode !== "thread") {
      ensureFreshSession();
      goThread(current.id, false);       // 门户 → 对话，push 一条历史
    }
    send(text);
  }

  // 点常用问题 / 样例：先把原文写进 composer，再走同一条提交路径（不写第二个发送函数）
  function sendViaComposer(text) {
    input.value = text;
    input.dispatchEvent(new Event("input"));
    $("composer").requestSubmit();
  }

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || busy) return;      // 没有真正发出时不清空，别把用户刚打的问题吃掉
    input.value = "";
    input.style.height = "auto";
    $("btnSend").disabled = true;
    startSend(q);
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
    if (b) sendViaComposer(b.dataset.q);
  });
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

  // ======================================================================
  // 治理后台 —— hash 路由 / 知识库列表 / 详情四分区 / 权限矩阵
  // 依据：docs/后台交互规范.md（交互）、docs/后台视觉规范.md（形态与令牌）
  // ======================================================================
  let myKbs = [];                               // 全部可见库（未过滤）：引用卡库名 + 部门选项
  let currentKb = null, currentKbRole = null;   // 当前打开的库（供预览/下载用）

  const LEVEL_CN = { public: "公开", internal: "内部", confidential: "机密" };
  const LEVEL_CLS = { public: "cls-public", internal: "cls-internal", confidential: "cls-secret" };
  const ROLE_CN = { viewer: "只读", editor: "可上传", kb_admin: "库管理员", super: "超管" };
  const ROLE_MARK = { viewer: "○", editor: "◐", kb_admin: "●" };
  const ROLE_RANK = { viewer: 1, editor: 2, kb_admin: 3 };
  const FILE_ST_CN = { approved: "已入库", pending: "待审批", rejected: "已驳回" };
  const DEPT_SUGGEST = ["产品部", "技术支持一部", "技术支持二部", "财务部", "管理层", "人力资源部"];
  const EXT_RE = /\.(md|txt|pdf|docx|xlsx|pptx)$/i;
  const MAX_MB = 20;

  const isSysAdmin = () => !!me && (me.role === "admin" || me.role === "superadmin");
  const canManageRole = (r) => r === "kb_admin" || r === "super";
  const canWriteRole = (r) => r === "editor" || r === "kb_admin" || r === "super";

  // ---- 统一请求封装：401 回登录页，错误带 status ----
  async function api(path, opts = {}) {
    const method = opts.method || "GET";
    const body = opts.body;
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const headers = isForm ? { Authorization: `Bearer ${store.token}` }
      : authHeaders(body !== undefined);
    let r;
    try {
      r = await fetch(API_BASE + path, {
        method, headers,
        body: isForm ? body : (body !== undefined ? JSON.stringify(body) : undefined),
      });
    } catch (_) {
      throw Object.assign(new Error("网络中断，请检查网络后重试"), { status: 0 });
    }
    if (r.status === 401) { store.token = ""; store.user = null; showAuth(); throw Object.assign(new Error("登录已过期，请重新登录"), { status: 401 }); }
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.detail || `HTTP ${r.status}`), { status: r.status });
    return data;
  }

  function errText(err, prefix) {
    const p = prefix ? `${prefix}：` : "";
    if (err && err.status === 0) return `${p}网络中断，请检查网络后重试`;
    if (err && err.status === 403) return `${p}权限不足（${err.message}）`;
    return `${p}${(err && err.message) || "未知错误"}`;
  }

  // ---- 时间：≤7 天用相对时间，>7 天用绝对日期；title 恒为完整时间 ----
  const pad2 = (n) => String(n).padStart(2, "0");
  function tsInfo(ts) {
    const n = Number(ts) || 0;
    if (!n) return { text: "—", full: "—" };
    const d = new Date(n * 1000);
    const abs = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const full = `${abs} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const min = Math.floor((Date.now() - n * 1000) / 60000);
    if (min < 1) return { text: "刚刚", full };
    if (min < 60) return { text: `${min} 分钟前`, full };
    const hr = Math.floor(min / 60);
    if (hr < 24) return { text: `${hr} 小时前`, full };
    const day = Math.floor(hr / 24);
    if (day <= 7) return { text: `${day} 天前`, full };
    return { text: abs, full };
  }
  const fmtSize = (b) => {
    const n = Number(b) || 0;
    if (!n) return "—";
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  // ---- toast：成功 2.5s / 可撤销 10s（带倒计时） ----
  let toastTimer = 0, toastCdTimer = 0;
  function closeToast() {
    clearTimeout(toastTimer); clearInterval(toastCdTimer);
    $("toastWrap").innerHTML = "";
  }
  function toast(msg, kind = "ok", action = null) {
    closeToast();
    const el = document.createElement("div");
    el.className = "toast" + (kind === "err" ? " err" : "");
    el.setAttribute("role", kind === "err" ? "alert" : "status");
    const m = document.createElement("span");
    m.className = "toast-msg";
    m.textContent = msg;
    el.appendChild(m);
    if (action) {
      const secs = action.seconds || 10;
      let left = secs;
      const cd = document.createElement("span");
      cd.className = "toast-cd";
      cd.textContent = `${left}s`;
      toastCdTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) { clearInterval(toastCdTimer); return; }
        cd.textContent = `${left}s`;
      }, 1000);
      const b = document.createElement("button");
      b.className = "toast-act";
      b.textContent = action.label || "撤销";
      b.onclick = () => {
        closeToast();
        Promise.resolve().then(action.run)
          .catch((e) => toast(errText(e, "撤销失败"), "err"));
      };
      el.appendChild(cd);
      el.appendChild(b);
    }
    const x = document.createElement("button");
    x.className = "toast-x";
    x.setAttribute("aria-label", "关闭提示");
    x.textContent = "✕";
    x.onclick = closeToast;
    el.appendChild(x);
    $("toastWrap").appendChild(el);
    toastTimer = setTimeout(closeToast, action ? (action.seconds || 10) * 1000 : 2500);
  }

  // ---- 统一确认框（替代全站 confirm/alert/prompt） ----
  // requireText：输入指定文字才能确认（强度 4）
  // input：返回输入内容（string），取消返回 null
  function askDialog(opts = {}) {
    return new Promise((resolve) => {
      const dlg = $("confirmDialog");
      const okBtn = $("cfOk"), cancelBtn = $("cfCancel"), closeBtn = $("cfX");
      const wrap = $("cfInputWrap"), input = $("cfInput"), tip = $("cfInputTip");
      const returnsText = !!opts.input && !opts.requireText;
      const withInput = !!opts.input || !!opts.requireText;
      let done = false;

      $("cfTitle").textContent = opts.title || "确认操作";
      $("cfBody").innerHTML = opts.body || "";
      $("cfBar").hidden = !opts.danger;
      okBtn.textContent = opts.okText || "确定";
      okBtn.className = opts.danger ? "btn-danger" : "wbtn pri";
      cancelBtn.textContent = opts.cancelText || "取消";
      wrap.hidden = !withInput;
      if (withInput) {
        $("cfInputLabel").textContent = opts.inputLabel
          || (opts.requireText ? `请输入「${opts.requireText}」以确认` : (opts.label || ""));
        input.value = opts.value || "";
        input.placeholder = opts.placeholder || "";
        tip.hidden = true;
        okBtn.disabled = opts.requireText
          ? input.value.trim() !== opts.requireText
          : !input.value.trim();
      } else {
        okBtn.disabled = false;
      }

      const onEsc = () => finish(returnsText ? null : false);
      const finish = (val) => {
        if (done) return;
        done = true;
        input.oninput = null; input.onkeydown = null;
        okBtn.onclick = null; cancelBtn.onclick = null; closeBtn.onclick = null;
        dlg.removeEventListener("cancel", onEsc);
        if (dlg.open) dlg.close();
        resolve(val);
      };
      input.oninput = () => {
        if (opts.requireText) {
          okBtn.disabled = input.value.trim() !== opts.requireText;
          tip.hidden = !input.value || input.value.trim() === opts.requireText;
        } else {
          okBtn.disabled = !input.value.trim();
        }
      };
      input.onkeydown = (e) => {
        if (e.key === "Enter" && !okBtn.disabled) { e.preventDefault(); finish(returnsText ? input.value.trim() : true); }
      };
      okBtn.onclick = () => finish(returnsText ? input.value.trim() : true);
      cancelBtn.onclick = () => finish(returnsText ? null : false);
      closeBtn.onclick = () => finish(returnsText ? null : false);
      dlg.addEventListener("cancel", onEsc);
      if (typeof dlg.showModal === "function") dlg.showModal();
      // 危险操作默认焦点永远落在不危险的那一侧
      requestAnimationFrame(() => {
        if (withInput) input.focus();
        else if (opts.danger) cancelBtn.focus();
        else okBtn.focus();
      });
    });
  }
  const confirmDialog = (o) => askDialog(o);
  const inputDialog = (o) => askDialog({ ...o, input: true });

  // ---- 行内 ⋯ 菜单 ----
  function closeKmenu() { $("kmenu").hidden = true; }
  function openKmenu(anchor, items) {
    const menu = $("kmenu");
    menu.innerHTML = items.map((it, i) =>
      `<button role="menuitem" data-i="${i}"${it.danger ? ' class="danger"' : ""}` +
      `${it.disabled ? " disabled" : ""}${it.title ? ` title="${esc(it.title)}"` : ""}>` +
      `${esc(it.label)}</button>`).join("");
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelectorAll("button").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const it = items[+b.dataset.i];
        closeKmenu();
        if (it && !it.disabled && it.run) it.run();
      };
    });
    const first = menu.querySelector("button:not(:disabled)");
    if (first) first.focus();
  }

  // ---- 剪贴板 ----
  async function copyText(text) {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove();
      }
      toast(`已复制 ${text}`);
    } catch (_) { toast("复制失败，请手动选中后按 Ctrl+C", "err"); }
  }

  // ===================== 路由 =====================
  function parseHash() {
    const raw = (location.hash || "").replace(/^#/, "");
    const ix = raw.indexOf("?");
    const pathPart = ix >= 0 ? raw.slice(0, ix) : raw;
    const query = {};
    if (ix >= 0) for (const [k, v] of new URLSearchParams(raw.slice(ix + 1))) query[k] = v;
    const seg = pathPart.split("/").filter(Boolean);
    const mod = seg[0] || "chat";
    if (mod === "kb") {
      return { module: "kb", kbId: seg[1] ? Number(seg[1]) : null, section: seg[2] || "", query };
    }
    if (mod === "admin") return { module: "admin", tab: seg[1] || "index", query };
    // 会话 id 进路径段（与 #kb/{id} 同一套解析）：#chat = 门户(idle)，#chat/s/{id} = 对话
    if (mod === "chat") {
      const sessionId = seg[1] === "s" && seg[2] ? seg[2] : null;
      return { module: "chat", sessionId, query };
    }
    return { module: "unknown", raw: pathPart, query };
  }

  function applyRoute() {
    if (!me) return;
    // 空 hash 用 replaceState 补成 #chat：location.hash= 会压一条历史，按后退会退不出去
    if (!location.hash) history.replaceState(null, "", "#chat");
    const rt = parseHash();
    if (rt.module === "unknown") {
      showView("chat");
      toast("页面不存在，已返回问答", "err");
      navigate("#chat", true);
      return;
    }
    if (rt.module === "admin" && !isSysAdmin()) {
      toast("需要管理员权限，已返回问答", "err");
      navigate("#chat", true);
      return;
    }
    if (rt.module !== "chat") saveChatScroll();
    showView(rt.module);
    if (rt.module === "chat") {
      document.title = "技术支持知识库 · 企业内部版";
      if (rt.sessionId) routeThread(rt.sessionId);
      else routePortal();
      return;
    }
    if (rt.module === "admin") { applyAdminTab(rt.tab); return; }
    if (rt.kbId) routeKbDetail(rt);
    else routeKbList(rt);
  }

  // ===================== 列表页 =====================
  const kbState = {
    loaded: false, loading: false, error: null,
    all: [],
    q: "", dept: "", level: "", status: "",
    page: 1, size: 20, defaultSize: Number(localStorage.getItem("kb_pageSize")) || 20,
    sort: "code", dir: 1,           // 默认「编码 ↑」：稳定顺序建立空间记忆
    selected: new Set(),
    selMode: false,
    density: localStorage.getItem("kb_density") === "compact" ? "compact" : "cozy",
    focusRowId: null,
  };
  kbState.size = kbState.defaultSize;

  const scrollMem = new Map();      // 列表滚动位置只在内存里记，不进 URL
  function listKey() {
    return [kbState.q, kbState.dept, kbState.level, kbState.status, kbState.page, kbState.size].join("|");
  }
  function saveListScroll() {
    scrollMem.set(listKey(), $("viewKb").scrollTop);
    if (scrollMem.size > 20) scrollMem.delete(scrollMem.keys().next().value);
  }
  function restoreListScroll() {
    const y = scrollMem.get(listKey());
    if (y == null) return;
    requestAnimationFrame(() => { $("viewKb").scrollTop = y; });
  }

  function listHash() {
    const p = new URLSearchParams();
    if (kbState.q) p.set("q", kbState.q);
    if (kbState.dept) p.set("dept", kbState.dept);
    if (kbState.level) p.set("level", kbState.level);
    if (kbState.status) p.set("status", kbState.status);
    if (kbState.page > 1) p.set("page", String(kbState.page));
    if (kbState.size !== kbState.defaultSize) p.set("size", String(kbState.size));
    const qs = p.toString();
    return "#kb" + (qs ? `?${qs}` : "");
  }

  function levelTag(lv) {
    const cls = LEVEL_CLS[lv] || "cls-public";
    return `<span class="cls ${cls}">${esc(LEVEL_CN[lv] || "内部")}</span>`;
  }
  function statusTag(st) {
    return st === "archived"
      ? `<span class="st st-arch">归档</span>`
      : `<span class="st st-on">启用</span>`;
  }
  // 授权范围：后端无此字段，按固定规则推导（后端加 scope 字段后此规则立即废弃）
  function scopeCell(kb) {
    if (kb.id === 1) return `<span class="scope scope-all" title="默认知识库对全员开放">全员</span>`;
    if ((kb.group_count || 0) > 0) {
      return `<span class="scope scope-grp" title="另有 ${kb.member_count || 0} 名成员单独授权">${kb.group_count} 组</span>`;
    }
    return `<span class="scope" title="仅指定成员可见">${kb.member_count || 0} 人</span>`;
  }

  function routeKbList(rt) {
    $("kbList").hidden = false;
    $("kbDetail").hidden = true;
    document.title = "知识库 · 技术支持知识库";
    const q = rt.query;
    const next = {
      q: (q.q || "").trim(), dept: q.dept || "", level: q.level || "", status: q.status || "",
    };
    const filtersChanged = next.q !== kbState.q || next.dept !== kbState.dept
      || next.level !== kbState.level || next.status !== kbState.status;
    kbState.q = next.q; kbState.dept = next.dept;
    kbState.level = next.level; kbState.status = next.status;
    kbState.size = Number(q.size) || kbState.defaultSize;
    kbState.page = Math.max(1, Number(q.page) || 1);
    renderListChrome();
    if (filtersChanged || !kbState.loaded) loadKbList();
    else renderListBody();
    restoreListScroll();
  }

  function renderListChrome() {
    $("btnNewKb").hidden = !isSysAdmin();
    $("kbSearch").value = kbState.q;
    // 部门选项 = 现有库的 dept ∪ 固定建议值（非管理员也能拿到，不依赖 /admin/users）
    const depts = new Set(DEPT_SUGGEST);
    for (const k of myKbs) if (k.dept) depts.add(k.dept);
    const sel = $("kbDept");
    sel.innerHTML = `<option value="">全部部门</option>` +
      [...depts].sort((a, b) => a.localeCompare(b, "zh"))
        .map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
    sel.value = kbState.dept;
    if (sel.value !== kbState.dept) { sel.value = ""; kbState.dept = ""; }
    $("kbLevel").value = kbState.level;
    $("kbStatus").value = kbState.status;
    $("kbClear").hidden = !(kbState.q || kbState.dept || kbState.level || kbState.status);
    $("kbSize").value = String(kbState.size);
    $("kbDensity").textContent = kbState.density === "compact" ? "▥" : "▤";
    const tbl = $("kbTable");
    tbl.classList.toggle("is-compact", kbState.density === "compact");
    // 复选框列常驻：display:none 移除 td 会让后续列整体左移一格（colgroup 仍 11 列），名称列掉 0 宽坑
    // $("kbSelMode") 保留为「批量操作」高亮提示，不再控制列可见性
    $("kbSelMode").classList.toggle("on", kbState.selMode);
    $("kbSelMode").setAttribute("aria-pressed", kbState.selMode ? "true" : "false");
    document.querySelectorAll("#kbTable th.sortable").forEach((th) => {
      const on = th.dataset.sort === kbState.sort;
      th.setAttribute("aria-sort", on ? (kbState.dir > 0 ? "ascending" : "descending") : "none");
      const ind = th.querySelector(".sort-ind");
      if (ind) {
        ind.textContent = on ? (kbState.dir > 0 ? "▲" : "▼") : "▲";
        ind.classList.toggle("on", on);
      }
    });
  }

  function showProgress(on) { $("kbProgress").hidden = !on; }

  async function loadKbList() {
    kbState.loading = true;
    kbState.error = null;
    showProgress(true);
    if (!kbState.loaded) renderSkeleton();
    try {
      const p = new URLSearchParams();
      if (kbState.q) p.set("q", kbState.q);
      if (kbState.dept) p.set("dept", kbState.dept);
      if (kbState.level) p.set("level", kbState.level);
      if (kbState.status) p.set("status", kbState.status);
      const qs = p.toString();
      const list = await api(`/kbs${qs ? `?${qs}` : ""}`);
      kbState.all = Array.isArray(list) ? list : [];
      kbState.loaded = true;
      if (!qs) myKbs = kbState.all;             // 未过滤时顺手刷新选项数据
      for (const id of [...kbState.selected]) {
        if (!kbState.all.some((k) => k.id === id)) kbState.selected.delete(id);
      }
    } catch (e) {
      kbState.error = e;
      kbState.all = [];
      kbState.loaded = true;
    }
    kbState.loading = false;
    showProgress(false);
    renderListChrome();
    renderListBody();
  }

  function sortKbs(list) {
    const dir = kbState.dir;
    const arr = list.slice();
    arr.sort((a, b) => {
      if (kbState.sort === "files") {
        return dir * ((a.file_count || 0) - (b.file_count || 0)) || (a.id - b.id);
      }
      // 默认（也是唯一剩余的可排序列）：编码升序，空编码恒排最后
      const av = a.code || "", bv = b.code || "";
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      if (av !== bv) return dir * (av < bv ? -1 : 1);
      return a.id - b.id;
    });
    return arr;
  }

  // 三态循环：无 → ↑ → ↓ → 无（第三态回默认序列；排序不进 URL，只影响本机偏好）
  function cycleSort(key) {
    if (!key) return;
    if (kbState.sort !== key) { kbState.sort = key; kbState.dir = 1; }
    else if (kbState.dir > 0) { kbState.dir = -1; }
    else { kbState.sort = "code"; kbState.dir = 1; }
    kbState.page = 1;
    history.replaceState(null, "", listHash());
    renderListChrome();
    renderListBody();
  }

  function renderSkeleton() {
    const row = `<tr class="skel-row" aria-hidden="true">
      <td class="c-check"></td>
      <td><span class="sk sk-w1"></span><span class="sk sk-w2 sk-mt"></span></td>
      <td class="c-code"><span class="sk sk-w3"></span></td>
      <td class="c-dept"><span class="sk sk-w2"></span></td>
      <td class="c-level"><span class="sk sk-w2"></span></td>
      <td class="c-scope"><span class="sk sk-w2"></span></td>
      <td class="c-status"><span class="sk sk-w2"></span></td>
      <td class="c-files"><span class="sk sk-w2"></span></td>
      <td class="c-owner"><span class="sk sk-w2"></span></td>
      <td class="c-time"><span class="sk sk-w3"></span></td>
      <td class="c-ops"></td></tr>`;
    $("kbTbody").innerHTML = row.repeat(6);
    $("kbEmpty").innerHTML = "";
    $("kbFootInfo").textContent = "加载中…";
    $("kbPager").innerHTML = "";
  }

  function renderListBody() {
    if (kbState.error) return renderListError(kbState.error);
    const rows = sortKbs(kbState.all);
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / kbState.size));
    if (kbState.page > pages) kbState.page = pages;
    const start = (kbState.page - 1) * kbState.size;
    const pageRows = rows.slice(start, start + kbState.size);
    renderRows(pageRows);
    renderCards(pageRows);
    renderEmpty(total, rows);
    renderFoot(total, pages);
    $("kbListSub").textContent = total ? `共 ${total} 个` : "";
    $("kbCaption").textContent = `知识库列表，共 ${total} 个`;
    updateBulkbar();
    if (kbState.focusRowId) {
      const id = kbState.focusRowId;
      kbState.focusRowId = null;
      const tr = document.querySelector(`#kbTbody tr[data-id="${id}"]`);
      if (tr) requestAnimationFrame(() => tr.focus());
    }
  }

  function kbRowHTML(kb) {
    const t = tsInfo(kb.updated_at);
    const sel = kbState.selected.has(kb.id);
    const files = kb.file_count || 0;
    const pend = kb.pending_count || 0;
    return `<tr tabindex="0" data-id="${kb.id}"${sel ? ' class="is-sel"' : ""}>
      <td class="c-check"><input type="checkbox" class="kb-ck"${sel ? " checked" : ""}
        aria-label="选择 ${esc(kb.name)}"></td>
      <td>
        <span class="cell-main" title="${esc(kb.name)}">${esc(kb.name)}${kb.id === 1 ? '<span class="mono-xs"> · 默认</span>' : ""}</span>
        <span class="cell-sub" title="${esc(kb.description || "")}">${esc(kb.description || "无描述")}</span>
      </td>
      <td class="c-code mono-xs" title="${esc(kb.code || "")}">${kb.code ? esc(kb.code) : '<span class="dash">—</span>'}</td>
      <td class="c-dept" title="${esc(kb.dept || "")}">${kb.dept ? esc(kb.dept) : '<span class="dash">—</span>'}</td>
      <td class="c-level">${levelTag(kb.level)}</td>
      <td class="c-scope">${scopeCell(kb)}</td>
      <td class="c-status">${statusTag(kb.status)}</td>
      <td class="c-files num">${files ? files : '<span class="dash">—</span>'}
        ${pend ? `<span class="cell-sub">待审 ${pend}</span>` : ""}</td>
      <td class="c-owner" title="${esc(kb.owner || "")}">${kb.owner ? esc(kb.owner) : '<span class="dash">—</span>'}</td>
      <td class="c-time time" title="${esc(t.full)}">${t.text}</td>
      <td class="c-ops"><span class="row-ops">
        <button class="rop" data-act="open">打开</button>
        <button class="rop" data-act="more" aria-label="更多操作" aria-haspopup="menu">⋯</button>
      </span></td>
    </tr>`;
  }

  function renderRows(rows) {
    const tb = $("kbTbody");
    tb.innerHTML = rows.map(kbRowHTML).join("");
    tb.querySelectorAll("tr").forEach((tr) => {
      const id = Number(tr.dataset.id);
      tr.onclick = () => openKb(id);
      tr.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); openKb(id); }
      };
      const ck = tr.querySelector(".kb-ck");
      if (ck) {
        ck.onclick = (e) => { e.stopPropagation(); toggleSelect(id, ck.checked); };
        ck.onkeydown = (e) => e.stopPropagation();
      }
      tr.querySelectorAll("[data-act]").forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); rowAction(b.dataset.act, id, b); };
      });
    });
  }

  function renderCards(rows) {
    const el = $("kbCards");
    el.innerHTML = rows.map((kb) => {
      const t = tsInfo(kb.updated_at);
      const sel = kbState.selected.has(kb.id);
      return `<div class="kb-card" data-id="${kb.id}" tabindex="0" role="button">
        <div class="kb-card-top">
          <input type="checkbox" class="kb-ck"${sel ? " checked" : ""} aria-label="选择 ${esc(kb.name)}">
          <span class="kb-card-name">${esc(kb.name)}</span>
          ${statusTag(kb.status)}
          <button class="rop" data-act="more" aria-label="更多操作">⋯</button>
        </div>
        <div class="kb-card-sub">${kb.code ? esc(kb.code) : "未编码"}${kb.dept ? ` · ${esc(kb.dept)}` : ""}</div>
        <div class="kb-card-meta">
          ${levelTag(kb.level)}${scopeCell(kb)}
          <span>${kb.file_count || 0} 个文件</span>
          <span>${t.text}</span>
        </div>
      </div>`;
    }).join("");
    el.querySelectorAll(".kb-card").forEach((card) => {
      const id = Number(card.dataset.id);
      card.classList.toggle("is-sel", kbState.selected.has(id));
      card.onclick = () => openKb(id);
      card.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); openKb(id); }
      };
      const ck = card.querySelector(".kb-ck");
      ck.onclick = (e) => { e.stopPropagation(); toggleSelect(id, ck.checked); };
      const more = card.querySelector("[data-act='more']");
      more.onclick = (e) => { e.stopPropagation(); rowAction("more", id, more); };
    });
  }

  function renderEmpty(total, allRows) {
    const el = $("kbEmpty");
    const hint = $("kbHint");
    const hasFilter = !!(kbState.q || kbState.dept || kbState.level || kbState.status);
    if (total > 0) {
      el.innerHTML = "";
      const onlyDefault = total === 1 && allRows[0] && allRows[0].id === 1 && !hasFilter;
      hint.hidden = !onlyDefault;
      if (onlyDefault) {
        hint.innerHTML = isSysAdmin()
          ? `<span>只有一个默认库 · 默认库是内置语料，不能上传。</span><button class="linklike hb-act" id="kbHintNew">新建一个知识库</button><span>来放你们部门的文档</span>`
          : `<span>只有一个默认库 · 默认库是内置语料，不能上传。请联系管理员为你建库。</span>`;
        const b = $("kbHintNew");
        if (b) b.onclick = () => openKbForm("create");
      }
      return;
    }
    hint.hidden = true;
    if (hasFilter) {
      el.innerHTML = `<div class="tbl-empty"><span class="te-glyph">▤</span>
        <div class="te-title">没有符合条件的知识库</div>
        <div class="te-sub">试试缩短关键词，或清除筛选</div>
        <button class="wbtn" id="kbEmptyClear">清除筛选</button></div>`;
      $("kbEmptyClear").onclick = () => clearFilters();
      return;
    }
    el.innerHTML = `<div class="tbl-empty"><span class="te-glyph">▤</span>
      <div class="te-title">还没有知识库</div>
      <div class="te-sub">先建一个，把制度文档传进来</div>
      ${isSysAdmin() ? `<button class="wbtn pri" id="kbEmptyNew">新建知识库</button>`
        : `<span class="te-sub">请联系管理员为你建库</span>`}</div>`;
    const b = $("kbEmptyNew");
    if (b) b.onclick = () => openKbForm("create");
  }

  function renderListError(err) {
    $("kbTbody").innerHTML = "";
    $("kbHint").hidden = true;
    const msg = err.status === 403 ? "当前账号无权查看知识库列表，请联系管理员开通"
      : err.status === 0 ? "读取知识库列表时网络中断，请检查网络后重试"
        : `读取知识库列表失败：${err.message}`;
    $("kbEmpty").innerHTML = `<div class="tbl-empty err"><span class="te-glyph">▤</span>
      <div class="te-title">列表读取失败</div>
      <div class="te-sub">${esc(msg)}</div>
      <button class="wbtn" id="kbRetry">重试</button></div>`;
    $("kbRetry").onclick = () => loadKbList();
    $("kbFootInfo").textContent = "—";
    $("kbPager").innerHTML = "";
  }

  function pageWindow(cur, pages) {
    if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
    const set = new Set([1, pages, cur, cur - 1, cur + 1]);
    if (cur <= 3) [2, 3, 4].forEach((n) => set.add(n));
    if (cur >= pages - 2) [pages - 1, pages - 2, pages - 3].forEach((n) => set.add(n));
    const arr = [...set].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
    const out = [];
    arr.forEach((n, i) => {
      if (i && n - arr[i - 1] > 1) out.push("...");
      out.push(n);
    });
    return out;
  }

  function renderFoot(total, pages) {
    $("kbFootInfo").textContent = total
      ? `共 ${total} 个 · 第 ${kbState.page}/${pages} 页` : "共 0 个";
    const pager = $("kbPager");
    pager.innerHTML = "";
    if (pages <= 1) return;
    const add = (label, page, dis, on, aria) => {
      const b = document.createElement("button");
      b.className = "pg" + (on ? " on" : "");
      b.textContent = label;
      b.disabled = !!dis;
      if (aria) b.setAttribute("aria-label", aria);
      if (on) b.setAttribute("aria-current", "page");
      b.onclick = () => goPage(page);
      pager.appendChild(b);
    };
    add("‹", kbState.page - 1, kbState.page === 1, false, "上一页");
    for (const n of pageWindow(kbState.page, pages)) {
      if (n === "...") { add("…", kbState.page, true, false, "省略的页码"); continue; }
      add(String(n), n, false, n === kbState.page);
    }
    add("›", kbState.page + 1, kbState.page === pages, false, "下一页");
  }

  function goPage(n) {
    kbState.page = Math.max(1, n);
    history.pushState(null, "", listHash());
    renderListBody();
    $("viewKb").scrollTop = 0;
  }

  function applyFilter(patch, opts = {}) {
    Object.assign(kbState, patch);
    if (!opts.keepPage) kbState.page = 1;
    const hash = listHash();
    if (opts.replace) history.replaceState(null, "", hash);
    else history.pushState(null, "", hash);
    renderListChrome();
    loadKbList();
  }

  function clearFilters() {
    applyFilter({ q: "", dept: "", level: "", status: "" });
  }

  function openKb(id) {
    saveListScroll();
    kbState.focusRowId = id;
    navigate(`#kb/${id}/files`);
  }

  // ---- 勾选与批量条 ----
  function toggleSelect(id, on) {
    if (on) kbState.selected.add(id); else kbState.selected.delete(id);
    const tr = document.querySelector(`#kbTbody tr[data-id="${id}"]`);
    if (tr) tr.classList.toggle("is-sel", on);
    const card = document.querySelector(`.kb-card[data-id="${id}"]`);
    if (card) card.classList.toggle("is-sel", on);
    updateBulkbar();
  }

  function updateBulkbar() {
    const n = kbState.selected.size;
    const on = n > 0;
    $("kbBulkbar").classList.toggle("on", on);
    $("kbToolbar").hidden = on;
    $("kbBulkCount").textContent = `已选 ${n} 项`;
    const hasDefault = kbState.selected.has(1);
    ["kbBulkArchive", "kbBulkDelete"].forEach((k) => {
      $(k).disabled = hasDefault;
      $(k).title = hasDefault ? "选中项含默认知识库，它不可归档 / 删除" : "";
    });
    $("kbBulkRestore").disabled = hasDefault;
    $("kbBulkRestore").title = hasDefault ? "选中项含默认知识库，它不可归档 / 恢复" : "";
    // 表头复选框三态
    const ids = sortKbs(kbState.all).map((k) => k.id);
    const all = $("kbCheckAll");
    const pageIds = sortKbs(kbState.all)
      .slice((kbState.page - 1) * kbState.size, kbState.page * kbState.size).map((k) => k.id);
    const selOnPage = pageIds.filter((id) => kbState.selected.has(id)).length;
    all.checked = pageIds.length > 0 && selOnPage === pageIds.length;
    all.indeterminate = selOnPage > 0 && selOnPage < pageIds.length;
    all.disabled = ids.length === 0;
  }

  async function rowAction(act, id, anchor) {
    const kb = kbState.all.find((k) => k.id === id);
    if (!kb) return;
    if (act === "open") return openKb(id);
    if (act !== "more") return;
    const items = [];
    if (canManageRole(kb.my_role)) {
      items.push({ label: "成员与授权", run: () => { saveListScroll(); navigate(`#kb/${id}/members`); } });
    }
    if (isSysAdmin()) {
      items.push({ label: "查看审计", run: () => navigate("#admin/audit") });
    }
    items.push({
      label: kb.status === "archived" ? "恢复启用" : "归档",
      disabled: !isSysAdmin(),
      title: isSysAdmin() ? "" : "归档需要平台管理员权限",
      run: () => toggleArchive(kb),
    });
    if (kb.code) items.push({ label: "复制编码", run: () => copyText(kb.code) });
    if (id !== 1) {
      items.push({
        label: "删除知识库", danger: true,
        disabled: !isSysAdmin(),
        title: isSysAdmin() ? "" : "删除需要平台管理员权限",
        run: () => deleteKb(kb),
      });
    }
    if (!items.length) return;
    openKmenu(anchor, items);
  }

  async function toggleArchive(kb) {
    const toArchived = kb.status !== "archived";
    const t = tsInfo(kb.updated_at);
    const ok = await confirmDialog({
      title: toArchived ? `归档「${kb.name}」？` : `恢复「${kb.name}」的检索？`,
      body: toArchived
        ? `<p>它的文档将不再参与新的问答检索，历史回答里的引用仍可查看。</p>` +
          `<p>历史授权与成员全部保留，随时可以恢复启用。</p>` +
          `<div class="cf-band">${kb.file_count || 0} 个文档、${kb.member_count || 0} 名成员、${kb.group_count || 0} 个分组授权 · 最后变更 ${esc(t.full)}</div>`
        : `<p>恢复后本库文档立即重新参与问答检索。</p>`,
      okText: toArchived ? "归档" : "恢复启用",
      danger: false,
    });
    if (!ok) return;
    try {
      await api(`/admin/kbs/${kb.id}`, { method: "PATCH", body: { status: toArchived ? "archived" : "active" } });
      toast(toArchived ? `已归档「${kb.name}」，问答将不再引用本库` : `已恢复「${kb.name}」的检索`, "ok",
        { label: "撤销", run: async () => {
          await api(`/admin/kbs/${kb.id}`, { method: "PATCH", body: { status: toArchived ? "active" : "archived" } });
          toast("已撤销");
          refreshListQuiet();
        } });
      refreshListQuiet();
    } catch (e) {
      toast(errText(e, toArchived ? "归档失败" : "恢复失败"), "err");
    }
  }

  async function deleteKb(kb) {
    const t = tsInfo(kb.updated_at);
    const ok = await confirmDialog({
      title: `删除知识库「${kb.name}」？`,
      body: `<p>这个库有 ${kb.file_count || 0} 个文档、${kb.member_count || 0} 名成员、${kb.group_count || 0} 个分组授权。</p>` +
        `<p>删除后文档将不可见，成员与分组授权一并失效，问答不再引用。</p>` +
        `<p class="cf-warn">此操作不可撤销，界面内无法恢复。</p>` +
        `<div class="cf-band">最后变更 ${esc(t.full)}</div>`,
      danger: true,
      requireText: kb.name,
      inputLabel: `请输入库名「${kb.name}」以确认`,
      okText: "永久删除",
    });
    if (!ok) return;
    try {
      await api(`/admin/kbs/${kb.id}`, { method: "DELETE" });
      toast(`已删除「${kb.name}」`);
      if (detail && detail.id === kb.id) navigate("#kb");
      else refreshListQuiet();
    } catch (e) {
      toast(errText(e, "删除失败"), "err");
    }
  }

  async function refreshListQuiet() {
    await loadKbList();
    if (!$("kbDetail").hidden && detail && detail.kb) {
      try { await reloadDetail(currentSection()); } catch (_) { /* 忽略 */ }
    }
  }

  // ---- 批量操作（串行 N 次，逐条记录结果） ----
  async function bulkRun(ids, fn) {
    const results = [];
    for (const id of ids) {
      const kb = kbState.all.find((k) => k.id === id) || { id, name: `#${id}` };
      try { await fn(id); results.push({ ok: true, id, name: kb.name }); }
      catch (e) { results.push({ ok: false, id, name: kb.name, msg: errText(e) }); }
    }
    return results;
  }

  function showResults(title, results, retry) {
    const okList = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    const body = `<p>${okList.length} 个成功，${bad.length} 个失败</p><ul>` +
      results.map((r) => `<li>${r.ok ? "✓" : "✕"} ${esc(r.name)}　${esc(r.ok ? "已完成" : `失败：${r.msg}`)}</li>`).join("") +
      `</ul>${bad.length && retry ? `<div class="cf-band">重试只会再跑失败的那 ${bad.length} 项。</div>` : ""}`;
    openDocDialog({ kind: "执行结果", title, bodyHTML: body });
    if (bad.length && retry) {
      const btn = document.createElement("button");
      btn.className = "wbtn";
      btn.textContent = `重试失败的 ${bad.length} 项`;
      btn.onclick = () => { $("docDialog").close(); retry(bad.map((b) => b.id)); };
      $("ddBody").appendChild(btn);
    }
  }

  async function bulkStatus(status) {
    const ids = [...kbState.selected].filter((id) => id !== 1);
    if (!ids.length) return;
    const label = status === "archived" ? "归档" : "恢复启用";
    const ok = await confirmDialog({
      title: `${label} ${ids.length} 个知识库？`,
      body: status === "archived"
        ? `<p>它们的文档将不再参与问答检索，历史授权保留。随时可以恢复。</p>`
        : `<p>恢复后这些库的文档立即重新参与问答检索。</p>`,
      okText: `${label} ${ids.length} 个`,
    });
    if (!ok) return;
    const results = await bulkRun(ids, (id) =>
      api(`/admin/kbs/${id}`, { method: "PATCH", body: { status } }));
    const bad = results.filter((r) => !r.ok);
    if (!bad.length) {
      toast(`已${label} ${results.length} 个知识库`);
      kbState.selected.clear();
    } else {
      showResults(`${label}结果`, results, async (retryIds) => {
        const again = await bulkRun(retryIds, (id) =>
          api(`/admin/kbs/${id}`, { method: "PATCH", body: { status } }));
        showResults(`${label}重试结果`, again, null);
        refreshListQuiet();
      });
      kbState.selected.clear();
    }
    refreshListQuiet();
  }

  async function bulkDelete() {
    const ids = [...kbState.selected].filter((id) => id !== 1);
    if (!ids.length) return;
    const names = ids.map((id) => (kbState.all.find((k) => k.id === id) || {}).name || `#${id}`);
    const docCount = ids.reduce((s, id) =>
      s + ((kbState.all.find((k) => k.id === id) || {}).file_count || 0), 0);
    const shown = names.slice(0, 3).join("、");
    const ok = await confirmDialog({
      title: `删除 ${ids.length} 个知识库？`,
      body: `<p>这些库共 ${docCount} 个文档将同时不可见，成员与分组授权一并失效，问答不再引用。</p>` +
        `<p>${esc(shown)}${names.length > 3 ? ` 等 ${ids.length} 个` : ""}</p>` +
        `<p class="cf-warn">此操作不可撤销，界面内无法恢复。</p>`,
      danger: true,
      requireText: "DELETE",
      inputLabel: "请输入 DELETE 以确认",
      okText: `永久删除 ${ids.length} 个`,
    });
    if (!ok) return;
    const results = await bulkRun(ids, (id) => api(`/admin/kbs/${id}`, { method: "DELETE" }));
    kbState.selected.clear();
    const bad = results.filter((r) => !r.ok);
    if (!bad.length) toast(`已删除 ${results.length} 个知识库`);
    else showResults("删除结果", results, async (retryIds) => {
      const again = await bulkRun(retryIds, (id) => api(`/admin/kbs/${id}`, { method: "DELETE" }));
      showResults("删除重试结果", again, null);
      refreshListQuiet();
    });
    refreshListQuiet();
  }

  // ===================== 详情页 =====================
  let detail = null;   // {id, kb, role, files, members, groups, candidates, loadedAt, 各种 err}

  function routeKbDetail(rt) {
    $("kbList").hidden = true;
    $("kbDetail").hidden = false;
    if (!rt.section) {
      // #kb/7 → #kb/7/files，不留历史
      history.replaceState(null, "", `#kb/${rt.kbId}/files`);
      rt.section = "files";
    }
    const sec = ["files", "members", "groups", "settings"].includes(rt.section) ? rt.section : "files";
    $("viewKb").scrollTop = 0;
    openKbDetail(rt.kbId, sec);
    // 焦点落在标题上：读屏用户需要知道「页面变了」（交互规范 §9.3）
    requestAnimationFrame(() => {
      const h = $("kbDTitle");
      if (h && !h.closest("[hidden]")) h.focus({ preventScroll: true });
    });
  }

  function canManage() { return !!detail && canManageRole(detail.role); }

  async function openKbDetail(kbId, section) {
    if (!detail || detail.id !== kbId) {
      detail = { id: kbId, kb: null, role: null, files: null, members: null, groups: null, candidates: null, loadedAt: 0 };
    }
    const fromList = myKbs.find((k) => k.id === kbId);
    if (!detail.kb && fromList) detail.kb = fromList;
    currentKb = kbId;
    renderDetailHead();
    renderSubnav(section);
    showSection(section);
    const fresh = detail.loadedAt && Date.now() - detail.loadedAt < 60000;
    if (!fresh) await reloadDetail(section);
    else if (section === "files") renderFiles();
    else if (section === "members") renderMembers();
    else if (section === "groups") renderGroups();
    else renderSettings();
  }

  async function reloadDetail(section) {
    const d = detail;
    try {
      let kb = myKbs.find((k) => k.id === d.id);
      if (!kb) {
        const list = await api("/kbs");
        myKbs = Array.isArray(list) ? list : [];
        kb = myKbs.find((k) => k.id === d.id);
      }
      if (!kb) { renderNoAccess(); return; }
      d.kb = kb;
      d.role = kb.my_role;
      // 成员 / 分组授权需要显示名与分组来源：系统管理员顺手拉一次用户表
      if (isSysAdmin() && !(allUsers || []).length) {
        try { allUsers = await api("/admin/users"); } catch (_) { /* 忽略 */ }
      }
      const fr = await api(`/kbs/${d.id}/files`);
      d.role = fr.my_role || d.role;
      d.files = fr.files || [];
      d.filesErr = null;
      currentKbRole = d.role;
      if (canManageRole(d.role)) {
        const [mem, grp] = await Promise.all([
          api(`/kbs/${d.id}/members`).catch((e) => e),
          api(`/kbs/${d.id}/groups`).catch((e) => e),
        ]);
        d.members = Array.isArray(mem) ? mem : null;
        d.membersErr = Array.isArray(mem) ? null : mem;
        d.groups = Array.isArray(grp) ? grp : null;
        d.groupsErr = Array.isArray(grp) ? null : grp;
      }
      d.loadedAt = Date.now();
    } catch (e) {
      if (e.status === 403) { renderNoAccess(); return; }
      d.filesErr = e;
      d.files = d.files || [];
    }
    renderDetailHead();
    renderSubnav(currentSection());
    if (section === "files") renderFiles();
    else if (section === "members") renderMembers();
    else if (section === "groups") renderGroups();
    else renderSettings();
  }

  function currentSection() {
    const rt = parseHash();
    return rt.module === "kb" && rt.kbId ? (rt.section || "files") : "files";
  }

  function renderNoAccess() {
    const el = $("kbSecFiles");
    $("kbDTitle").textContent = "无权访问";
    $("kbDCode").textContent = "";
    $("kbDLevel").innerHTML = "";
    $("kbDStatus").innerHTML = "";
    $("kbDMeta").textContent = "";
    $("kbDActions").hidden = true;
    $("kbSubnav").hidden = true;
    ["kbSecMembers", "kbSecGroups", "kbSecSettings"].forEach((k) => { $(k).hidden = true; });
    el.hidden = false;
    el.innerHTML = `<div class="sec-locked">
      <div class="sl-title" tabindex="-1">你没有访问这个知识库的权限</div>
      <div class="sl-sub">它可能已被删除，也可能需要管理员授权。请联系知识库负责人或系统管理员。</div>
      <button class="linklike" id="kbBackList">返回知识库列表</button></div>`;
    $("kbBackList").onclick = () => navigate("#kb");
    document.title = "无权访问 · 知识库";
    $("kbSecFiles").querySelector(".sl-title").focus();
  }

  function renderDetailHead() {
    const kb = detail && detail.kb;
    if (!kb) { $("kbDTitle").textContent = "加载中…"; return; }
    $("kbDActions").hidden = false;
    $("kbSubnav").hidden = false;
    document.title = `${kb.name} · 知识库`;
    $("kbCrumbNow").textContent = kb.name;
    $("kbCrumbNow").title = kb.name;
    $("kbDTitle").textContent = kb.name;
    $("kbDCode").textContent = kb.code || "未编码";
    $("kbDLevel").innerHTML = levelTag(kb.level);
    $("kbDStatus").innerHTML = statusTag(kb.status);
    const t = tsInfo(kb.updated_at);
    $("kbDMeta").textContent = `${kb.member_count || 0} 个成员 · ${kb.file_count || 0} 个文件 · 最后更新 ${t.text}`;
    $("kbDMeta").title = `最后变更：${t.full}（元信息与文件的最后变更时间）`;
    const canUp = canWriteRole(detail.role) && kb.id !== 1;
    $("kbDUpload").hidden = !canUp;
    $("kbDEdit").hidden = !isSysAdmin();
    $("kbCntFiles").textContent = kb.file_count ? String(kb.file_count) : "";
    $("kbCntMembers").textContent = kb.member_count ? String(kb.member_count) : "";
    $("kbCntGroups").textContent = kb.group_count ? String(kb.group_count) : "";
  }

  function renderSubnav(section) {
    document.querySelectorAll("#kbSubnav .subnav-item").forEach((b) => {
      const on = b.dataset.sec === section;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.setAttribute("aria-controls", `kbSec${b.dataset.sec[0].toUpperCase()}${b.dataset.sec.slice(1)}`);
      if (on) b.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
  }

  function showSection(section) {
    const map = { files: "kbSecFiles", members: "kbSecMembers", groups: "kbSecGroups", settings: "kbSecSettings" };
    for (const k of Object.keys(map)) $(map[k]).hidden = k !== section;
  }

  function sectionErrorHTML(label, err) {
    return `<div class="sec-err"><span>${esc(label)}读取失败：${esc(err && err.message || "未知错误")}</span>
      <button class="wbtn sm" id="secRetry">重试</button></div>`;
  }
  function bindSectionRetry() {
    const b = $("secRetry");
    if (b) b.onclick = () => reloadDetail(currentSection());
  }

  // ---------- 文件分区 ----------
  // ---- 文件分区：一张表（pending 行不抽独立列表，交互规范 v1.4 §5.1） ----
  const FILE_ST_CLS = { approved: "st-on", pending: "st-pending", rejected: "st-reject" };
  let fSel = new Set();       // 待审批行勾选（批量批准复用复选框列）
  let fSort = 0;              // 0 基准（待审优先 → 时间倒序）/ 1 时间↓ / -1 时间↑
  let rvFile = null;          // 审核弹窗当前文件

  function filesOrdered(list) {
    const arr = list.slice();
    arr.sort((a, b) => {
      const ta = a.uploaded_at || 0, tb = b.uploaded_at || 0;
      if (fSort === 0) {
        const pa = a.status === "pending" ? 0 : 1;
        const pb = b.status === "pending" ? 0 : 1;
        if (pa !== pb) return pa - pb;           // 待审置顶
        return (tb - ta) || (a.id - b.id);
      }
      // 点过列头就是纯时间序，不再夹带「待审批优先」
      return fSort * (tb - ta) || (a.id - b.id);
    });
    return arr;
  }

  function fileStatusTag(st) {
    return `<span class="st ${FILE_ST_CLS[st] || "st-arch"}">${esc(FILE_ST_CN[st] || st)}</span>`;
  }

  function fileActsHTML(f, approve) {
    const pending = f.status === "pending";
    const md = /\.(md|txt)$/i.test(f.name);
    const mine = !!(me && f.uploader === me.username);
    const out = [];
    const b = (act, label, cls, title) =>
      `<button class="rop${cls ? ` ${cls}` : ""}" data-fa="${act}" data-id="${f.id}"` +
      ` aria-label="${esc(label + " " + f.name)}"` +
      `${title ? ` title="${esc(title)}"` : ""}>${label}</button>`;
    if (pending && approve) out.push(b("rv", "审批"));
    // 预览与下载走同一个后端口子（previewFile 就是去拉 /download），所以判据必须一致，
    // 否则「已驳回」的行会渲染出点了必 403 的按钮。approve 对 pending 行不额外给预览：
    // 审批弹窗里本来就能看内容，多一个按钮会把 124px 的操作列撑破。
    const canRead = f.status === "approved" || approve || mine;
    if (!pending && md && canRead) out.push(b("pv", "预览"));
    if (canRead) out.push(b("dl", "下载", "", md ? "" : "该类型无法在线预览，下载后查看"));
    if (approve) out.push(b("del", "删除", "danger"));
    return out.join("");
  }

  function fileMeta(f) {
    return [`v${f.version || 1}`, fmtSize(f.size), f.uploader, f.chunks ? `${f.chunks} 分块` : ""]
      .filter(Boolean).map((x) => esc(x)).join(" · ");
  }

  function fileRowHTML(f, approve) {
    const t = tsInfo(f.uploaded_at);
    const pending = f.status === "pending";
    const sel = fSel.has(f.id);
    return `<tr data-fid="${f.id}"${sel ? ' class="is-sel"' : ""}>
      <td class="f-check">${pending && approve
        ? `<input type="checkbox" class="f-ck" data-id="${f.id}"${sel ? " checked" : ""}
             aria-label="选择待审批文件 ${esc(f.name)}">` : ""}</td>
      <td class="f-name">
        <span class="cell-main" title="${esc(f.name)}">${esc(f.name)}</span>
        <span class="cell-sub">${fileMeta(f)}<span class="cell-sub-time"> · ${esc(t.text)}</span></span>
      </td>
      <td class="f-status">${fileStatusTag(f.status)}</td>
      <td class="f-time" title="${esc(t.full)}">${esc(t.text)}</td>
      <td class="f-act"><span class="row-ops">${fileActsHTML(f, approve)}</span></td>
    </tr>`;
  }

  function fileCardHTML(f, approve) {
    const t = tsInfo(f.uploaded_at);
    return `<div class="f-card" data-fid="${f.id}">
      <div class="f-card-top">
        <span class="f-card-name" title="${esc(f.name)}">${esc(f.name)}</span>
        ${fileStatusTag(f.status)}
      </div>
      <div class="f-card-sub">${fileMeta(f)} · ${esc(t.text)}</div>
      <div class="f-card-acts">${fileActsHTML(f, approve)}</div>
    </div>`;
  }

  function renderFiles() {
    const d = detail, kb = d.kb, el = $("kbSecFiles");
    if (!kb) { el.innerHTML = ""; return; }
    el.hidden = false;
    const canUp = canWriteRole(d.role) && kb.id !== 1;
    const approve = canManage();
    const all = d.files || [];
    const pending = all.filter((f) => f.status === "pending");
    const rows = filesOrdered(all);
    for (const id of [...fSel]) if (!pending.some((f) => f.id === id)) fSel.delete(id);
    const hint = pending.length
      ? `<div class="hint-bar amber" id="fPendHint">
           <span>待审批 <b class="hb-count">${pending.length}</b> 个，审核通过后才会进入问答索引。</span>
           <span class="wspacer"></span>
           ${approve ? `<button class="wbtn sm" id="fApproveAll">${
             fSel.size ? `批准所选 ${fSel.size} 个` : "全部批准"}</button>` : ""}
         </div>`
      : "";
    el.innerHTML = `
      <div class="sec-head">
        <h2 class="sec-title" tabindex="-1">文件</h2>
        <span class="sec-sub">${all.length ? `共 ${all.length} 个` : ""}</span>
        <div class="sec-acts">
          ${canUp ? `<button class="wbtn" id="fPick">＋ 上传文件</button>` : ""}
        </div>
      </div>
      ${d.filesErr ? sectionErrorHTML("文件列表", d.filesErr) : ""}
      ${kb.id === 1 ? `<div class="sec-note">默认库内容为内置语料，不在此列出；清单见「控制台 → 语料索引」。如需上传自建文档请先创建新知识库。</div>` : ""}
      ${!canUp && kb.id !== 1 ? `<div class="sec-note">${d.role === "viewer" ? "你是只读成员：可查询与下载，如需上传请联系库管理员。" : "当前角色无法上传文件。"}</div>` : ""}
      <div class="upqueue" id="kbQueue"></div>
      ${canUp ? `<div class="dropzone" id="kbDrop" tabindex="0" role="button" aria-label="上传文件">
        把文件拖到这里，或 <em>点击选择</em>（≤20MB · md/txt/pdf/docx/xlsx/pptx · 可多选）</div>
        <input type="file" id="kbFileInput" accept=".md,.txt,.pdf,.docx,.xlsx,.pptx" multiple hidden>` : ""}
      ${hint}
      <div class="ftable-wrap">
        <table class="kbtable ftable" id="fTable">
          <caption class="sr-only">文件列表，共 ${all.length} 个</caption>
          <colgroup><col class="f-check"><col><col class="f-status"><col class="f-time"><col class="f-act"></colgroup>
          <thead><tr>
            <th class="f-check" scope="col">${approve && pending.length
              ? `<input type="checkbox" id="fCheckAll" aria-label="全选待审批文件">` : ""}</th>
            <th scope="col">文件名</th>
            <th class="f-status" scope="col">状态</th>
            <th class="f-time sortable" scope="col" data-fsort="time" tabindex="0"
                aria-sort="${fSort > 0 ? "descending" : fSort < 0 ? "ascending" : "none"}">
              上传时间<span class="sort-ind${fSort ? " on" : ""}">${fSort < 0 ? "▲" : "▼"}</span></th>
            <th class="f-act" scope="col">操作</th>
          </tr></thead>
          <tbody id="fTbody">${rows.map((f) => fileRowHTML(f, approve)).join("")}</tbody>
        </table>
        <div class="f-cards" id="fCards">${rows.map((f) => fileCardHTML(f, approve)).join("")}</div>
        <div id="fEmpty">${all.length ? "" : `<div class="tbl-empty">
          <div class="te-title">${kb.id === 1 ? "默认库不含上传文件" : "这个库还没有文件"}</div>
          <div class="te-sub">${kb.id === 1
            ? "默认库的内容是内置语料，清单见「控制台 → 语料索引」。"
            : "上传后会先进入待审批，审核通过才进入问答索引。"}</div>
        </div>`}</div>
        <div class="kbtable-foot ftable-foot" id="fFoot">
          <span>${all.length ? `共 ${all.length} 个${pending.length ? ` · 待审批 ${pending.length} 个` : ""}` : "—"}</span>
        </div>
      </div>`;
    bindSectionRetry();
    el.querySelectorAll("[data-fa]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); fileAction(b.dataset.fa, Number(b.dataset.id)); };
    });
    el.querySelectorAll(".f-ck").forEach((ck) => {
      ck.onclick = (e) => {
        e.stopPropagation();
        const id = Number(ck.dataset.id);
        if (ck.checked) fSel.add(id); else fSel.delete(id);
        renderFiles();
      };
    });
    const allCk = $("fCheckAll");
    if (allCk) {
      allCk.checked = pending.length > 0 && fSel.size === pending.length;
      allCk.indeterminate = fSel.size > 0 && fSel.size < pending.length;
      allCk.onchange = () => {
        if (allCk.checked) pending.forEach((f) => fSel.add(f.id));
        else fSel.clear();
        renderFiles();
      };
    }
    if ($("fApproveAll")) {
      $("fApproveAll").onclick = () => approveAll(
        fSel.size ? pending.filter((f) => fSel.has(f.id)) : pending);
    }
    const th = el.querySelector("th[data-fsort]");
    if (th) {
      th.onclick = () => cycleFileSort();
      th.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cycleFileSort(); }
      };
    }
    if (canUp) {
      bindUpload();
      const pick = $("fPick");
      if (pick) pick.onclick = () => { const inp = $("kbFileInput"); if (inp) inp.click(); };
    }
  }

  function cycleFileSort() {
    fSort = fSort === 0 ? 1 : (fSort === 1 ? -1 : 0);
    renderFiles();
  }

  async function fileAction(action, fid) {
    const f = (detail.files || []).find((x) => x.id === fid);
    const name = f ? f.name : `#${fid}`;
    if (action === "dl") return downloadFile(fid, name);
    if (action === "pv") return previewFile(fid, name);
    if (action === "rv") return openReview(fid);
    if (action === "del") {
      const ok = await confirmDialog({
        title: `删除「${name}」？`,
        body: `<p>文件会退出索引，问答将不再引用它的内容。</p>` +
          `<p class="cf-warn">此操作不可撤销，界面内无法恢复；如仍需要请重新上传。</p>`,
        danger: true,
        okText: "删除文件",
      });
      if (!ok) return;
      try {
        await api(`/files/${fid}`, { method: "DELETE" });
        toast(`已删除「${name}」`);
        await reloadDetail("files");
        refreshListQuiet();
      } catch (e) { toast(errText(e, "删除失败"), "err"); }
    }
  }

  // ---- 审核弹窗：内容放进弹窗，「没看到内容就批不了」才是结构性保证 ----
  function showRejectState(on) {
    $("rvFoot1").hidden = on;
    $("rvFoot2").hidden = !on;
  }

  async function openReview(fid) {
    const f = (detail.files || []).find((x) => x.id === fid);
    if (!f) return;
    rvFile = f;
    const dlg = $("reviewDialog");
    $("rvTitle").textContent = `审批「${f.name}」`;
    $("rvMeta").textContent = [`v${f.version || 1}`, fmtSize(f.size), f.uploader,
      `${tsInfo(f.uploaded_at).text}上传`].filter(Boolean).join(" · ");
    $("rvErr").hidden = true;
    $("rvBody").innerHTML = `<p class="admin-hint">正在读取文件内容…</p>`;
    showRejectState(false);
    $("rvApprove").disabled = true;
    if (typeof dlg.showModal === "function") dlg.showModal();
    const md = /\.(md|txt)$/i.test(f.name);
    if (!md) {
      $("rvBody").innerHTML = `<p class="form-note">该类型无法在线预览，请先下载核对。</p>` +
        `<button class="wbtn" id="rvDl">下载「${esc(f.name)}」</button>`;
      $("rvDl").onclick = () => downloadFile(f.id, f.name);
      $("rvApprove").disabled = false;
      return;
    }
    try {
      const r = await fetch(`${API_BASE}/kbs/${detail.id}/files/${f.id}/download`,
        { headers: authHeaders(false) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || `HTTP ${r.status}`);
      }
      const text = await r.text();
      const cut = text.length > 50000;
      $("rvBody").innerHTML = `<div class="md doc-preview">${mdRender(text.slice(0, 50000))}</div>` +
        (cut ? `<p class="form-note">仅显示前 50000 字，请下载核对全文。</p>
                <button class="wbtn" id="rvDl2">下载全文</button>` : "");
      const d2 = $("rvDl2");
      if (d2) d2.onclick = () => downloadFile(f.id, f.name);
      $("rvApprove").disabled = false;
    } catch (e) {
      $("rvBody").innerHTML = `<p class="cf-warn">无法读取文件：「${esc(f.name)}」可能已被清理。</p>`;
      $("rvErr").hidden = false;
      $("rvErr").textContent = e.message;
      $("rvApprove").disabled = true;   // 读不到内容就不该让人批
    }
  }

  async function approveFromReview() {
    if (!rvFile) return;
    const f = rvFile;
    $("rvApprove").disabled = true;
    try {
      const d = await api(`/files/${f.id}/approve`, { method: "POST" });
      $("reviewDialog").close();
      toast(`已入库「${f.name}」${d && d.chunks ? ` · ${d.chunks} 分块` : ""}，已进入问答索引`);
      await reloadDetail("files");
      refreshListQuiet();
    } catch (e) {
      $("reviewDialog").close();
      toast("批准失败：文件不存在或不在待审批状态", "err");
      reloadDetail("files");
    } finally {
      const b = $("rvApprove");
      if (b) b.disabled = false;
    }
  }

  async function rejectFromReview() {
    if (!rvFile) return;
    const f = rvFile;
    const btn = $("rvRejectYes");
    btn.disabled = true;
    try {
      await api(`/files/${f.id}/reject`, { method: "POST" });
      $("reviewDialog").close();
      toast(`已驳回「${f.name}」`);
      await reloadDetail("files");
      refreshListQuiet();
    } catch (e) {
      toast("驳回失败：文件不在待审批状态", "err");
      $("reviewDialog").close();
      reloadDetail("files");
    } finally {
      btn.disabled = false;
    }
  }

  async function approveAll(pending) {
    if (!pending.length) return;
    const names = pending.slice(0, 5).map((f) => f.name);
    const ok = await confirmDialog({
      title: `批准 ${pending.length} 个待审文件？`,
      body: `<p>批准后这些文件立即进入问答索引。</p><ul>` +
        names.map((n) => `<li>${esc(n)}</li>`).join("") +
        `</ul>${pending.length > 5 ? `<p>等 ${pending.length} 个</p>` : ""}` +
        `<div class="cf-band">批准后无法退回待审批状态，请确认内容已核对。</div>`,
      okText: `批准 ${pending.length} 个`,
    });
    if (!ok) return;
    const results = await bulkRun(pending.map((f) => f.id),
      (id) => api(`/files/${id}/approve`, { method: "POST" }));
    results.forEach((r, i) => { if (pending[i]) r.name = pending[i].name; });
    const bad = results.filter((r) => !r.ok);
    if (!bad.length) toast(`已批准 ${results.length} 个文件入库`);
    else {
      showResults("批准结果", results, async (retryIds) => {
        await bulkRun(retryIds, (id) => api(`/files/${id}/approve`, { method: "POST" }));
        reloadDetail("files");
      });
    }
    fSel.clear();
    await reloadDetail("files");
    refreshListQuiet();
  }

  async function downloadFile(fid, name) {
    try {
      const r = await fetch(`${API_BASE}/kbs/${detail.id}/files/${fid}/download`,
        { headers: authHeaders(false) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const dispo = r.headers.get("Content-Disposition") || "";
      const m = dispo.match(/filename\*=UTF-8''([^;]+)/);
      const fname = m ? decodeURIComponent(m[1]) : (name || `file_${fid}`);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast(`下载失败：${e.message}（文件可能已被清理）`, "err");
    }
  }

  // 预览 .md/.txt 原文。待审批文件也能预览——否则管理员只能盲批
  async function previewFile(fid, name) {
    try {
      const r = await fetch(`${API_BASE}/kbs/${detail.id}/files/${fid}/download`,
        { headers: authHeaders(false) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || `HTTP ${r.status}`);
      }
      const text = await r.text();
      const cut = text.length > 50000;
      openDocDialog({
        kind: "原文预览",
        title: name || `文件 ${fid}`,
        bodyHTML: `<div class="md doc-preview">${mdRender(text.slice(0, 50000))}</div>` +
          (cut ? `<p class="dd-path">内容超过 5 万字符，仅显示前 5 万字符。</p>` : ""),
      });
    } catch (e) {
      toast(`预览失败：${e.message}（文件可能已被清理）`, "err");
    }
  }

  // ---------- 上传队列：串行，一次 1 个 ----------
  let upQueue = [], upRunning = false;
  function bindUpload() {
    const dz = $("kbDrop"), fi = $("kbFileInput");
    if (!dz || !fi) return;
    dz.onclick = () => fi.click();
    dz.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); }
    };
    fi.onchange = () => {
      if (fi.files && fi.files.length) enqueueFiles([...fi.files]);
      fi.value = "";
    };
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("over");
      if (e.dataTransfer.files && e.dataTransfer.files.length) enqueueFiles([...e.dataTransfer.files]);
    });
  }

  function enqueueFiles(files) {
    for (const f of files) {
      const item = { file: f, name: f.name, state: "wait", msg: "" };
      if (!EXT_RE.test(f.name)) {
        item.state = "err";
        item.msg = `不支持的文件类型（仅 md/txt/pdf/docx/xlsx/pptx）`;
      } else if (f.size > MAX_MB * 1024 * 1024) {
        item.state = "err";
        item.msg = `文件 ${fmtSize(f.size)}，超过 ${MAX_MB}MB 上限`;
      } else {
        const same = (detail.files || []).find((x) => x.name === f.name);
        if (same) item.tip = `已存在（v${same.version || 1}），上传后将覆盖并自动备份旧版`;
      }
      upQueue.push(item);
    }
    renderQueue();
    runQueue();
  }

  function renderQueue() {
    const el = $("kbQueue");
    if (!el) return;
    if (!upQueue.length) { el.innerHTML = ""; return; }
    const show = upQueue.slice(0, 5);
    el.innerHTML = show.map((it, i) => {
      const st = it.state === "err" ? "err" : it.state === "ok" ? "ok"
        : it.state === "busy" ? "busy" : "";
      const label = it.state === "wait" ? "等待"
        : it.state === "busy" ? "上传中…"
          : it.state === "ok" ? (it.msg || "已完成")
            : `失败：${it.msg}`;
      return `<div class="upq-row" data-i="${i}">
        <span class="upq-name" title="${esc(it.name)}">${esc(it.name)}</span>
        ${it.tip ? `<span class="upq-tip">${esc(it.tip)}</span>` : ""}
        <span class="upq-st ${st}">${esc(label)}</span>
        ${it.state === "err" ? `<button class="rop" data-retry="${i}">重试</button>` : ""}
      </div>`;
    }).join("") + (upQueue.length > 5 ? `<div class="upq-more">还有 ${upQueue.length - 5} 个…</div>` : "");
    el.querySelectorAll("[data-retry]").forEach((b) => {
      b.onclick = () => {
        const it = upQueue[Number(b.dataset.retry)];
        if (!it) return;
        it.state = "wait"; it.msg = "";
        renderQueue(); runQueue();
      };
    });
  }

  async function runQueue() {
    if (upRunning || !detail) return;
    const next = upQueue.find((it) => it.state === "wait");
    if (!next) return;
    upRunning = true;
    next.state = "busy";
    renderQueue();
    try {
      const fd = new FormData();
      fd.append("file", next.file);
      const d = await api(`/kbs/${detail.id}/upload`, { method: "POST", body: fd });
      next.state = "ok";
      next.msg = d.status === "approved" ? "已直接入库" : "已提交，待库管理员审批";
    } catch (e) {
      next.state = "err";
      next.msg = e.message;
    }
    upRunning = false;
    renderQueue();
    await reloadDetail("files");
    refreshListQuiet();
    renderQueue();          // renderFiles 重建了队列容器，这里补一次渲染
    // 成功的条目 5s 后从队列移除
    setTimeout(() => {
      upQueue = upQueue.filter((it) => it.state !== "ok");
      renderQueue();
    }, 5000);
    runQueue();
  }

  // ---------- 成员分区 ----------
  function userMap() {
    const m = new Map();
    for (const u of allUsers || []) m.set(u.username, u);
    return m;
  }
  function roleOptionsHTML(cur) {
    return ["viewer", "editor", "kb_admin"].map((r) =>
      `<option value="${r}"${r === cur ? " selected" : ""}>${ROLE_CN[r]} ${r}</option>`).join("");
  }
  function groupRoleOf(username) {
    const u = userMap().get(username);
    const g = u && u.group ? u.group.trim() : "";
    if (!g) return null;
    const hit = (detail.groups || []).find((x) => (x.grp || "").trim() === g);
    return hit ? { grp: hit.grp, role: hit.role } : null;
  }

  // ---- 成员表：6 列，角色恒一个值 + 来源链（视觉 §11.1/§11.3，交互 D2） ----
  let mSort = 0;   // 0 基准（角色权重降序 → 姓名升序）/ 1 授予时间↓ / -1 授予时间↑

  function memberName(m) {
    const u = userMap().get(m.username);
    const dn = u && u.display_name;
    return dn && dn !== m.username ? dn : "";
  }

  function memberOrder(list) {
    const arr = list.slice();
    arr.sort((a, b) => {
      if (mSort !== 0) {
        return mSort * ((b.granted_at || 0) - (a.granted_at || 0)) || 0;
      }
      // 后端 ORDER BY role 是字符串序（editor → kb_admin → viewer），必须前端按权重降序重排
      const d = (ROLE_RANK[b.role] || 0) - (ROLE_RANK[a.role] || 0);
      if (d) return d;
      return (memberName(a) || a.username).localeCompare(memberName(b) || b.username, "zh");
    });
    return arr;
  }

  function roleTitle(m, grp) {
    if (m.username === ((detail.kb || {}).created_by || "")) return `创建者恒为库管理员`;
    if (!grp) return `生效角色来自直接授权`;
    if ((ROLE_RANK[m.role] || 0) < (ROLE_RANK[grp.role] || 0)) {
      return `个人授权优先于分组授权，已覆盖分组「${grp.grp}」的 ${ROLE_CN[grp.role] || grp.role}`;
    }
    return `生效角色来自直接授权（同时属分组「${grp.grp}」，个人授权优先）`;
  }

  function memberSrcHTML(m, grp) {
    if (m.username === ((detail.kb || {}).created_by || "")) {
      return `<span class="src"><span class="src-direct">创建者</span></span>`;
    }
    if (!grp) return `<span class="src"><span class="src-direct">直接</span></span>`;
    const full = `直接（另 ▤ ${grp.grp}）`;
    return `<span class="src" title="${esc(full)}">` +
      `<span class="src-direct">直接</span>` +
      `<span class="src-also">（另 ▤ ${esc(grp.grp)}）</span></span>`;
  }

  function memberRowHTML(m, ctx) {
    const shown = memberName(m);
    const grp = groupRoleOf(m.username);
    const isCreator = m.username === (ctx.createdBy || "");
    const roleCls = `r-${m.role}`;
    const lastAdmin = m.role === "kb_admin" && ctx.adminCount <= 1 && !isCreator;
    const nameCell = shown
      ? `<span class="cell-main" title="${esc(shown)}">${esc(shown)}</span>
         <span class="cell-sub">@${esc(m.username)}${ctx.disabled ? " · 已停用" : ""}</span>`
      : `<span class="cell-main mono-name" title="${esc(m.username)}">${esc(m.username)}${ctx.disabled ? " · 已停用" : ""}</span>`;
    const subSrc = "决定来源：直接";
    const t = tsInfo(m.granted_at);
    return `<tr data-u="${esc(m.username)}">
      <td class="m-name">${nameCell}<span class="cell-sub cell-sub-src">${esc(subSrc)}</span></td>
      <td class="m-role"><span class="role ${roleCls}" title="${esc(roleTitle(m, grp))}">${ROLE_CN[m.role] || m.role}</span></td>
      <td class="m-source">${memberSrcHTML(m, grp)}</td>
      <td class="m-grantor" title="${esc(m.granted_by || "")}">${m.granted_by ? esc(m.granted_by) : '<span class="dash">—</span>'}</td>
      <td class="m-time" title="${esc(t.full)}">${esc(t.text)}</td>
      <td class="m-act"><span class="row-ops">
        <button class="rop" data-mrole="${esc(m.username)}"${isCreator
          ? ' disabled title="创建者恒为库管理员，请添加其他成员作为库管理员"' : ""}>改角色</button>
        <button class="rop danger" data-mrm="${esc(m.username)}"${isCreator || m.role === "kb_admin"
          ? ` disabled title="${isCreator ? "创建者不可移除" : "库管理员不可直接移除，请先把角色改为「只读」"}"` : ""}>移除</button>
      </span></td>
    </tr>`;
  }

  function memberCardHTML(m, ctx) {
    const shown = memberName(m) || m.username;
    const grp = groupRoleOf(m.username);
    const isCreator = m.username === (ctx.createdBy || "");
    return `<div class="m-card">
      <div class="m-card-top">
        <span class="m-card-name">${esc(shown)}</span>
        <span class="role r-${m.role}">${ROLE_CN[m.role] || m.role}</span>
      </div>
      <div class="m-card-sub">@${esc(m.username)} · ${esc(memberSrcHTML(m, grp).replace(/<[^>]+>/g, ""))}</div>
      <div class="m-card-acts">
        <button class="rop" data-mrole="${esc(m.username)}"${isCreator ? " disabled" : ""}>改角色</button>
        <button class="rop danger" data-mrm="${esc(m.username)}"${isCreator || m.role === "kb_admin" ? " disabled" : ""}>移除</button>
      </div>
    </div>`;
  }

  function renderMembers() {
    const d = detail, el = $("kbSecMembers");
    if (!canManage()) {
      el.innerHTML = `<div class="sec-locked">
        <div class="sl-title" tabindex="-1">需要知识库管理员权限</div>
        <div class="sl-sub">成员与授权只对库管理员开放。你现在是本库的「${esc(ROLE_CN[d.role] || d.role || "无角色")}」，仍然可以查看与下载文件。</div>
        <button class="linklike" id="secGoFiles">返回文件列表</button></div>`;
      $("secGoFiles").onclick = () => navigate(`#kb/${d.id}/files`);
      return;
    }
    if (d.membersErr) { el.innerHTML = sectionErrorHTML("成员列表", d.membersErr); bindSectionRetry(); return; }
    const list = d.members || [];
    const kb = d.kb || {};
    const ctx = {
      createdBy: kb.created_by || "",
      adminCount: list.filter((x) => x.role === "kb_admin").length,
      disabled: false,
    };
    const rows = memberOrder(list);
    const grps = d.groups || [];
    let hint = "";
    if (list.length === 1) {
      const ppl = knownGroups().filter((g) => grps.some((x) => (x.grp || "") === g.group))
        .reduce((n, g) => n + g.total, 0);
      hint = grps.length
        ? `<div class="hint-bar"><span>除你之外没有单独授权的成员；当前 ${grps.length} 个分组（${ppl} 人）可访问本库。</span>
             <button class="hb-act linklike" id="memHintAdd">添加成员</button></div>`
        : `<div class="hint-bar"><span>目前只有你（创建者）能访问这个库。</span>
             <button class="hb-act linklike" id="memHintAdd">添加成员</button>
             <button class="hb-act linklike" id="memHintGrp">按分组授权</button></div>`;
    }
    el.innerHTML = `
      <div class="sec-head">
        <h2 class="sec-title" tabindex="-1">成员与授权</h2>
        <span class="sec-sub">共 ${list.length} 人</span>
      </div>
      <div class="sec-note">个人授权优先于分组授权：同一人既有个人角色又在已授权分组里时，按<b>个人角色</b>生效（可能比分组更严格）。</div>
      <div class="kb-create">
        <input id="memUser" class="grow" list="memCands" maxlength="32" autocomplete="off"
               placeholder="输入用户名，或从候选中选择">
        <datalist id="memCands"></datalist>
        <select id="memRole" class="role-select" aria-label="角色">${roleOptionsHTML("viewer")}</select>
        <button class="wbtn" id="memAdd">授权</button>
      </div>
      <p class="form-note">默认「只读」——安全的那一边。库管理员不能直接被移除，需要先把角色改为「只读」。</p>
      ${hint}
      <div class="mtable-wrap">
        <table class="kbtable mtable" id="mTable">
          <caption class="sr-only">成员与授权，共 ${list.length} 人</caption>
          <colgroup><col><col class="m-role"><col class="m-source"><col class="m-grantor"><col class="m-time"><col class="m-act"></colgroup>
          <thead><tr>
            <th scope="col">成员</th>
            <th class="m-role" scope="col">生效角色</th>
            <th class="m-source" scope="col" title="深色在前 = 决定来源">授权来源</th>
            <th class="m-grantor" scope="col">授予人</th>
            <th class="m-time sortable" scope="col" tabindex="0"
                aria-sort="${mSort > 0 ? "descending" : mSort < 0 ? "ascending" : "none"}">
              授予时间<span class="sort-ind${mSort ? " on" : ""}">${mSort < 0 ? "▲" : "▼"}</span></th>
            <th class="m-act" scope="col">操作</th>
          </tr></thead>
          <tbody id="mTbody">${rows.map((m) => memberRowHTML(m, ctx)).join("")}</tbody>
        </table>
        <div class="m-cards" id="mCards">${rows.map((m) => memberCardHTML(m, ctx)).join("")}</div>
        ${list.length ? "" : `<div class="tbl-empty">
          <div class="te-title">成员数据为空</div>
          <div class="te-sub">未读到创建者记录，请刷新或联系平台管理员。</div>
        </div>`}
      </div>`;
    el.querySelectorAll("[data-mrole]").forEach((b) => {
      if (b.disabled) return;
      b.onclick = (e) => { e.stopPropagation(); openRoleMenu(b.dataset.mrole, b, ctx); };
    });
    el.querySelectorAll("[data-mrm]").forEach((b) => {
      if (b.disabled) return;
      b.onclick = () => removeMember(b.dataset.mrm);
    });
    const th = el.querySelector("th[data-msort], th.sortable");
    if (th) {
      th.onclick = () => { mSort = mSort === 0 ? 1 : (mSort === 1 ? -1 : 0); renderMembers(); };
      th.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          mSort = mSort === 0 ? 1 : (mSort === 1 ? -1 : 0);
          renderMembers();
        }
      };
    }
    if ($("memHintAdd")) $("memHintAdd").onclick = () => { const u = $("memUser"); if (u) u.focus(); };
    if ($("memHintGrp")) $("memHintGrp").onclick = () => navigate(`#kb/${d.id}/groups`);
    $("memAdd").onclick = addMember;
    loadCandidates();
  }

  // 改角色：小弹层三选一，选中即生效（不叠确认框——可随时改回）
  function openRoleMenu(username, anchor, ctx) {
    const cur = ((detail.members || []).find((x) => x.username === username) || {}).role || "viewer";
    const lastAdmin = cur === "kb_admin" && ctx.adminCount <= 1;
    const items = ["viewer", "editor", "kb_admin"].map((r) => ({
      label: `${r === cur ? "✓ " : ""}${ROLE_CN[r]} ${r}`,
      disabled: r === cur || (lastAdmin && r !== "kb_admin"),
      title: lastAdmin && r !== "kb_admin"
        ? "该成员是当前唯一的库管理员，请先指定另一名库管理员" : "",
      run: () => changeMemberRole(username, r),
    }));
    openKmenu(anchor, items);
  }

  async function changeMemberRole(username, newRole) {
    const list = detail.members || [];
    const cur = (list.find((x) => x.username === username) || {}).role;
    if (!cur || newRole === cur) return;
    const adminCount = list.filter((x) => x.role === "kb_admin").length;
    if (cur === "kb_admin" && adminCount <= 1 && newRole !== "kb_admin") {
      toast("这是本库唯一的库管理员。请先把另一位成员设为库管理员，再修改这个人的角色。", "err");
      return;
    }
    try {
      await api(`/kbs/${detail.id}/members`, { method: "POST", body: { username, role: newRole } });
      toast(`「${username}」的角色已改为「${ROLE_CN[newRole]}」`);
      await reloadDetail("members");
      refreshListQuiet();
    } catch (e) {
      toast(errText(e, "改角色失败"), "err");
    }
  }

  async function removeMember(username) {
    const role = ((detail.members || []).find((x) => x.username === username) || {}).role || "viewer";
    const ok = await confirmDialog({
      title: `移除成员「${username}」？`,
      body: `<p>移除后该账号不再通过个人授权访问本库。如果它所属的分组也被授权，仍会通过分组获得权限。</p>`,
      okText: "移除",
    });
    if (!ok) return;
    try {
      await api(`/kbs/${detail.id}/members/${encodeURIComponent(username)}`, { method: "DELETE" });
      toast(`已移除「${username}」`, "ok", {
        label: "撤销",
        run: async () => {
          await api(`/kbs/${detail.id}/members`, { method: "POST", body: { username, role } });
          toast("已撤销移除");
          reloadDetail("members");
        },
      });
      await reloadDetail("members");
      refreshListQuiet();
    } catch (e) {
      toast(e.status === 404 ? "移除失败：成员不存在或为库管理员" : errText(e, "移除失败"), "err");
    }
  }

  async function addMember() {
    const el = $("memUser");
    const name = (el.value || "").trim();
    const role = $("memRole").value;
    if (!name) { toast("请填写或选择用户名", "err"); el.focus(); return; }
    try {
      await api(`/kbs/${detail.id}/members`, { method: "POST", body: { username: name, role } });
      toast(`已授权 ${name} 为「${ROLE_CN[role]}」`);
      el.value = "";
      $("memRole").value = "viewer";
      await reloadDetail("members");
      const again = $("memUser");
      if (again) again.focus();
      refreshListQuiet();
    } catch (e) {
      toast(e.status === 404 ? `用户 ${name} 不存在，请检查拼写` : errText(e, "授权失败"), "err");
    }
  }

  async function loadCandidates() {
    const dl = $("memCands");
    if (!dl) return;
    if (detail.candidates) return fillCands(dl, detail.candidates);
    try {
      const d = await api(`/kbs/${detail.id}/candidate-users`);
      detail.candidates = d.users || [];
      fillCands(dl, detail.candidates);
    } catch (_) { /* 拿不到候选就让用户手输，后端会校验 */ }
  }
  function fillCands(dl, users) {
    dl.innerHTML = users.map((u) =>
      `<option value="${esc(u.username)}">${esc(u.display_name || u.username)}${u.group ? ` · ${esc(u.group)}` : ""}</option>`).join("");
  }

  // ---------- 分组授权分区 ----------
  function knownGroups() {
    const m = new Map();
    for (const u of allUsers || []) {
      const g = (u.group || "").trim();
      if (!g) continue;
      const c = m.get(g) || { group: g, total: 0, active: 0 };
      c.total += 1;
      if (u.status === "active") c.active += 1;
      m.set(g, c);
    }
    return [...m.values()].sort((a, b) => b.total - a.total || a.group.localeCompare(b.group, "zh"));
  }

  // ---- 分组授权表：6 列，人数是治理判断的依据（视觉 §11.2，交互 D3） ----
  let gSort = "";        // "" 基准（人数降序 → 组名升序）/ "count" / "time"
  let gDir = 0;

  function groupInfo(grp, known) {
    const hit = known.find((k) => k.group === grp);
    return hit || null;
  }

  function groupOrder(list, known) {
    const arr = list.slice();
    arr.sort((a, b) => {
      const ia = groupInfo((a.grp || "").trim(), known);
      const ib = groupInfo((b.grp || "").trim(), known);
      const ca = ia ? ia.total : 0;
      const cb = ib ? ib.total : 0;
      if (gSort === "count" && gDir) return gDir * (cb - ca) || 0;
      if (gSort === "time" && gDir) return gDir * ((b.granted_at || 0) - (a.granted_at || 0)) || 0;
      // 基准：人数降序（影响面大的先看到）→ 组名升序
      return (cb - ca) || (a.grp || "").localeCompare(b.grp || "", "zh");
    });
    return arr;
  }

  function groupRowHTML(g, known) {
    const grp = g.grp || "";
    const info = groupInfo(grp.trim(), known);
    const orphan = known.length > 0 && !info;
    const total = info ? info.total : 0;
    const inactive = info ? Math.max(0, info.total - info.active) : 0;
    const big = total >= 20;
    const t = tsInfo(g.granted_at);
    const sub = orphan
      ? `<span class="cell-sub-orphan">该分组当前没有任何成员</span>`
      : (inactive ? `<span class="cell-sub">${inactive} 未激活</span>` : "");
    const countTitle = orphan ? "该分组当前没有任何成员"
      : `该分组 ${total} 人${inactive ? `（${inactive} 人未激活）` : ""}${big ? `，改动将同时影响 ${total} 人` : ""}`;
    return `<tr data-g="${esc(grp)}">
      <td class="g-name">
        <span class="cell-main" title="${esc(grp)}">${esc(grp)}</span>
        ${sub}
        <span class="cell-sub cell-sub-count">${total} 人${inactive ? ` · ${inactive} 未激活` : ""}</span>
      </td>
      <td class="g-count${big ? " big" : ""}" title="${esc(countTitle)}">${total}</td>
      <td class="g-role"><span class="role r-${g.role}">${ROLE_CN[g.role] || g.role}</span></td>
      <td class="g-grantor" title="${esc(g.granted_by || "")}">${g.granted_by ? esc(g.granted_by) : '<span class="dash">—</span>'}</td>
      <td class="g-time" title="${esc(t.full)}">${esc(t.text)}</td>
      <td class="g-act"><span class="row-ops">
        ${orphan ? "" : `<button class="rop" data-grole="${esc(grp)}">改角色</button>`}
        <button class="rop danger" data-grm="${esc(grp)}"
          title="${esc(`收回后该组 ${total} 人将失去本库访问权`)}">收回</button>
      </span></td>
    </tr>`;
  }

  function groupCardHTML(g, known) {
    const grp = g.grp || "";
    const info = groupInfo(grp.trim(), known);
    const total = info ? info.total : 0;
    return `<div class="g-card">
      <div class="g-card-top">
        <span class="g-card-name">${esc(grp)}</span>
        <span class="role r-${g.role}">${ROLE_CN[g.role] || g.role}</span>
      </div>
      <div class="g-card-sub">${total} 人 · ${g.granted_by ? esc(g.granted_by) : "—"}</div>
    </div>`;
  }

  function renderGroups() {
    const d = detail, el = $("kbSecGroups");
    if (!canManage()) {
      el.innerHTML = `<div class="sec-locked">
        <div class="sl-title" tabindex="-1">需要知识库管理员权限</div>
        <div class="sl-sub">分组授权只对库管理员开放。</div>
        <button class="linklike" id="secGoFiles2">返回文件列表</button></div>`;
      $("secGoFiles2").onclick = () => navigate(`#kb/${d.id}/files`);
      return;
    }
    if (d.groupsErr) { el.innerHTML = sectionErrorHTML("分组授权", d.groupsErr); bindSectionRetry(); return; }
    const list = d.groups || [];
    const known = knownGroups();
    const rows = groupOrder(list, known);
    el.innerHTML = `
      <div class="sec-head">
        <h2 class="sec-title" tabindex="-1">分组授权</h2>
        <span class="sec-sub">共 ${list.length} 组</span>
      </div>
      <div class="sec-note">整组授权对该分组的全部成员生效（含之后加入该组的账号）；个人授权仍可单独收紧某个人。</div>
      <div class="kb-create">
        ${known.length
          ? `<select id="grpSel" class="role-select grow" aria-label="选择分组">
               ${known.map((g) => `<option value="${esc(g.group)}">${esc(g.group)} · ${g.total} 人</option>`).join("")}
             </select>`
          : `<input id="grpName" class="grow" maxlength="32" placeholder="分组名（需与用户管理中的分组一致）">`}
        <select id="grpRole" class="role-select" aria-label="角色">${roleOptionsHTML("viewer")}</select>
        <button class="wbtn" id="grpAdd">整组授权</button>
      </div>
      ${known.length ? "" : `<p class="form-note">拿不到分组清单（需要平台管理员权限）。请先到「控制台 → 用户管理 → 设分组」核对分组名，写错会被服务端拒绝。</p>`}
      <div class="gtable-wrap">
        <table class="kbtable gtable" id="gTable">
          <caption class="sr-only">分组授权，共 ${list.length} 组</caption>
          <colgroup><col><col class="g-count"><col class="g-role"><col class="g-grantor"><col class="g-time"><col class="g-act"></colgroup>
          <thead><tr>
            <th scope="col">分组</th>
            <th class="g-count sortable" scope="col" tabindex="0"
                aria-sort="${gSort === "count" ? (gDir > 0 ? "descending" : "ascending") : "none"}">人数</th>
            <th class="g-role" scope="col">角色</th>
            <th class="g-grantor" scope="col">授权人</th>
            <th class="g-time sortable" scope="col" tabindex="0"
                aria-sort="${gSort === "time" ? (gDir > 0 ? "descending" : "ascending") : "none"}">授予时间</th>
            <th class="g-act" scope="col">操作</th>
          </tr></thead>
          <tbody id="gTbody">${rows.map((g) => groupRowHTML(g, known)).join("")}</tbody>
        </table>
        <div class="g-cards" id="gCards">${rows.map((g) => groupCardHTML(g, known)).join("")}</div>
        ${list.length ? "" : `<div class="tbl-empty">
          <div class="te-title">还没有整组授权</div>
          <div class="te-sub">按分组授权后，组内成员（含之后新加入该组的账号）自动获得权限</div>
          <button class="wbtn pri" id="grpEmptyAdd">＋ 整组授权</button>
        </div>`}
      </div>`;
    el.querySelectorAll("[data-grm]").forEach((b) => {
      b.onclick = () => revokeGroup(b.dataset.grm);
    });
    el.querySelectorAll("[data-grole]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); openGroupRoleMenu(b.dataset.grole, b); };
    });
    const sortTh = (key) => {
      const next = gSort === key ? (gDir === 0 ? 1 : (gDir > 0 ? -1 : 0)) : 1;
      if (next === 0) { gSort = ""; gDir = 0; } else { gSort = key; gDir = next; }
      renderGroups();
    };
    el.querySelectorAll("th.sortable").forEach((th) => {
      const key = th.classList.contains("g-count") ? "count" : "time";
      th.onclick = () => sortTh(key);
      th.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortTh(key); }
      };
    });
    $("grpAdd").onclick = grantGroup;
    if ($("grpEmptyAdd")) $("grpEmptyAdd").onclick = () => {
      const s = $("grpSel") || $("grpName");
      if (s) s.focus();
    };
  }

  function openGroupRoleMenu(grp, anchor) {
    const cur = ((detail.groups || []).find((x) => (x.grp || "") === grp) || {}).role || "viewer";
    openKmenu(anchor, ["viewer", "editor", "kb_admin"].map((r) => ({
      label: `${r === cur ? "✓ " : ""}${ROLE_CN[r]} ${r}`,
      disabled: r === cur,
      run: () => changeGroupRole(grp, r),
    })));
  }

  async function changeGroupRole(grp, role) {
    const cur = ((detail.groups || []).find((x) => (x.grp || "") === grp) || {}).role;
    if (!cur || cur === role) return;
    const n = (knownGroups().find((k) => k.group === grp) || {}).total || 0;
    if (n >= 20) {
      // 影响一批人：护栏放在确认环节，行内不加任何警示
      const ok = await confirmDialog({
        title: `把「${grp}」的角色改为「${ROLE_CN[role]}」？`,
        body: bigGroupLine(n) + `<p>该组 ${n} 名成员的角色将同时变更，立即生效。</p>`,
        okText: "保存",
      });
      if (!ok) return;
    }
    try {
      await api(`/kbs/${detail.id}/groups`, { method: "POST", body: { group: grp, role } });
      toast(`「${grp}」的角色已改为「${ROLE_CN[role]}」`);
      await reloadDetail("groups");
      refreshListQuiet();
    } catch (e) {
      toast(errText(e, "改角色失败"), "err");
    }
  }

  function groupPeople(grp) {
    return (allUsers || []).filter((u) => (u.group || "").trim() === grp)
      .map((u) => u.display_name || u.username);
  }

  // 人数 ≥20：行内零警示，护栏全在这一行 amber 上（视觉 §11.4）
  function bigGroupLine(n) {
    return n >= 20 ? `<p class="cf-amber">本次改动影响 ${n} 人</p>` : "";
  }

  async function grantGroup() {
    const selEl = $("grpSel");
    const grp = ((selEl ? selEl.value : ($("grpName") ? $("grpName").value : "")) || "").trim();
    const role = $("grpRole").value;
    if (!grp) { toast("请选择或填写分组名", "err"); return; }
    const info = knownGroups().find((k) => k.group === grp);
    const n = info ? info.total : 0;
    const exists = (detail.groups || []).find((x) => (x.grp || "") === grp);
    const ok = await confirmDialog({
      title: exists ? `把「${grp}」的角色改为「${ROLE_CN[role]}」？` : `授权「${grp}」访问本库？`,
      body: (n >= 20 ? `<p class="cf-amber">该组 ${n} 人将立即获得访问权</p>` : "") +
        `<p>${n ? `该组 ${n} 名成员` : "该组全体成员"}将立即获得本库「${ROLE_CN[role]}」权限。</p>` +
        (exists ? `<p>当前角色「${ROLE_CN[exists.role] || exists.role}」，改后立即生效。</p>` : ""),
      okText: "授权",
    });
    if (!ok) return;
    try {
      await api(`/kbs/${detail.id}/groups`, { method: "POST", body: { group: grp, role } });
      toast(`已授权「${grp}」${n ? `（${n} 人）` : ""}访问本库，角色「${ROLE_CN[role]}」`);
      await reloadDetail("groups");
      refreshListQuiet();
    } catch (e) {
      // 后端会校验分组存在，400 的 detail 直接显示（交互规范 §5.3.1）
      toast(errText(e, "授权失败"), "err");
    }
  }

  async function revokeGroup(grp) {
    const info = knownGroups().find((k) => k.group === grp);
    const people = groupPeople(grp);
    const n = info ? info.total : people.length;
    const ok = await confirmDialog({
      title: `解除「${grp}」的整组授权？`,
      body: bigGroupLine(n) +
        `<p>该组 ${n || "全体"} 名成员将无法再检索本库文档（其中另有个人授权的人不受影响）。</p>` +
        (n >= 20 && people.length
          ? `<p class="cf-people">${people.slice(0, 3).map(esc).join("、")} 等 ${n} 人</p>` : ""),
      danger: true,
      okText: "收回授权",
    });
    if (!ok) return;
    const role = ((detail.groups || []).find((x) => (x.grp || "") === grp) || {}).role || "viewer";
    try {
      await api(`/kbs/${detail.id}/groups/${encodeURIComponent(grp)}`, { method: "DELETE" });
      toast(`已收回「${grp}」的访问权`, "ok", {
        label: "撤销",
        run: async () => {
          await api(`/kbs/${detail.id}/groups`, { method: "POST", body: { group: grp, role } });
          toast("已撤销收回");
          reloadDetail("groups");
        },
      });
      await reloadDetail("groups");
      refreshListQuiet();
    } catch (e) {
      toast(e.status === 404 ? "收回失败：该分组未被授权" : errText(e, "收回失败"), "err");
    }
  }

  // ---------- 设置分区 + 新建/编辑表单（同一套字段构建器） ----------
  function deptOptions() {
    const s = new Set(DEPT_SUGGEST);
    for (const k of myKbs) if (k.dept) s.add(k.dept);
    return [...s].sort((a, b) => a.localeCompare(b, "zh"));
  }

  function kbFormHTML(mode, kb, opts = {}) {
    const isEdit = mode === "edit";
    const ro = !!opts.readonly;
    const deptVal = (kb && kb.dept) || "";
    const depts = deptOptions();
    const inList = depts.includes(deptVal);
    const ownerVal = (kb && kb.owner) || (me ? (me.display_name || me.username) : "");
    const levelVal = (kb && kb.level) || "internal";
    const descVal = (kb && kb.description) || "";
    const nameVal = (kb && kb.name) || "";
    const codeVal = (kb && kb.code) || "";
    const dis = ro ? "disabled" : "";
    const rd = ro ? "readonly" : "";
    return `<div class="form-grid">
      <div class="form-row full">
        <label for="kfName">名称<span class="req">*</span></label>
        <input id="kfName" maxlength="50" value="${esc(nameVal)}" placeholder="如：财务制度库" ${rd}>
        <span class="err-tip" id="kfNameErr" hidden></span>
      </div>
      <div class="form-row">
        <label for="kfDept">归属部门</label>
        <select id="kfDept" ${dis}>
          <option value="">未指定</option>
          ${depts.map((d) => `<option value="${esc(d)}"${d === deptVal ? " selected" : ""}>${esc(d)}</option>`).join("")}
          <option value="__custom"${!inList && deptVal ? " selected" : ""}>＋ 自定义部门…</option>
        </select>
        <input id="kfDeptCustom" maxlength="32" placeholder="输入部门名"
               value="${!inList && deptVal ? esc(deptVal) : ""}"
               ${!inList && deptVal ? "" : "hidden"} ${rd}>
        <span class="hint">部门与「用户管理 → 设分组」同源，列表筛选与权限矩阵都按它等值匹配。</span>
      </div>
      <div class="form-row">
        <label>数据分级<span class="req">*</span></label>
        <div class="seg-level" role="radiogroup" aria-label="数据分级">
          ${[["public", "公开", "cls-public"], ["internal", "内部", "cls-internal"], ["confidential", "机密", "cls-secret"]]
            .map(([v, t, c]) => `<label class="seg-item"><input type="radio" name="kfLevel" value="${v}"
              ${levelVal === v ? "checked" : ""} ${dis}><span class="cls ${c}">${t}</span></label>`).join("")}
        </div>
      </div>
      <div class="form-row">
        <label for="kfOwner">负责人</label>
        <input id="kfOwner" maxlength="32" value="${esc(ownerVal)}" ${rd}>
        <span class="hint">仅用于展示与提醒，<b>不产生访问权限</b>。</span>
      </div>
      <div class="form-row full">
        <label>编码</label>
        ${isEdit
          ? `<div class="code-readonly">${esc(codeVal || "未编码")}</div>
             <span class="hint">编码创建后不可修改。</span>`
          : `<label class="chk"><input type="checkbox" id="kfCodeAuto" checked ${dis}> 自定义编码</label>
             <div class="form-note" id="kfCodeView">编码保存后自动生成（形如 KB-0008），建库后不可修改</div>
             <input id="kfCode" maxlength="24" value="KB-" hidden ${rd}>
             <span class="err-tip" id="kfCodeErr" hidden></span>`}
      </div>
      <div class="form-row full">
        <label for="kfDesc">描述</label>
        <textarea id="kfDesc" maxlength="200" rows="3" placeholder="这个库存什么文档、谁该看…" ${rd}>${esc(descVal)}</textarea>
        <span class="hint" id="kfDescCount">${descVal.length}/200</span>
      </div>
    </div>`;
  }

  function bindKbForm(root, mode, onDirty) {
    const auto = root.querySelector("#kfCodeAuto");
    const codeEl = root.querySelector("#kfCode");
    const codeView = root.querySelector("#kfCodeView");
    if (auto && codeEl) {
      const sync = () => {
        codeEl.hidden = auto.checked;
        if (codeView) codeView.hidden = !auto.checked;
        if (!auto.checked) { codeEl.focus(); codeEl.select(); }
        if (onDirty) onDirty();
      };
      auto.onchange = sync;
    }
    const deptSel = root.querySelector("#kfDept");
    const deptCustom = root.querySelector("#kfDeptCustom");
    if (deptSel && deptCustom) {
      deptSel.onchange = () => {
        deptCustom.hidden = deptSel.value !== "__custom";
        if (!deptCustom.hidden) deptCustom.focus();
        if (onDirty) onDirty();
      };
    }
    const desc = root.querySelector("#kfDesc");
    const cnt = root.querySelector("#kfDescCount");
    if (desc && cnt) {
      desc.oninput = () => { cnt.textContent = `${desc.value.length}/200`; if (onDirty) onDirty(); };
    }
    const name = root.querySelector("#kfName");
   	if (name) {
      name.onblur = () => validateName(name, root);
      name.oninput = () => { if (onDirty) onDirty(); };
    }
    root.querySelectorAll("input, select, textarea").forEach((el) => {
      if (el === name || el === desc) return;
      el.addEventListener("change", () => { if (onDirty) onDirty(); });
    });
  }

  function validateName(input, root) {
    const tip = root.querySelector("#kfNameErr");
    if (!tip) return true;
    const v = (input.value || "").trim();
    if (!v) { tip.hidden = false; tip.textContent = "请填写知识库名称"; return false; }
    if (v.length > 50) { tip.hidden = false; tip.textContent = `名称最多 50 个字，当前 ${v.length} 个`; return false; }
    tip.hidden = true;
    return true;
  }

  // 校验并直接写入字段下方错误文案；返回第一个非法控件（或 null）
  function validateKbForm(root, mode) {
    let first = null;
    const name = root.querySelector("#kfName");
    if (name && !validateName(name, root)) first = name;
    if (mode === "create") {
      const auto = root.querySelector("#kfCodeAuto");
      const codeEl = root.querySelector("#kfCode");
      const tip = root.querySelector("#kfCodeErr");
      if (tip) tip.hidden = true;
      if (auto && !auto.checked && codeEl) {
        const cv = (codeEl.value || "").trim();
        if (!/^[A-Z0-9-]{3,24}$/.test(cv)) {
          if (tip) { tip.hidden = false; tip.textContent = "编码只能包含大写字母、数字和短横线，3–24 个字符"; }
          if (!first) first = codeEl;
        }
      }
    }
    return first;
  }

  function collectKbForm(root, mode) {
    const deptSel = root.querySelector("#kfDept");
    const deptCustom = root.querySelector("#kfDeptCustom");
    let dept = "";
    if (deptSel) {
      dept = deptSel.value === "__custom"
        ? ((deptCustom && deptCustom.value) || "").trim()
        : deptSel.value;
    }
    const lv = root.querySelector("input[name='kfLevel']:checked");
    const body = {
      name: (root.querySelector("#kfName").value || "").trim(),
      description: (root.querySelector("#kfDesc").value || "").trim(),
      dept,
      level: lv ? lv.value : "internal",
      owner: (root.querySelector("#kfOwner").value || "").trim(),
    };
    if (mode === "create") {
      const auto = root.querySelector("#kfCodeAuto");
      const codeEl = root.querySelector("#kfCode");
      body.code = auto && auto.checked ? "" : ((codeEl.value || "").trim());
    }
    return body;
  }

  function setFormError(mount, msg) {
    let el = mount.querySelector(".form-err");
    if (!msg) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.className = "form-err";
      mount.prepend(el);
    }
    el.textContent = msg;
  }

  function mapKbFormError(e) {
    if (!navigator.onLine || e.status === 0) return "保存失败：网络中断，请检查网络后重试";
    if (e.status === 403) return "创建知识库需要平台管理员权限，请联系管理员";
    if (e.status >= 500) return `保存失败：服务器异常（${e.status}），请稍后重试。若持续失败请联系运维`;
    return `保存失败：${e.message}`;
  }

  // ---- 新建 / 编辑弹窗 ----
  let kfMode = "create", kfEditKb = null;
  function openKbForm(mode, kb) {
    kfMode = mode;
    kfEditKb = kb || null;
    const dlg = $("kbFormDialog");
    $("kfKind").textContent = mode === "create" ? "新建" : "编辑";
    $("kfTitle").textContent = mode === "create" ? "新建知识库" : `编辑「${(kb && kb.name) || ""}」`;
    $("kfSubmit").textContent = mode === "create" ? "创建" : "保存";
    $("kfErr").hidden = true;
    $("kfMount").innerHTML = kbFormHTML(mode, kb);
    bindKbForm($("kfMount"), mode);
    if (typeof dlg.showModal === "function") dlg.showModal();
    const n = $("kfMount").querySelector("#kfName");
    if (n) requestAnimationFrame(() => n.focus());
  }

  async function submitKbForm() {
    const root = $("kfMount");
    const bad = validateKbForm(root, kfMode);
    if (bad) { bad.focus(); return; }
    const body = collectKbForm(root, kfMode);
    const btn = $("kfSubmit");
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = kfMode === "create" ? "创建中…" : "保存中…";
    try {
      if (kfMode === "create") {
        const res = await api("/admin/kbs", { method: "POST", body });
        $("kbFormDialog").close();
        toast(`已创建「${res.name}」，编码 ${res.code || "自动生成"}`);
        await loadKbList();
        navigate(`#kb/${res.id}/files`);
      } else {
        await api(`/admin/kbs/${kfEditKb.id}`, { method: "PATCH", body });
        $("kbFormDialog").close();
        toast("已保存");
        await reloadDetail("settings");
        refreshListQuiet();
      }
    } catch (e) {
      if (/同名/.test(e.message)) {
        const tip = root.querySelector("#kfNameErr");
        if (tip) { tip.hidden = false; tip.textContent = "已有同名知识库，换一个名字"; }
        const n = root.querySelector("#kfName");
        if (n) n.focus();
      } else if (/已被占用/.test(e.message)) {
        const tip = root.querySelector("#kfCodeErr");
        if (tip) { tip.hidden = false; tip.textContent = e.message; }
        const c = root.querySelector("#kfCode");
        if (c) c.focus();
      } else {
        $("kfErr").hidden = false;
        $("kfErr").textContent = mapKbFormError(e);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  // ---- 设置分区 ----
  function renderSettings() {
    const d = detail, kb = d.kb, el = $("kbSecSettings");
    if (!kb) { el.innerHTML = ""; return; }
    const editable = isSysAdmin();
    el.innerHTML = `
      <div class="sec-head"><h2 class="sec-title" tabindex="-1">设置</h2></div>
      ${editable ? "" : `<div class="sec-note">修改知识库元信息需要平台管理员权限。你是本库管理员，可以管理文件、成员与分组授权。</div>`}
      <div class="settings-wrap">
        <div id="setMount">${kbFormHTML("edit", kb, { readonly: !editable })}</div>
        ${editable ? `<div class="form-actions"><button class="wbtn pri" id="setSave" disabled>保存</button></div>` : ""}
        <p class="form-note">多人同时修改时，后保存的内容会覆盖先保存的。</p>
      </div>
      <div class="danger-zone">
        <div class="danger-title">危险操作</div>
        ${dangerRowsHTML(kb, editable)}
      </div>`;
    bindKbForm($("setMount"), "edit", () => {
      const b = $("setSave");
      if (b) b.disabled = false;
    });
    if (editable) $("setSave").onclick = () => saveSettings(kb);
    bindDangerRows(kb, editable);
  }

  function dangerRowsHTML(kb, editable) {
    const isDefault = kb.id === 1;
    const archived = kb.status === "archived";
    if (!editable) {
      return `<div class="danger-row"><div class="dtext">归档与删除需要平台管理员权限。</div></div>`;
    }
    return `<div class="danger-row">
      <div class="dtext">
        <span class="dname">${archived ? "恢复启用" : "归档知识库"}</span>
        归档后本库文档不再参与新的问答检索，历史回答中的引用仍可查看；成员与授权全部保留。
        ${isDefault ? "默认知识库不可归档——它是全员兜底检索范围。" : ""}
      </div>
      <button class="wbtn" id="dzArchive" ${isDefault ? "disabled" : ""}
        ${isDefault ? 'title="默认知识库不可归档"' : ""}>${archived ? "恢复启用" : "归档"}</button>
    </div>
    <div class="danger-row">
      <div class="dtext">
        <span class="dname">删除知识库</span>
        这个库有 ${kb.file_count || 0} 个文档、${kb.member_count || 0} 名成员。删除后文档不可见、问答不再引用，
        界面内无法恢复。${isDefault ? "默认知识库不可删除。" : ""}
      </div>
      <button class="rop danger" id="dzDelete" ${isDefault ? "disabled" : ""}
        ${isDefault ? 'title="默认知识库不可删除"' : ""}>删除知识库</button>
    </div>`;
  }

  function bindDangerRows(kb, editable) {
    if (!editable) return;
    const a = $("dzArchive");
    if (a) a.onclick = async () => {
      await toggleArchive(kb);
      await reloadDetail("settings");
    };
    const b = $("dzDelete");
    if (b) b.onclick = async () => {
      await deleteKb(kb);
      await reloadDetail("settings");
    };
  }

  async function saveSettings(kb) {
    const root = $("setMount");
    const bad = validateKbForm(root, "edit");
    if (bad) { bad.focus(); return; }
    const body = collectKbForm(root, "edit");
    const btn = $("setSave");
    btn.disabled = true;
    btn.textContent = "保存中…";
    setFormError(root, "");
    try {
      await api(`/admin/kbs/${kb.id}`, { method: "PATCH", body });
      toast("已保存");
      await reloadDetail("settings");
      refreshListQuiet();
    } catch (e) {
      setFormError(root, mapKbFormError(e));
      btn.disabled = false;
    } finally {
      const b = $("setSave");
      if (b) b.textContent = "保存";
    }
  }

  // ===================== 权限矩阵 =====================
  let mxData = null, mxUndo = null, mxTimer = 0;

  async function renderMatrix(force) {
    const wrap = $("mxWrap");
    if (!mxData || force) {
      wrap.innerHTML = `<div class="admin-hint">加载中…</div>`;
      try {
        mxData = await api("/admin/kb-matrix");
      } catch (e) {
        wrap.innerHTML = `<div class="sec-err"><span>读取权限矩阵失败：${esc(errText(e))}</span></div>`;
        return;
      }
    }
    paintMatrix();
  }

  function paintMatrix() {
    const wrap = $("mxWrap");
    const all = mxData.groups || [];
    const named = all.filter((g) => (g.group || "").trim() !== "");
    const ungrouped = all.find((g) => (g.group || "").trim() === "");
    const kw = ($("mxSearch").value || "").trim().toLowerCase();
    const onlySecret = $("mxSecret").checked;
    const onlyActive = $("mxActive").checked;
    const rows = (mxData.rows || []).filter((r) => {
      if (kw && !`${r.name} ${r.code}`.toLowerCase().includes(kw)) return false;
      if (onlySecret && r.level !== "confidential") return false;
      if (onlyActive && r.status !== "active") return false;
      return true;
    });
    if (!named.length) {
      wrap.innerHTML = `<div class="tbl-empty"><span class="te-glyph">▤</span>
        <div class="te-title">还没有任何分组</div>
        <div class="te-sub">分组是矩阵的列。先到「用户管理 → 设分组」给账号设分组，再回来授权。</div>
        <button class="wbtn" id="mxGoUsers">去用户管理</button></div>`;
      $("mxGoUsers").onclick = () => navigate("#admin/users");
      return;
    }
    const head = `<tr><th class="m-row-head" scope="col">知识库</th>` +
      named.map((g) => `<th class="m-grp" scope="col"
        title="${esc(g.group)} · ${g.total} 人${g.active < g.total ? `（${g.total - g.active} 人未激活）` : ""}${g.total >= 20 ? `；改动将同时影响 ${g.total} 人` : ""}">
        ${esc(g.group)}<small${g.total >= 20 ? ' class="m-big"' : ""}>${g.total} 人${g.active < g.total ? ` · ${g.total - g.active} 待` : ""}</small></th>`).join("") +
      (ungrouped ? `<th class="m-grp" scope="col" title="未分组的账号不会被任何分组授权覆盖，请到用户管理设分组">未分组<small>不可授权</small></th>` : "") +
      `</tr>`;
    const body = rows.map((r) => {
      const cells = named.map((g) => {
        const role = (r.grants || {})[g.group] || "";
        const tip = r.status === "archived" ? "；该库已归档，授权保留但不参与问答检索" : "";
        return `<td>${mcellHTML(r, g.group, role, tip)}</td>`;
      }).join("");
      const ug = ungrouped
        ? `<td><span class="m-none" title="未分组的账号不会被任何分组授权覆盖；后端不允许对空分组名授权">不可授权</span></td>` : "";
      return `<tr data-kb="${r.kb_id}">
        <th class="m-row-head" scope="row">
          <span class="m-name" title="${esc(r.name)}">${esc(r.name)}</span>
          <span class="m-sub">${esc(r.code || "未编码")} · ${esc(LEVEL_CN[r.level] || "内部")}${r.status === "archived" ? " · 已归档" : ""}</span>
        </th>${cells}${ug}</tr>`;
    }).join("");
    wrap.innerHTML = `<table class="matrix"><caption class="sr-only">知识库与分组的授权关系</caption>
      <thead>${head}</thead><tbody>${body}</tbody></table>`;
    bindCells(wrap);
  }

  function mcellHTML(row, grp, role, tip) {
    const cls = role ? `v-${role}` : "none";
    const txt = role ? `<span class="rc">${ROLE_MARK[role] || ""} ${ROLE_CN[role]}</span>` : "";
    const aria = `${row.name} × ${grp}：${role ? `当前「${ROLE_CN[role]}」` : "当前未授权"}，回车修改`;
    return `<button class="mcell ${cls}" data-kb="${row.kb_id}" data-grp="${esc(grp)}"
      data-role="${role}" aria-label="${esc(aria)}" title="${esc((role ? `当前「${ROLE_CN[role]}」` : "未授权") + (tip || ""))}">${txt}</button>`;
  }

  function bindCells(root) {
    root.querySelectorAll(".mcell").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); openCellPop(b); };
    });
  }

  function updateCellDom(kbId, grp, role) {
    const btn = document.querySelector(`.mcell[data-kb="${kbId}"][data-grp="${grp.replace(/"/g, '\\"')}"]`);
    if (!btn) return;
    const row = (mxData.rows || []).find((r) => r.kb_id === kbId) || { name: "", status: "" };
    const tip = row.status === "archived" ? "；该库已归档，授权保留但不参与问答检索" : "";
    const tmp = document.createElement("span");
    tmp.innerHTML = mcellHTML(row, grp, role, tip);
    const fresh = tmp.firstElementChild;
    btn.className = fresh.className;
    btn.dataset.role = role;
    btn.innerHTML = fresh.innerHTML;
    btn.setAttribute("aria-label", fresh.getAttribute("aria-label"));
    btn.setAttribute("title", fresh.getAttribute("title"));
    btn.onclick = (e) => { e.stopPropagation(); openCellPop(btn); };
  }

  function openCellPop(btn) {
    const pop = $("mcellPop");
    const kbId = Number(btn.dataset.kb);
    const grp = btn.dataset.grp;
    const cur = btn.dataset.role || "";
    const row = (mxData.rows || []).find((r) => r.kb_id === kbId) || {};
    const g = (mxData.groups || []).find((x) => x.group === grp) || {};
    pop.innerHTML = `
      <div class="mcp-head">「${esc(row.name || "")}」×「${esc(grp)}」</div>
      ${["viewer", "editor", "kb_admin"].map((r) =>
        `<button class="mcp-item${cur === r ? " cur" : ""}" data-role="${r}">
          ${ROLE_MARK[r]} ${ROLE_CN[r]}<span class="mcp-key">${r}</span></button>`).join("")}
      <button class="mcp-item danger" data-role="" ${cur ? "" : "disabled"}>收回授权</button>
      <div class="mcp-foot${(g.total || 0) >= 20 ? " m-big" : ""}">该组 ${g.total || 0} 人${
        g.active != null && g.active < g.total ? `（${g.total - g.active} 人未激活）` : ""}</div>`;
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.min(Math.max(8, r.left - 40), window.innerWidth - w - 8);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.querySelectorAll(".mcp-item").forEach((item) => {
      item.onclick = (e) => {
        e.stopPropagation();
        if (item.disabled) return;
        setCellRole(kbId, grp, item.dataset.role, cur, btn);
      };
    });
    const first = pop.querySelector(".mcp-item.cur") || pop.querySelector(".mcp-item");
    if (first) first.focus();
  }

  async function setCellRole(kbId, grp, role, cur, cellBtn) {
    const pop = $("mcellPop");
    if (role === cur) { pop.hidden = true; return; }
    const row = (mxData.rows || []).find((r) => r.kb_id === kbId) || {};
    if (!role) {
      const g = (mxData.groups || []).find((x) => x.group === grp) || {};
      pop.hidden = true;
      const ok = await confirmDialog({
        title: `收回「${grp}」的授权？`,
        body: `<p>该组 ${g.total || "全体"} 名成员将无法再检索「${esc(row.name || "")}」的文档（个人授权不受影响）。</p>`,
        okText: "收回授权",
      });
      if (!ok) return;
    } else {
      pop.hidden = true;
      const g = (mxData.groups || []).find((x) => x.group === grp) || {};
      const n = g.total || 0;
      if (n >= 20) {
        // 影响面护栏只出现在确认环节，格子里一个字都不加
        const ok = await confirmDialog({
          title: `「${grp}」对「${row.name || "本库"}」改为「${ROLE_CN[role]}」？`,
          body: `<p class="cf-amber">${cur ? "本次改动影响" : "该组"} ${n} 人${cur ? "" : "将立即获得访问权"}</p>` +
            `<p>授权立即生效并写入审计日志，10 秒内可撤销。</p>`,
          okText: "保存",
        });
        if (!ok) return;
      }
    }
    const label = role ? ROLE_CN[role] : "未授权";
    try {
      if (role) await api(`/kbs/${kbId}/groups`, { method: "POST", body: { group: grp, role } });
      else await api(`/kbs/${kbId}/groups/${encodeURIComponent(grp)}`, { method: "DELETE" });
      if (row) {
        row.grants = row.grants || {};
        if (role) row.grants[grp] = role; else delete row.grants[grp];
      }
      updateCellDom(kbId, grp, role);
      toast(`「${grp}」对「${row.name || "本库"}」的权限改为「${label}」`, "ok");
      showRevBar(kbId, grp, cur, role, row.name);
    } catch (e) {
      // 失败必须回滚，乐观态不回收是治理界面最危险的事
      updateCellDom(kbId, grp, cur);
      toast(errText(e, "保存失败"), "err");
    }
  }

  function showRevBar(kbId, grp, oldRole, newRole, kbName) {
    mxUndo = { kbId, grp, oldRole };
    clearInterval(mxTimer);
    $("mxRev").hidden = false;
    $("mxRevText").textContent =
      `已更新「${grp}」×「${kbName || ""}」的授权：` +
      `${oldRole ? ROLE_CN[oldRole] : "无"} → ${newRole ? ROLE_CN[newRole] : "无"}`;
    let left = 10;
    const cd = $("mxRevCd");
    cd.textContent = `${left}s`;
    cd.classList.toggle("soon", left <= 3);          // 末段强调：只加字重，不改颜色
    mxTimer = setInterval(() => {
      left -= 1;
      cd.textContent = `${left}s`;
      cd.classList.toggle("soon", left <= 3 && left > 0);
      if (left <= 0) {
        clearInterval(mxTimer);
        $("mxRev").hidden = true;
        mxUndo = null;
      }
    }, 1000);
  }

  async function revokeUndo() {
    if (!mxUndo) return;
    const { kbId, grp, oldRole } = mxUndo;
    clearInterval(mxTimer);
    $("mxRev").hidden = true;
    mxUndo = null;
    try {
      if (oldRole) await api(`/kbs/${kbId}/groups`, { method: "POST", body: { group: grp, role: oldRole } });
      else await api(`/kbs/${kbId}/groups/${encodeURIComponent(grp)}`, { method: "DELETE" });
      const row = (mxData.rows || []).find((r) => r.kb_id === kbId);
      if (row) {
        row.grants = row.grants || {};
        if (oldRole) row.grants[grp] = oldRole; else delete row.grants[grp];
      }
      updateCellDom(kbId, grp, oldRole);
      toast("已撤销上一步授权修改");
    } catch (_) {
      toast("撤销失败：该授权已被他人修改，请刷新查看", "err");
      renderMatrix(true);
    }
  }

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

  // ======================================================================
  // 接口面板 —— 控制台第 5 个页签（#admin/api）
  // 形态：docs/接口面板设计.md ｜ 行为：docs/接口面板交互.md
  // 数据：GET /api/openapi.json 运行时解析（nginx 去 /api 前缀反代到后端 /openapi.json）
  // ======================================================================
  const API_METHODS = ["get", "post", "put", "patch", "delete"];
  const API_TTL = 5 * 60 * 1000;
  let apiDoc = null, apiDocAt = 0, apiDocState = "idle", apiDocErr = "";
  // 失败要分两类：auth（401/403，重试无效，只能重新登录）/ fail（5xx、网络、非 JSON，可重试）
  let apiDocKind = "";
  let apiDocPromise = null;
  let apiSel = "", apiFilter = "", apiParams = {}, apiBody = "", apiResp = null;
  let apiBusy = false, apiTmo = 0, apiRespExpanded = false;
  const apiCollapsed = new Set();

  // 左列 7 组：顺序按使用频率（auth → chat → kbs → admin → files → open → 系统）
  const API_GROUPS = [
    { id: "auth", name: "认证", test: (p) => p.startsWith("/auth") },
    { id: "chat", name: "对话", test: (p) => p.startsWith("/chat") },
    { id: "kbs", name: "知识库", test: (p) => p.startsWith("/kbs") },
    { id: "admin", name: "管理", test: (p) => p.startsWith("/admin") },
    { id: "files", name: "文件", test: (p) => p.startsWith("/files") },
    { id: "open", name: "开放接口", test: (p) => p.startsWith("/open") },
    { id: "system", name: "系统", test: () => true },
  ];

  // 鉴权 5 条路径规则（openapi 里没有 securitySchemes，不能照抄契约）
  const API_AUTH_RULE = [
    { test: (p) => p === "/" || p === "/health", tier: "public", label: "公开" },
    { test: (p) => p === "/auth/login" || p === "/auth/register", tier: "public", label: "公开" },
    { test: (p) => p === "/admin/search", tier: "super", label: "仅超管" },
    { test: (p) => p.startsWith("/admin/"), tier: "admin", label: "管理员" },
    { test: (p) => p.startsWith("/open/"), tier: "apikey", label: "API-Key" },
    { test: () => true, tier: "jwt", label: "登录" },
  ];
  const apiAuthOf = (path) => API_AUTH_RULE.find((r) => r.test(path));

  function apiOps() {
    const ops = [];
    const paths = (apiDoc && apiDoc.paths) || {};
    for (const [path, item] of Object.entries(paths)) {
      for (const m of API_METHODS) {
        if (!item || !item[m]) continue;
        ops.push({ method: m.toUpperCase(), path, op: item[m], key: `${m.toUpperCase()}:${path}` });
      }
    }
    return ops;
  }
  function apiOpOf(key) { return apiOps().find((o) => o.key === key) || null; }

  // 路径 / query / header 三类参数（严格按契约的 in 渲染，不许把 role 塞进 body）
  function apiParamsOf(o) {
    return ((o && o.op && o.op.parameters) || [])
      .filter((p) => p && ["path", "query", "header"].includes(p.in))
      .map((p) => ({ ...p, schema: deref(p.schema || {}) }));
  }
  function deref(schema, depth) {
    let s = schema || {};
    let d = depth || 0;
    while (s && s.$ref && d < 3) {
      const name = String(s.$ref).split("/").pop();
      s = (apiDoc && apiDoc.components && apiDoc.components.schemas && apiDoc.components.schemas[name]) || {};
      d += 1;
    }
    return s || {};
  }

  // 试调用禁用 4 类（禁用 ≠ 不可读：参数与 schema 照常展示，只把发送区换成原因条）
  function apiDisabled(op) {
    if (op.path === "/chat/stream") {
      return "流式接口（text/event-stream）不在面板里试调用。请到问答页验证；面板只发一次性请求，收不到 token 增量，只会让你以为「流式坏了」。";
    }
    if (op.path.endsWith("/download")) {
      return "该接口返回文件流，试调用会直接触发浏览器下载。请在知识库详情的文件表里下载。";
    }
    if (op.path.endsWith("/upload")) {
      return "该接口需要 multipart 文件上传，面板无法选择文件。请在知识库详情页（或语料索引页）上传。";
    }
    if (op.path.startsWith("/open/")) {
      return "该接口需要 X-API-Key（服务端 ADMIN_API_KEY），浏览器不持有此密钥，故不能在线试调用。请用 curl 或调用方系统验证；密钥只配置在服务端 .env。";
    }
    return "";
  }

  // 危险分四档（本页没有强度 1：任何非 GET 至少 2 级），按"能否一次反向请求还原"分档
  function apiRisk(op) {
    if (op.method === "GET") return 1;
    if (op.method === "DELETE") {
      if (/\/members\/\{[^}]+\}$/.test(op.path)) return 2;   // POST members 可恢复
      if (/\/groups\/\{[^}]+\}$/.test(op.path)) return 3;    // 一次影响一批人
      return 4;                                             // 库 / 文件 / 文档 / 账号：不可恢复
    }
    if (op.method === "POST") {
      if (op.path.endsWith("/approve")) return 3;
      if (op.path.endsWith("/role")) return 3;
      if (op.path === "/admin/rebuild") return 3;
      if (op.path.endsWith("/groups")) return 3;
    }
    return 2;
  }

  // 行内危险标签（查表，不按方法猜"计费 / 重建 / 批量"）
  function apiTag(op) {
    if (op.method === "DELETE") return "不可逆";
    if (op.path.startsWith("/chat") || op.path === "/open/v1/chat") return "计费";
    if (op.path === "/admin/rebuild") return "重建";
    if (op.path.endsWith("/approve")) return "入库";
    if (op.method === "POST" && /^\/open\/v1\/(users|groups)/.test(op.path)) return "批量";
    return "";
  }

  // requestBody 的 mini resolver：$ref 解引用、深度上限 3、循环检测；占位一律类型零值
  function exampleOf(schema, root, depth, seen) {
    const d = depth || 0;
    const vis = seen || new Set();
    if (!schema || d > 3) return null;
    if (schema.$ref) {
      const ref = String(schema.$ref);
      if (vis.has(ref)) return null;
      const name = ref.split("/").pop();
      const target = (root && root.components && root.components.schemas && root.components.schemas[name]);
      return exampleOf(target, root, d + 1, new Set(vis).add(ref));
    }
    if (schema.anyOf || schema.oneOf) return exampleOf((schema.anyOf || schema.oneOf)[0], root, d + 1, vis);
    if (schema.allOf && schema.allOf.length) {
      const merged = { type: "object", properties: {} };
      for (const part of schema.allOf) {
        const v = exampleOf(part, root, d + 1, vis);
        if (v && typeof v === "object") Object.assign(merged.properties, v);
      }
      return Object.keys(merged.properties).length
        ? Object.fromEntries(Object.entries(merged.properties)) : {};
    }
    if (schema.type === "object" || schema.properties) {
      return Object.fromEntries(Object.entries(schema.properties || {})
        .map(([k, v]) => [k, exampleOf(v, root, d + 1, vis)]));
    }
    if (schema.type === "array") {
      const one = exampleOf(schema.items, root, d + 1, vis);
      return one === null ? [] : [one];
    }
    if (schema.type === "integer" || schema.type === "number") return 0;
    if (schema.type === "boolean") return false;
    return "";
  }

  function apiBodySchema(op) {
    const rb = op.op && op.op.requestBody;
    if (!rb || !rb.content) return null;
    const first = Object.values(rb.content)[0];
    return first ? (first.schema || null) : null;
  }

  async function loadOpenApi(force) {
    if (!force && apiDoc && Date.now() - apiDocAt < API_TTL) { renderApiPanel(); return; }
    if (apiDocPromise) return apiDocPromise;
    apiDocState = "loading"; apiDocErr = ""; apiDocKind = "";
    renderApiChrome(); renderApiList(); renderApiDetail();

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    apiDocPromise = (async () => {
      let r;
      try {
        r = await fetch(`${API_BASE}/openapi.json`, { headers: authHeaders(false), signal: ctl.signal });
      } catch (_) {
        throw new Error(`无法连接后端（${API_BASE}）。请确认服务已启动，或检查网络。`);
      }
      // 后端 gate_schema 给 /openapi.json 上了登录校验：JWT 过期就是 401。
      // 401 不做静默登出（会丢掉当前页上下文），改为四态里的"无权限"，由面板给「重新登录」；
      // 重试对 401 无效，所以这条分支不能落到通用失败（那个才配「重试」）；
      // 403 更不是"少张票"的问题——给「重新登录」只会让人反复登录、反复 403。
      if (r.status === 401 || r.status === 403) {
        const e = new Error(r.status === 401
          ? "登录已过期，读取接口清单被拒绝（401）。请重新登录后再看接口面板。"
          : "当前账号无权查看接口清单（403），请联系系统管理员开通权限。");
        e.auth = true;
        e.denied = r.status === 403;
        throw e;
      }
      if (!r.ok) throw new Error(`读取接口清单失败（HTTP ${r.status}），接口清单暂不可用。`);
      // 只判 r.ok 会得到空白面板：nginx 的 try_files 会把未命中路径回成 200 + index.html
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("json")) {
        throw new Error("返回的不是 JSON。反代可能把 /api/openapi.json 交给了前端页面（返回了 HTML），请检查 nginx 的 location /api/ 配置。");
      }
      let doc;
      try { doc = await r.json(); }
      catch (_) { throw new Error("返回的不是 JSON：解析失败，反代可能回的是前端页面。"); }
      if (!doc || !doc.paths || !Object.keys(doc.paths).length) {
        throw new Error("契约文件是空的：openapi.json 里没有 paths，后端可能一个路由都没注册。");
      }
      apiDoc = doc;
      apiDocAt = Date.now();
      apiDocState = "ready";
    })();
    try { await apiDocPromise; }
    catch (e) {
      apiDocState = "error";
      apiDocKind = (e && e.auth) ? (e.denied ? "denied" : "auth") : "fail";
      apiDocErr = (e && e.message) || "接口清单暂不可用";
    }
    finally { clearTimeout(timer); apiDocPromise = null; }
    if (apiDocState === "ready") renderApiPanel();
    else { renderApiChrome(); renderApiList(); renderApiDetail(); }
  }

  function renderApiPanel() {
    if (!apiDoc) {
      if (apiDocState === "idle") { loadOpenApi(false); return; }
      renderApiChrome(); renderApiList(); renderApiDetail();
      return;
    }
    const rt = parseHash();
    const ep = (rt.query && rt.query.ep) || "";
    if (ep) apiSel = ep;
    const ops = apiOps();
    if (!ops.some((o) => o.key === apiSel)) apiSel = ops.length ? ops[0].key : "";
    renderApiChrome();
    renderApiList();
    renderApiDetail();
  }

  function renderApiChrome() {
    const meta = $("apiMeta");
    if (apiDocState === "loading") { meta.textContent = "FastAPI 契约 · 正在解析接口清单…"; return; }
    if (apiDocState === "error") {
      // 动作按钮只放右侧错误条：meta 行高 32 且 nowrap，塞长文案会挤掉版本号
      meta.className = "api-meta err";
      meta.textContent = apiDoc
        ? "FastAPI 契约 · 刷新失败，左列保留的是上次读到的清单"
        : (apiDocKind === "auth"
          ? "FastAPI 契约 · 登录已过期，请重新登录"
          : apiDocKind === "denied"
            ? "FastAPI 契约 · 当前账号无权查看清单"
            : "FastAPI 契约 · 接口清单暂不可用");
      return;
    }
    meta.className = "api-meta";
    const ver = (apiDoc && apiDoc.info && apiDoc.info.version) || "—";
    const ops = apiOps().length;
    const paths = Object.keys((apiDoc && apiDoc.paths) || {}).length;
    meta.textContent = `FastAPI 契约 · v${ver} · ${ops} 个操作 / ${paths} 个路径 · 缓存 5 分钟`;
  }

  function apiRowHTML(o) {
    const sum = (o.op && o.op.summary) || "";
    const tag = apiTag(o);
    return `<button class="api-row${o.key === apiSel ? " on" : ""}" data-k="${esc(o.key)}" tabindex="-1">
      <span class="api-m m-${o.method.toLowerCase()}">${o.method}</span>
      <span class="api-row-main">
        <span class="api-path" title="${esc(o.path)}">${esc(o.path)}</span>
        <span class="api-row-sub"><span class="api-sum">${esc(sum)}</span>` +
        `${tag ? `<span class="api-tag">${tag}</span>` : ""}</span>
      </span>
    </button>`;
  }

  function apiSkelHTML() {
    return `<div class="api-skel" aria-hidden="true">${`<span class="sk sk-w1"></span><span class="sk sk-w2 sk-mt"></span>`.repeat(6)}</div>`;
  }

  function renderApiList() {
    const box = $("apiList");
    const pick = $("apiPick");
    if (!apiDoc) {
      // 读不到 ≠ 0 个接口。左列保留骨架/上次结果，结论与动作都放右侧错误条
      if (!box.querySelector(".api-skel")) box.innerHTML = apiSkelHTML();
      pick.innerHTML = "";
      return;
    }
    const q = apiFilter.trim().toLowerCase();
    const bins = API_GROUPS.map((g) => ({ ...g, hit: [], total: [] }));
    const all = apiOps();
    for (const o of all) {
      const g = bins.find((x) => x.test(o.path)) || bins[bins.length - 1];
      g.total.push(o);
      const sum = (o.op && o.op.summary) || "";
      if (!q || o.path.toLowerCase().includes(q) || sum.toLowerCase().includes(q)) g.hit.push(o);
    }
    let html = "";
    let hitTotal = 0;
    for (const g of bins) {
      if (!g.total.length) continue;
      const rows = g.hit.slice().sort((a, b) =>
        a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
      hitTotal += rows.length;
      const collapsed = apiCollapsed.has(g.id);
      html += `<button class="api-group" data-g="${g.id}" aria-expanded="${collapsed ? "false" : "true"}">
        <span class="api-caret" aria-hidden="true">${collapsed ? "▸" : "▾"}</span>
        <span class="api-gname">${esc(g.name)}</span>
        <span class="api-gcount">${q ? `${rows.length}/${g.total.length}` : g.total.length}</span>
      </button>`;
      if (collapsed) continue;
      if (!rows.length) {
        html += `<div class="api-note api-note-sm">本组无匹配</div>`;
        continue;
      }
      html += rows.map(apiRowHTML).join("");
    }
    if (q && !hitTotal) {
      html = `<div class="api-note">没有匹配的接口
        <button class="linklike api-retry" id="apiClearFilter">清除</button></div>`;
    }
    box.innerHTML = html;
    const clear = $("apiClearFilter");
    if (clear) clear.onclick = () => { apiFilter = ""; $("apiSearch").value = ""; renderApiList(); };

    // 窄屏（<700）用原生 select 代替列表
    pick.innerHTML = bins.filter((g) => g.hit.length).map((g) =>
      `<optgroup label="${esc(g.name)}">` + g.hit.map((o) =>
        `<option value="${esc(o.key)}">${o.method} ${esc(o.path)}</option>`).join("") +
      `</optgroup>`).join("");
    pick.value = apiSel;
  }

  function apiMethodBadge(o, big) {
    return `<span class="api-m${big ? " api-m-lg" : ""} m-${o.method.toLowerCase()}">${o.method}</span>`;
  }

  // ---- 四态里的两种失败（loading / empty / fail / auth / denied）----
  // 判据（三档互斥，别再合并）：
  //   用户自己再点一次会不会变好？ 会 → 「重试」；不会 → 换动作（401 → 重新登录）；
  //   换动作也没用（403 角色不够）→ **不给按钮**，只写该找谁。
  // 403 给「重新登录」的后果很具体：管理员反复登录、反复 403，然后报"面板登不进去"。
  function apiErrTitle() {
    if (apiDocKind === "auth") return "登录已过期，请重新登录";
    if (apiDocKind === "denied") return "当前账号无权查看接口清单，请联系系统管理员";
    return "接口清单读取失败";
  }

  // 返回空串 = 这个状态没有用户能做的动作（403）。调用处据此连容器一起不输出。
  function apiErrActionHTML() {
    if (apiDocKind === "denied") return "";
    return apiDocKind === "auth"
      ? `<button class="wbtn sm pri" id="apiRelogin">重新登录</button>`
      : `<button class="wbtn sm" id="apiRetry">重试</button>`;
  }

  // 无动作时不输出容器：空壳会在 flex 的 gap 里白占一格，错误带右侧多 12px
  function apiErrActBoxHTML() {
    const acts = apiErrActionHTML();
    return acts ? `<div class="api-err-act">${acts}</div>` : "";
  }

  function bindApiErr() {
    const rl = $("apiRelogin");
    if (rl) rl.onclick = () => {
      // 复用登出流程（同 #btnLogout）：清 token/用户回登录页；清单状态一并清掉，重登后重新取
      store.token = ""; store.user = null;
      apiDoc = null; apiDocState = "idle"; apiDocErr = ""; apiDocKind = "";
      activeView = "chat";
      showAuth();
    };
    const rt = $("apiRetry");
    if (rt) rt.onclick = () => loadOpenApi(true);
  }

  // 首次就失败：右栏整体换成错误块（左栏此时是骨架，不写"0 个接口"）
  function apiErrDetailHTML() {
    return `<div class="api-blank api-errblk">
      <span class="api-glyph" aria-hidden="true">!</span>
      <div class="api-blank-t">${esc(apiErrTitle())}</div>
      <div class="api-blank-s">${esc(apiDocErr)}</div>
      ${apiErrActBoxHTML()}
    </div>`;
  }

  // 刷新失败但手里还有上次的清单：只在右栏顶部压一条错误带，详情照常可读
  function apiErrBarHTML() {
    return `<div class="api-errbar" role="status">
      <span class="api-errbar-t">${esc(apiErrTitle())}：${esc(apiDocErr)}</span>
      ${apiErrActBoxHTML()}
    </div>`;
  }

  function apiEmptyDetail() {
    return `<div class="api-blank">
      <span class="api-glyph" aria-hidden="true">▤</span>
      <div class="api-blank-t">从左边选一个接口</div>
      <div class="api-blank-s">共 ${apiOps().length} 个操作，按路径前缀分组</div>
    </div>`;
  }

  function apiParamRows(op, params) {
    if (!params.length) return `<div class="api-note">该接口无参数</div>`;
    const rows = params.map((p) => {
      const name = p.name;
      const inPath = p.in === "path";
      const required = inPath || p.required;
      const ty = (p.schema && p.schema.type) || "—";
      const desc = p.description || (p.schema && p.schema.description) || "";
      return `<tr>
        <td class="ap-name" title="${esc(name)}">${esc(name)}</td>
        <td class="ap-in">${esc(p.in)}</td>
        <td class="ap-type" title="${esc(ty)}">${esc(ty)}</td>
        <td class="ap-req">${required ? "必填" : "—"}</td>
        <td class="ap-desc">${desc ? esc(desc) : '<span class="dash">—</span>'}</td>
      </tr>`;
    }).join("");
    return `<table class="api-ptable">
      <colgroup><col class="ap-c1"><col class="ap-c2"><col class="ap-c3"><col class="ap-c4"><col></colgroup>
      <thead><tr><th scope="col">参数名</th><th scope="col">位置</th><th scope="col">类型</th>
        <th scope="col">必填</th><th scope="col">说明</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  // 拼 URL：path 占位符照抄输入值（未填保留 {name}），query 按参数表顺序追加
  function apiPlainUrl(op) {
    const path = op.path.replace(/\{([^}]+)\}/g, (m, name) => {
      const v = String(apiParams[name] == null ? "" : apiParams[name]).trim();
      return v ? encodeURIComponent(v) : m;
    });
    const qs = [];
    for (const p of apiParamsOf(op)) {
      if (p.in !== "query") continue;
      const v = String(apiParams[p.name] == null ? "" : apiParams[p.name]).trim();
      if (v) qs.push(`${encodeURIComponent(p.name)}=${encodeURIComponent(v)}`);
    }
    return `${API_BASE}${path}` + (qs.length ? `?${qs.join("&")}` : "");
  }

  function apiUrlPreviewHTML(op) {
    const url = apiPlainUrl(op);
    const missing = (url.match(/\{[^}]+\}/g) || []).length;
    const html = esc(url).replace(/\{[^}]+\}/g, (m) => `<span class="api-miss">${m}</span>`);
    return { html, url, missing };
  }

  function renderApiDetail() {
    const box = $("apiDetail");
    if (apiDocState === "error" && !apiDoc) {
      apiParams = {}; apiResp = null; apiBody = "";
      box.innerHTML = apiErrDetailHTML();
      bindApiErr();
      return;
    }
    const op = apiOpOf(apiSel);
    apiParams = {};           // 切换接口：参数与 body 一律清空（不回填上一个接口的残值）
    apiResp = null;
    apiBody = "";
    const errBar = apiDocState === "error" ? apiErrBarHTML() : "";
    if (!op) { box.innerHTML = errBar + apiEmptyDetail(); bindApiErr(); return; }

    const params = apiParamsOf(op);
    const tier = apiAuthOf(op.path);
    const dis = apiDisabled(op);
    const tag = apiTag(op);
    const sum = (op.op && op.op.summary) || "—";
    const rbSchema = apiBodySchema(op);
    if (rbSchema) {
      apiBody = JSON.stringify(exampleOf(rbSchema, apiDoc, 0, new Set()), null, 2);
    }

    const pathParams = params.filter((p) => p.in === "path");
    const queryParams = params.filter((p) => p.in === "query");
    const fieldRows = [...pathParams, ...queryParams].map((p) =>
      `<label class="api-field">
        <span class="api-flabel" title="${esc(p.name)}">${esc(p.name)}</span>
        <input class="api-finput" data-pname="${esc(p.name)}" data-pin="${esc(p.in)}"
          autocomplete="off" spellcheck="false"
          placeholder="${esc(p.in === "path" ? "path 参数" : "留空 = 不发送")}">
      </label>`).join("");

    const bodyBlock = rbSchema
      ? `<div class="api-sec">
           <h3 class="api-sec-t">请求体示例</h3>
           <textarea class="api-body" id="apiBodyText" spellcheck="false"
             aria-label="请求体 JSON">${esc(apiBody)}</textarea>
           <div class="api-note api-note-sm">占位一律类型零值（"" / 0 / false / []），改完再发。
             切接口会清空，不记忆上次的请求体。</div>
         </div>`
      : `<div class="api-sec">
           <h3 class="api-sec-t">请求体示例</h3>
           <div class="api-note">该接口无请求体</div>
         </div>`;

    const sendArea = dis
      ? `<div class="api-lock"><span class="api-lock-t">不可在线试调用</span>
           <span>${esc(dis)}</span></div>`
      : `<div class="api-sendrow">
           <div class="api-url" id="apiUrl"></div>
           <div class="api-sendacts">
             <button class="wbtn sm" id="apiResetParams">重置参数</button>
             <button class="wbtn sm${op.method === "DELETE" ? "" : " pri"}" id="apiSendBtn">试调用</button>
           </div>
         </div>
         <div class="api-fields">${fieldRows || `<span class="api-note api-note-sm">该接口没有 path / query 参数，直接用 URL</span>`}</div>`;

    box.innerHTML = `${errBar}
      <div class="api-dhead">
        <div class="api-dtitle">
          ${apiMethodBadge(op, true)}
          <h2 class="api-dpath">${esc(op.path)}</h2>
        </div>
        <div class="api-dacts">
          <button class="wbtn sm" id="apiCurl">复制 curl</button>
          ${dis ? "" : `<button class="wbtn sm pri" id="apiGoSend">试调用</button>`}
        </div>
      </div>
      <div class="api-dsub">
        <span>${esc(sum)}</span>
        <span class="api-dot" aria-hidden="true">·</span>
        <span>${tier.tier === "apikey" ? "需要 X-API-Key" : "需要 Bearer"}</span>
        <span class="api-dot" aria-hidden="true">·</span>
        <span>${params.length} 个参数</span>
        <span class="api-dot" aria-hidden="true">·</span>
        <span class="api-tier">${esc(tier.label)}</span>
        ${tag ? `<span class="api-tag">${tag}</span>` : ""}
      </div>
      <div class="api-dbody">
        <div class="api-sec">
          <h3 class="api-sec-t">参数</h3>
          ${apiParamRows(op, params)}
        </div>
        ${bodyBlock}
        <div class="api-sec">
          <h3 class="api-sec-t">试调用</h3>
          ${sendArea}
        </div>
        <div class="api-sec">
          <h3 class="api-sec-t">响应</h3>
          <div id="apiResp"></div>
        </div>
      </div>`;

    // 绑定：URL 预览与输入框两处同步
    const syncUrl = () => {
      const { html } = apiUrlPreviewHTML(op);
      const el = $("apiUrl");
      if (el) el.innerHTML = `${op.method} ${html}`;
    };
    box.querySelectorAll(".api-finput").forEach((inp) => {
      inp.addEventListener("input", () => {
        apiParams[inp.dataset.pname] = inp.value;
        syncUrl();
      });
      inp.addEventListener("keydown", (e) => {
        // Enter 绝不发送：焦点移到下一个参数（最后一个交给按钮）
        if (e.key === "Enter") {
          e.preventDefault();
          const list = [...box.querySelectorAll(".api-finput")];
          const i = list.indexOf(inp);
          if (list[i + 1]) list[i + 1].focus();
          else box.querySelector("#apiSendBtn")?.focus();
        }
      });
    });
    syncUrl();

    const bodyEl = $("apiBodyText");
    if (bodyEl) bodyEl.addEventListener("input", () => {
      apiBody = bodyEl.value;
      const b = $("apiSendBtn");
      if (b) b.title = apiBodyOK() ? "" : "请求体不是合法 JSON";
    });
    const rb = $("apiResetParams");
    if (rb) rb.onclick = () => { renderApiDetail(); };
    const send = $("apiSendBtn");
    if (send) send.onclick = () => apiSend();
    const go = $("apiGoSend");
    if (go) go.onclick = () => {
      const s = $("apiSendBtn");
      if (s && !s.disabled) s.click();
      else toast("该接口暂不能试调用，原因见下方说明", "err");
    };
    const curl = $("apiCurl");
    if (curl) curl.onclick = () => copyText(apiCurlOf(op));
    bindApiErr();
    renderApiResponse();
  }

  function apiBodyOK() {
    const t = (apiBody || "").trim();
    if (!t) return true;
    try { JSON.parse(t); return true; } catch (_) { return false; }
  }

  function apiCurlOf(op) {
    const url = apiPlainUrl(op);
    const lines = [`curl -X ${op.method} '${url}'`];
    if (apiAuthOf(op.path).tier !== "public") lines.push(`  -H 'Authorization: Bearer $KB_JWT'`);
    const body = (apiBody || "").trim();
    if (body) {
      lines.push(`  -H 'Content-Type: application/json'`);
      lines.push(`  -d '${body.replace(/\s*\n\s*/g, "")}'`);
    }
    return lines.join(" \\\n");
  }

  function apiConfirmBody(op, url) {
    const risk = apiRisk(op);
    const body = (apiBody || "").trim();
    const parts = [];
    parts.push(`<p>将要发出的请求（线路层确认，不是业务确认）：</p>`);
    parts.push(`<div class="cf-band api-cf-url">${esc(op.method)} ${esc(url)}</div>`);
    if (body) parts.push(`<div class="cf-band api-cf-body">${esc(body.slice(0, 400))}${body.length > 400 ? "…" : ""}</div>`);
    if (op.path.endsWith("/approve")) {
      parts.push(`<p>批准后该文档立即<b>增量入库</b>，所有有权限的人都能检索到；此状态不可退回。</p>`);
      parts.push(`<p class="cf-warn">面板内看不到文件内容，请先在知识库详情页核对这份文件。</p>`);
    } else if (op.method === "DELETE" && op.path.startsWith("/admin/documents/")) {
      parts.push(`<p>删除后会立即触发索引重建，问答不再引用这份文档；内置语料不可删除。</p>`);
      parts.push(`<p class="cf-warn">此操作不可撤销，需要重新上传。</p>`);
    } else if (risk >= 4) {
      parts.push(`<p class="cf-warn">此操作不可撤销，界面内无法恢复。</p>`);
    } else if (op.path === "/chat") {
      parts.push(`<p>将调用一次完整 RAG 链路（路由→检索→生成），产生 LLM 费用并写入会话历史。</p>`);
    } else if (op.path === "/admin/rebuild") {
      parts.push(`<p>全量重建期间检索结果可能抖动，问答侧表现为「暂时答不上来」。</p>`);
    } else if (risk === 3) {
      parts.push(`<p>这次调用会影响一批数据或权限，请确认对象无误。</p>`);
    } else {
      parts.push(`<p>面板里没有列表页的上下文（只有一个参数值），所以每次非 GET 都要确认一次。</p>`);
    }
    return parts.join("");
  }

  async function apiSend() {
    const op = apiOpOf(apiSel);
    if (!op || apiBusy) return;
    if (apiDisabled(op)) return;
    if (!apiBodyOK()) { toast("请求体不是合法 JSON，先改好再发", "err"); return; }
    const { url, missing } = apiUrlPreviewHTML(op);
    if (missing) { toast(`还有 ${missing} 个路径参数未填`, "err"); return; }
    const risk = apiRisk(op);

    if (risk >= 2) {
      const ok = await confirmDialog({
        title: `${op.method} ${op.path}`,
        body: apiConfirmBody(op, url),
        danger: risk >= 3,
        requireText: risk >= 4 ? "DELETE" : "",
        inputLabel: risk >= 4 ? "此操作不可撤销，请输入 DELETE 以确认" : "",
        okText: risk >= 4 ? "确认执行" : "确认发送",
        cancelText: "取消",
      });
      if (!ok) return;
    }

    const btn = $("apiSendBtn");
    if (btn) { btn.disabled = true; btn.textContent = "调用中…"; }
    apiBusy = true;
    apiResp = { pending: true };
    renderApiResponse();

    const ctl = new AbortController();
    const limit = op.path.startsWith("/chat") ? 90000 : op.path === "/admin/rebuild" ? 30000 : 20000;
    apiTmo = setTimeout(() => ctl.abort(), limit);
    const headers = apiAuthOf(op.path).tier === "public" ? {} : authHeaders(false);
    const body = (apiBody || "").trim();
    if (body) headers["Content-Type"] = "application/json";

    const t0 = performance.now();
    try {
      let r;
      try {
        r = await fetch(url, { method: op.method, headers, body: body || undefined, signal: ctl.signal });
      } catch (e) {
        const aborted = e && e.name === "AbortError";
        apiResp = {
          status: 0,
          ms: Math.round(performance.now() - t0),
          size: 0,
          text: aborted
            ? `请求超时（${Math.round(limit / 1000)}s）。接口可能仍在服务端执行，写操作不要立刻重试，先去对应页面确认结果。`
            : "请求未送达（网络错误），接口没有被调用",
          err: true,
        };
        return;
      }
      const text = await r.text();
      if (r.status === 401) { store.token = ""; store.user = null; showAuth(); return; }
      apiResp = {
        status: r.status,
        ms: Math.round(performance.now() - t0),
        size: new Blob([text]).size,
        text,
        ct: r.headers.get("content-type") || "",
        err: !r.ok,
      };
    } finally {
      clearTimeout(apiTmo);
      apiBusy = false;
      if (btn) { btn.disabled = false; btn.textContent = "试调用"; }
      apiRespExpanded = false;
      renderApiResponse();
    }
  }

  function apiRespHTML() {
    if (!apiResp) {
      return `<div class="hint-bar">还没有调用记录 · 点右上「试调用」</div>`;
    }
    if (apiResp.pending) return `<div class="api-status">调用中…</div>`;
    const st = apiResp.status;
    // 设计 §4.6：非 2xx 一律红（状态行 + 块边），不整块红底；4xx 不用琥珀，否则会被读成"提示"
    const cls = st >= 200 && st < 300 ? "ok" : "err";
    const head = `${st || "—"} · ${apiResp.ms}ms · ${fmtSize(apiResp.size)}`;
    const raw = String(apiResp.text || "");
    let pretty = raw;
    let isJSON = false;
    try { pretty = JSON.stringify(JSON.parse(raw), null, 2); isJSON = true; } catch (_) { }
    const lines = pretty.split("\n");
    const folded = !apiRespExpanded && lines.length > 40;
    const shown = folded ? lines.slice(0, 20) : lines;
    const gutter = shown.map((_, i) => i + 1).join("\n") + (folded ? "\n…" : "");
    const codeHTML = isJSON
      ? shown.map((line) => {
        const m = line.match(/^(\s*)(".*?")(\s*:\s*)([\s\S]*)$/);
        if (!m) return esc(line);
        const tail = m[4] === "null" ? `<span class="j-n">null</span>`
          : m[4] === "" ? "" : esc(m[4]);
        return `${esc(m[1])}<span class="j-k">${esc(m[2])}</span>${esc(m[3])}${tail}`;
      }).join("\n")
      : esc(pretty);
    return `<div class="api-status ${cls}">${esc(head)}` +
      `${isJSON ? "" : ` · 响应不是 JSON（content-type: ${esc(apiResp.ct || "未知")}）`}</div>` +
      `<div class="api-json${cls === "err" ? " is-err" : ""}">` +
      `<pre class="api-gutter" aria-hidden="true">${gutter}</pre>` +
      `<pre class="api-pre">${codeHTML}</pre></div>` +
      (folded ? `<button class="linklike api-more" id="apiMore">展开全部（${lines.length} 行）</button>` : "");
  }

  function renderApiResponse() {
    const el = $("apiResp");
    if (!el) return;
    el.innerHTML = apiRespHTML();
    const more = $("apiMore");
    if (more) more.onclick = () => { apiRespExpanded = true; renderApiResponse(); };
  }

  // ---- 接口面板：工具条事件（绑定一次，内容重绘不重复绑） ----
  let apiSearchTimer = 0;
  $("apiSearch").oninput = () => {
    clearTimeout(apiSearchTimer);
    apiSearchTimer = setTimeout(() => {
      apiFilter = $("apiSearch").value;
      renderApiList();
    }, 200);
  };
  $("apiSearch").onkeydown = (e) => {
    if (e.key === "Escape" && $("apiSearch").value) {
      e.stopPropagation();
      apiFilter = ""; $("apiSearch").value = "";
      renderApiList();
    }
  };
  $("apiRefresh").onclick = () => {
    // 不清 apiDoc：刷新失败时左列必须留着上次读到的清单，而不是变成空白/骨架
    loadOpenApi(true);
  };
  $("apiPick").onchange = () => {
    if ($("apiPick").value) selectApi($("apiPick").value);
  };
  function selectApi(key) {
    if (!apiOpOf(key)) return;
    apiSel = key;
    history.replaceState(null, "", `#admin/api?ep=${encodeURIComponent(key)}`);
    renderApiList();
    renderApiDetail();
  }
  $("apiList").onclick = (e) => {
    const g = e.target.closest(".api-group");
    if (g) {
      const id = g.dataset.g;
      if (apiCollapsed.has(id)) apiCollapsed.delete(id); else apiCollapsed.add(id);
      renderApiList();
      return;
    }
    const r = e.target.closest(".api-row");
    if (r) selectApi(r.dataset.k);
  };

  // ===================== 事件绑定 =====================
  // 可见库：门户、引用卡、列表页筛选共用同一个 in-flight Promise（门户只发一次 GET /kbs）
  let myKbsPromise = null;
  function loadMyKbs(force) {
    if (myKbsPromise && !force) return myKbsPromise;
    myKbsPromise = api("/kbs").then((list) => {
      myKbs = Array.isArray(list) ? list : [];
      return myKbs;
    }).catch((e) => {
      myKbsPromise = null;   // 失败不缓存，下次进页面/点重试可以再来一次
      throw e;
    });
    return myKbsPromise;
  }

  // ---- 列表页工具条 ----
  let searchTimer = 0;
  $("kbSearch").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      applyFilter({ q: $("kbSearch").value.trim() }, { replace: true });
    }, 280);
  };
  $("kbSearch").onkeydown = (e) => {
    if (e.key === "Escape" && $("kbSearch").value) {
      e.stopPropagation();
      $("kbSearch").value = "";
      applyFilter({ q: "" }, { replace: true });
    }
  };
  $("kbDept").onchange = () => applyFilter({ dept: $("kbDept").value });
  $("kbLevel").onchange = () => applyFilter({ level: $("kbLevel").value });
  $("kbStatus").onchange = () => applyFilter({ status: $("kbStatus").value });
  $("kbClear").onclick = () => clearFilters();

  // 只有「编码 / 文件数」可排；「变更时间」列头不可点、不写 aria-sort
  document.querySelectorAll("#kbTable th.sortable").forEach((th) => {
    th.tabIndex = 0;
    th.addEventListener("click", () => cycleSort(th.dataset.sort));
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cycleSort(th.dataset.sort); }
    });
  });

  $("kbDensity").onclick = () => {
    kbState.density = kbState.density === "compact" ? "cozy" : "compact";
    localStorage.setItem("kb_density", kbState.density);
    renderListChrome();     // 只切密度，不重拉数据
  };

  $("kbSelMode").onclick = () => {
    kbState.selMode = !kbState.selMode;
    if (!kbState.selMode) kbState.selected.clear();
    renderListChrome();
    renderListBody();
  };

  $("kbSize").onchange = () => {
    kbState.size = Number($("kbSize").value) || 20;
    kbState.page = 1;
    localStorage.setItem("kb_pageSize", String(kbState.size));
    history.pushState(null, "", listHash());
    renderListChrome();
    renderListBody();
  };

  $("kbCheckAll").onchange = () => {
    const on = $("kbCheckAll").checked;
    const rows = sortKbs(kbState.all)
      .slice((kbState.page - 1) * kbState.size, kbState.page * kbState.size);
    for (const kb of rows) toggleSelect(kb.id, on);
    renderListBody();
  };

  $("kbBulkClear").onclick = () => {
    kbState.selected.clear();
    renderListBody();
  };
  $("kbBulkArchive").onclick = () => bulkStatus("archived");
  $("kbBulkRestore").onclick = () => bulkStatus("active");
  $("kbBulkDelete").onclick = () => bulkDelete();

  $("kbSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(searchTimer);
      applyFilter({ q: $("kbSearch").value.trim() }, { replace: true });
    }
  });

  $("btnNewKb").onclick = () => openKbForm("create");

  // ---- 详情页 ----
  $("kbCrumb").onclick = () => {
    if (detail) kbState.focusRowId = detail.id;
    navigate("#kb");
  };
  document.querySelectorAll("#kbSubnav .subnav-item").forEach((b) => {
    b.onclick = () => {
      if (!detail) return;
      navigate(`#kb/${detail.id}/${b.dataset.sec}`);
    };
    b.onkeydown = (e) => {
      const list = [...document.querySelectorAll("#kbSubnav .subnav-item")];
      const i = list.indexOf(b);
      if (e.key === "ArrowRight" && list[i + 1]) { e.preventDefault(); list[i + 1].focus(); list[i + 1].click(); }
      if (e.key === "ArrowLeft" && list[i - 1]) { e.preventDefault(); list[i - 1].focus(); list[i - 1].click(); }
    };
  });

  $("kbDUpload").onclick = () => {
    if (!detail) return;
    if (currentSection() !== "files") {
      navigate(`#kb/${detail.id}/files`);
      setTimeout(() => { const inp = $("kbFileInput"); if (inp) inp.click(); }, 320);
      return;
    }
    const inp = $("kbFileInput");
    if (inp) inp.click();
    else toast("当前角色无法上传文件，请联系库管理员", "err");
  };

  $("kbDEdit").onclick = () => {
    if (!detail || !detail.kb) return;
    openKbForm("edit", detail.kb);
  };

  $("kbDMore").onclick = (e) => {
    e.stopPropagation();
    if (!detail || !detail.kb) return;
    const kb = detail.kb;
    const items = [];
    if (isSysAdmin()) {
      items.push({ label: kb.status === "archived" ? "恢复启用" : "归档知识库", run: async () => {
        await toggleArchive(kb);
        await reloadDetail(currentSection());
      } });
    }
    items.push({ label: "复制编码", disabled: !kb.code, title: kb.code ? "" : "这个库还没有编码",
      run: () => copyText(kb.code) });
    if (isSysAdmin()) items.push({ label: "查看审计", run: () => navigate("#admin/audit") });
    if (isSysAdmin() && kb.id !== 1) {
      items.push({ label: "删除知识库", danger: true, run: () => deleteKb(kb) });
    }
    openKmenu($("kbDMore"), items);
  };

  // ---- 弹窗按钮 ----
  $("kfClose").onclick = () => $("kbFormDialog").close();
  $("kfCancel").onclick = () => $("kbFormDialog").close();
  $("kfSubmit").onclick = () => submitKbForm();
  $("kbFormDialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    $("kbFormDialog").close();
  });

  // 文件审核弹窗（审批 → 批准入库 / 驳回二次态）
  $("rvClose").onclick = () => $("reviewDialog").close();
  $("rvCancel").onclick = () => $("reviewDialog").close();
  $("rvApprove").onclick = () => approveFromReview();
  $("rvReject").onclick = () => showRejectState(true);
  $("rvRejectNo").onclick = () => showRejectState(false);
  $("rvRejectYes").onclick = () => rejectFromReview();
  $("reviewDialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    $("reviewDialog").close();
  });

  // ---- 权限矩阵工具条 ----
  let mxSearchTimer = 0;
  $("mxSearch").oninput = () => {
    clearTimeout(mxSearchTimer);
    mxSearchTimer = setTimeout(() => { if (mxData) paintMatrix(); }, 280);
  };
  $("mxSecret").onchange = () => { if (mxData) paintMatrix(); };
  $("mxActive").onchange = () => { if (mxData) paintMatrix(); };
  $("mxReload").onclick = () => renderMatrix(true);
  $("mxRevUndo").onclick = () => revokeUndo();
  $("mxRevClose").onclick = () => {
    clearInterval(mxTimer);
    $("mxRev").hidden = true;
    mxUndo = null;
  };

  // ---- 全局：点外部关弹层 / Esc 逐层关闭 / 两个快捷键 ----
  document.addEventListener("click", (e) => {
    if (!$("kmenu").hidden && !$("kmenu").contains(e.target)) closeKmenu();
    const pop = $("mcellPop");
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".mcell")) pop.hidden = true;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("kmenu").hidden) { closeKmenu(); return; }
      if (!$("mcellPop").hidden) { $("mcellPop").hidden = true; return; }
      if (document.activeElement === $("kbSearch") && $("kbSearch").value) {
        $("kbSearch").value = "";
        applyFilter({ q: "" }, { replace: true });
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (document.querySelector("dialog[open]")) return;
    const ae = document.activeElement;
    const typing = ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
    if (typing || activeView !== "kb" || $("kbList").hidden) return;
    if (e.key === "/") {
      e.preventDefault();
      $("kbSearch").focus();
      $("kbSearch").select();
    } else if ((e.key === "n" || e.key === "N") && isSysAdmin()) {
      e.preventDefault();
      openKbForm("create");
    }
  });

  // ---- 启动 ----
  boot();
})();
