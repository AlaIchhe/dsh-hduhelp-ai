// dsh-hduhelp-ai — 浏览器半边（client plugin bundle）。
//
// 由 dsh-client-modules 在 /plugins/dsh-hduhelp-ai/client.js 提供，经宿主
// __ModuleLoader__ 的 lazy-CJS 模块表执行。面板注册到 settings.section，
// 通过同源 fetch 调宿主 /__hduhelp/* 路由完成登录 / 登出 / 切用途 / 看模型。
(function (root) {
  if (!root || !root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== "function") return;

  root.__ModuleLoader__.load({
    id: "dsh-hduhelp-ai",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;

      var React = null;
      try { React = require("react"); } catch (e) { React = null; }
      var ReactDOM = null;
      try { ReactDOM = require("react-dom/client"); } catch (e) { ReactDOM = null; }

      var NS = "hduhelp-ai";

      var zh = {
        nav: "杭电助手 AI",
        title: "杭电助手 AI · 模型反代",
        intro: "用杭电统一身份认证（学号 + 密码）登录后，插件会把杭电助手的 AI 网关反代成 OpenAI 兼容接口，任何 OpenAI 客户端都能用。",
        user: "学号 / 工号",
        pass: "统一身份认证密码",
        login: "登录",
        loggingIn: "登录中…",
        logout: "退出登录",
        refresh: "刷新状态",
        models: "拉取模型列表",
        proxy: "反代地址",
        apiKey: "API Key",
        copy: "复制",
        copied: "已复制",
        statusOk: "已登录",
        statusNo: "未登录",
        port: "端口",
        running: "运行中",
        stopped: "已停止",
        startProxy: "启动反代",
        stopProxy: "停止反代",
        usage: "客户端填 Base URL 为上表地址，Key 填上面的 API Key；也可以直接把 access_token 当 Key。",
        modelsEmpty: "还没有拉取",
        manageModels: "模型注册",
        selectedCount: "已选",
        selectAll: "全选",
        selectNone: "清空",
        saveSelection: "保存选择",
        searchModels: "搜索模型 id / 名称",
        selectionSaved: "已保存",
        selectionHint: "没勾选任何模型时，模型选择器里不会出现「杭电助手」。",
        providerTitle: "DSH 模型列表",
        providerOk: "已注册 provider",
        providerNo: "未注册（宿主 llm 服务不可用）",
        providerHint: "登录后在聊天输入框上方的模型选择器里选「杭电助手」，就能直接用这里的模型跑 agent。",
        providerModels: "个模型",
        quota: "用量额度",
        quotaEmpty: "AI —",
        quotaExhausted: "额度已用尽",
        quota5h: "5 小时窗口",
        quota7d: "7 天窗口",
        quotaReset: "重置于",
        quotaUsed: "已用",
        quotaWait: "分钟后恢复",
        fail: "失败",
        errMissing: "学号和密码都要填",
      };

      var en = {
        nav: "HDUHelp AI",
        title: "HDUHelp AI · OpenAI proxy",
        intro: "Sign in with your HDU campus account (student ID + password). The plugin then reverse-proxies the HDUHelp AI gateway as an OpenAI-compatible endpoint.",
        user: "Student ID",
        pass: "Campus password",
        login: "Sign in",
        loggingIn: "Signing in…",
        logout: "Sign out",
        refresh: "Refresh",
        models: "Fetch models",
        proxy: "Base URL",
        apiKey: "API Key",
        copy: "Copy",
        copied: "Copied",
        statusOk: "Signed in",
        statusNo: "Signed out",
        port: "Port",
        running: "running",
        stopped: "stopped",
        startProxy: "Start proxy",
        stopProxy: "Stop proxy",
        usage: "Point your OpenAI client at the Base URL with the API Key above; the raw access_token also works as a key.",
        modelsEmpty: "not fetched yet",
        manageModels: "Registered models",
        selectedCount: "selected",
        selectAll: "All",
        selectNone: "None",
        saveSelection: "Save",
        searchModels: "Search model id / name",
        selectionSaved: "Saved",
        selectionHint: "With no model selected, HDUHelp will not appear in the model selector.",
        providerTitle: "DSH model list",
        providerOk: "provider registered",
        providerNo: "not registered (host llm service unavailable)",
        providerHint: "After signing in, pick \"HDUHelp\" in the model selector above the composer to run the agent on these models.",
        providerModels: "models",
        quota: "Quota",
        quotaEmpty: "AI —",
        quotaExhausted: "quota exhausted",
        quota5h: "5h window",
        quota7d: "7d window",
        quotaReset: "resets",
        quotaUsed: "used",
        quotaWait: "min to reset",
        fail: "failed",
        errMissing: "Student ID and password are both required",
      };

      async function call(path, method, body) {
        var opts = {
          method: method || "GET",
          headers: { "x-dsh-hduhelp": "1" },
          credentials: "same-origin",
        };
        if (body) {
          opts.headers["content-type"] = "application/json";
          opts.body = JSON.stringify(body);
        }
        var r = await fetch(path, opts);
        var j = null;
        try { j = await r.json(); } catch (e) { j = null; }
        return { status: r.status, data: j || { ok: false, error: "HTTP " + r.status } };
      }

      var S = {
        wrap: {
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          maxWidth: "720px",
          fontSize: "13px",
          lineHeight: 1.55,
        },
        h2: { fontSize: "15px", fontWeight: 600, margin: 0 },
        p: { margin: 0, opacity: 0.72 },
        card: {
          border: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
          borderRadius: "10px",
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        },
        row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
        label: { width: "104px", opacity: 0.7, flexShrink: 0 },
        input: {
          flex: 1,
          minWidth: "180px",
          padding: "7px 10px",
          borderRadius: "7px",
          border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
          background: "transparent",
          color: "inherit",
          fontSize: "13px",
        },
        btn: {
          padding: "6px 14px",
          borderRadius: "7px",
          border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
          background: "color-mix(in srgb, currentColor 8%, transparent)",
          color: "inherit",
          cursor: "pointer",
          fontSize: "13px",
        },
        btnPrimary: {
          padding: "6px 16px",
          borderRadius: "7px",
          border: "1px solid transparent",
          background: "#1A5EC7",
          color: "#fff",
          cursor: "pointer",
          fontSize: "13px",
          fontWeight: 600,
        },
        badge: function (ok) {
          return {
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "2px 10px",
            borderRadius: "999px",
            fontSize: "12px",
            border: "1px solid " + (ok ? "#2f9e63" : "color-mix(in srgb, currentColor 24%, transparent)"),
            color: ok ? "#2f9e63" : "inherit",
          };
        },
        code: {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "12px",
          padding: "2px 6px",
          borderRadius: "5px",
          background: "color-mix(in srgb, currentColor 10%, transparent)",
          userSelect: "all",
        },
        err: { color: "#d9534f", fontSize: "12px" },
        ok: { color: "#2f9e63", fontSize: "12px" },
        hint: { fontSize: "12px", opacity: 0.6 },
      };

      function HduhelpPanel(props) {
        var t = props.t;
        var React = props.React;
        var h = React.createElement;
        var [state, setState] = React.useState(null);
        var [user, setUser] = React.useState("");
        var [pass, setPass] = React.useState("");
        var [busy, setBusy] = React.useState("");
        var [msg, setMsg] = React.useState(null);
        var [models, setModels] = React.useState(null);   // {total, selectedCount, models:[{id,name,selected}]}
        var [picked, setPicked] = React.useState({});     // id -> true
        var [query, setQuery] = React.useState("");
        var [saving, setSaving] = React.useState(false);
        var [copied, setCopied] = React.useState("");

        var load = React.useCallback(async function () {
          var r = await call("/__hduhelp/status");
          if (r.data && r.data.ok) setState(r.data);
        }, []);

        React.useEffect(function () {
          load();
          var timer = setInterval(load, 6000);
          return function () { clearInterval(timer); };
        }, [load]);

        // 登录后自动拉一次完整模型目录，面板一打开就能勾选
        React.useEffect(function () {
          if (state && state.loggedIn && !models) loadModels();
        }, [state && state.loggedIn]);

        async function doLogin() {
          if (!user.trim() || !pass) {
            setMsg({ kind: "err", text: t("errMissing") });
            return;
          }
          setBusy("login");
          setMsg(null);
          try {
            var r = await call("/__hduhelp/login", "POST", { user: user.trim(), pass: pass });
            if (r.data && r.data.ok) {
              setState(r.data);
              setPass("");
              setMsg({ kind: "ok", text: t("statusOk") + " · " + (r.data.user || "") });
            } else {
              setMsg({ kind: "err", text: (r.data && r.data.error) || t("fail") });
            }
          } catch (e) {
            setMsg({ kind: "err", text: String(e && e.message || e) });
          } finally {
            setBusy("");
          }
        }

        async function doLogout() {
          setBusy("logout");
          setMsg(null);
          var r = await call("/__hduhelp/logout", "POST", {});
          if (r.data && r.data.ok) setState(r.data);
          setModels(null);
          setBusy("");
        }

        async function doRefresh() {
          setBusy("refresh");
          var r = await call("/__hduhelp/refresh", "POST", {});
          if (r.data && r.data.ok) setState(r.data);
          else if (r.data && r.data.error) setMsg({ kind: "err", text: r.data.error });
          setBusy("");
        }

        async function loadModels() {
          setBusy("models");
          var r = await call("/__hduhelp/models");
          var d = r.data || {};
          if (d.ok) {
            setModels(d);
            var sel = {};
            (d.models || []).forEach(function (m) { if (m.selected) sel[m.id] = true; });
            setPicked(sel);
          } else {
            setMsg({ kind: "err", text: d.error || ("HTTP " + (d.status || r.status)) });
          }
          setBusy("");
        }

        async function saveSelection() {
          setSaving(true);
          var ids = Object.keys(picked).filter(function (k) { return picked[k]; });
          var r = await call("/__hduhelp/models/selection", "POST", { ids: ids });
          if (r.data && r.data.ok) {
            setMsg({ kind: "ok", text: t("selectionSaved") + " · " + ids.length });
            await loadModels();
            await load();
          } else {
            setMsg({ kind: "err", text: (r.data && r.data.error) || t("fail") });
          }
          setSaving(false);
        }

        async function toggleProxy() {
          var enabled = !(state && state.proxy && state.proxy.running);
          var r = await call("/__hduhelp/proxy", "POST", { enabled: enabled });
          if (r.data && r.data.ok) setState(r.data);
        }

        function copy(text, tag) {
          try {
            navigator.clipboard.writeText(text);
            setCopied(tag);
            setTimeout(function () { setCopied(""); }, 1500);
          } catch (e) { /* ignore */ }
        }

        var loggedIn = Boolean(state && state.loggedIn);
        var proxyInfo = (state && state.proxy) || {};
        return h("div", { style: S.wrap },
          h("div", null,
            h("h2", { style: S.h2 }, t("title")),
            h("p", { style: S.p }, t("intro"))
          ),

          h("div", { style: S.card },
            h("div", { style: S.row },
              h("span", { style: S.badge(loggedIn) }, loggedIn ? "● " + t("statusOk") : "○ " + t("statusNo")),
              state && state.user ? h("span", { style: S.hint }, state.user) : null,
              state && state.loginInflight ? h("span", { style: S.hint }, t("loggingIn")) : null,
              h("span", { style: { flex: 1 } }),
              loggedIn ? h("button", { style: S.btn, onClick: doLogout, disabled: busy === "logout" }, t("logout")) : null
            ),
            loggedIn ? null : h("div", { style: S.row },
              h("input", {
                style: S.input, placeholder: t("user"), value: user, autoComplete: "username",
                onChange: function (e) { setUser(e.target.value); },
              }),
              h("input", {
                style: S.input, placeholder: t("pass"), type: "password", value: pass, autoComplete: "current-password",
                onChange: function (e) { setPass(e.target.value); },
                onKeyDown: function (e) { if (e.key === "Enter") doLogin(); },
              }),
              h("button", {
                style: S.btnPrimary, onClick: doLogin, disabled: busy === "login",
              }, busy === "login" ? t("loggingIn") : t("login"))
            ),
            msg
              ? h("div", { style: msg.kind === "err" ? S.err : S.ok }, msg.text)
              : (!loggedIn && state && state.lastError
                  ? h("div", { style: S.err }, "上次登录失败：" + state.lastError)
                  : null),
            loggedIn ? h("div", { style: S.row },
              h("button", { style: S.btn, onClick: doRefresh, disabled: busy === "refresh" }, t("refresh")),
              h("button", { style: S.btn, onClick: loadModels, disabled: busy === "models" }, t("manageModels"))
            ) : null
          ),

          state && state.provider ? h("div", { style: S.card },
            h("div", { style: S.row },
              h("span", { style: S.badge(state.provider.registered) },
                (state.provider.registered ? t("providerOk") : t("providerNo")) + " · " + state.provider.id),
              h("span", { style: S.hint },
                (state.provider.models || 0) + " " + t("providerModels")),
              state.provider.sample && state.provider.sample.length
                ? h("span", { style: S.hint }, state.provider.sample.slice(0, 4).join(" · "))
                : null
            ),
            h("p", { style: S.p }, t("providerHint")),
            state.quota ? h("div", { style: S.row },
              h("span", { style: S.label }, t("quota")),
              h("span", { style: S.hint }, quotaView(state.quota, t).text),
              h("span", { style: { flex: 1 } }),
              quotaView(state.quota, t).title.split("\n").slice(1).map(function (line, i) {
                return h("span", { key: i, style: S.hint }, line);
              })
            ) : null
          ) : null,

          loggedIn && proxyInfo.baseUrl ? h("div", { style: S.card },
            h("div", { style: S.row },
              h("span", { style: S.label }, t("proxy")),
              h("code", { style: S.code }, proxyInfo.baseUrl),
              h("button", { style: S.btn, onClick: function () { copy(proxyInfo.baseUrl, "url"); } },
                copied === "url" ? t("copied") : t("copy")),
              h("span", { style: S.badge(proxyInfo.running) }, (proxyInfo.running ? t("running") : t("stopped")) + " · " + (proxyInfo.port || ""))
            ),
            h("div", { style: S.row },
              h("span", { style: S.label }, t("apiKey")),
              h("code", { style: S.code }, proxyInfo.apiKey || "sk-hduhelp"),
              h("button", { style: S.btn, onClick: function () { copy(proxyInfo.apiKey || "sk-hduhelp", "key"); } },
                copied === "key" ? t("copied") : t("copy")),
              h("span", { style: { flex: 1 } }),
              h("button", { style: S.btn, onClick: toggleProxy },
                proxyInfo.running ? t("stopProxy") : t("startProxy"))
            ),
            h("p", { style: S.p }, t("usage"))
          ) : null,

          loggedIn && models ? h("div", { style: S.card },
            h("div", { style: S.row },
              h("span", { style: { opacity: 0.7 } },
                t("manageModels") + " · " + t("selectedCount") + " " + (models.selectedCount || 0) + "/" + (models.total || 0)),
              h("span", { style: { flex: 1 } }),
              h("button", { style: S.btn, onClick: function () {
                var all = {}; (models.models || []).forEach(function (m) { all[m.id] = true; }); setPicked(all);
              } }, t("selectAll")),
              h("button", { style: S.btn, onClick: function () { setPicked({}); } }, t("selectNone")),
              h("button", { style: S.btnPrimary, onClick: saveSelection, disabled: saving }, t("saveSelection"))
            ),
            h("p", { style: S.hint }, t("selectionHint")),
            h("input", {
              style: S.input, placeholder: t("searchModels"), value: query,
              onChange: function (e) { setQuery(e.target.value); },
            }),
            h("div", { style: { maxHeight: "240px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px" } },
              (models.models || [])
                .filter(function (m) {
                  if (!query.trim()) return true;
                  var q = query.trim().toLowerCase();
                  return String(m.id).toLowerCase().indexOf(q) !== -1 || String(m.name || "").toLowerCase().indexOf(q) !== -1;
                })
                .map(function (m) {
                  return h("label", {
                    key: m.id,
                    style: { display: "flex", alignItems: "center", gap: "8px", padding: "3px 2px", cursor: "pointer" },
                  },
                    h("input", {
                      type: "checkbox",
                      checked: !!picked[m.id],
                      onChange: function (e) {
                        var next = Object.assign({}, picked);
                        if (e.target.checked) next[m.id] = true;
                        else delete next[m.id];
                        setPicked(next);
                      },
                    }),
                    h("span", { style: { fontSize: "12px" } }, m.id),
                    m.contextWindow ? h("span", { style: S.hint }, Math.round(m.contextWindow / 1000) + "k") : null,
                    m.reasoningLevels && m.reasoningLevels.length
                      ? h("span", { style: S.hint }, "思考 " + m.reasoningLevels.join("/"))
                      : null
                  );
                })
            )
          ) : null
        );
      }

      function fmtReset(ts) {
        if (!ts) return "";
        var d = new Date(ts * 1000);
        var hh = String(d.getHours()).padStart(2, "0");
        var mm = String(d.getMinutes()).padStart(2, "0");
        return hh + ":" + mm;
      }

      function quotaView(q, t) {
        if (!q) return { text: t("quotaEmpty"), title: t("quota"), color: "inherit" };
        // 额度已恢复但还没拿到新快照时，别继续显示 100%
        if (q.exhausted && q.at && q.retryAfter && Date.now() > q.at + q.retryAfter * 1000) {
          return { text: t("quotaEmpty"), title: t("quota"), color: "inherit" };
        }
        var w5 = q.windows && q.windows["5h"];
        var w7 = q.windows && q.windows["7d"];
        var pct5 = w5 ? Math.round(w5.utilization * 100) : null;
        var pct7 = w7 ? Math.round(w7.utilization * 100) : null;
        var text = q.exhausted
          ? t("quotaExhausted") + (q.retryAfter ? " · " + Math.ceil(q.retryAfter / 60) + t("quotaWait") : "")
          : [pct5 !== null ? "5h " + pct5 + "%" : null, pct7 !== null ? "7d " + pct7 + "%" : null]
              .filter(Boolean).join(" · ") || t("quotaEmpty");
        var tip = [t("quota")];
        if (w5) tip.push(t("quota5h") + ": " + t("quotaUsed") + " " + pct5 + "%" + (w5.resetAt ? " · " + t("quotaReset") + " " + fmtReset(w5.resetAt) : ""));
        if (w7) tip.push(t("quota7d") + ": " + t("quotaUsed") + " " + pct7 + "%" + (w7.resetAt ? " · " + t("quotaReset") + " " + fmtReset(w7.resetAt) : ""));
        if (q.exhausted && q.retryAfter) tip.push(Math.ceil(q.retryAfter / 60) + " " + t("quotaWait"));
        var color = q.exhausted ? "#d9534f" : (pct5 !== null && pct5 >= 80) ? "#d98c34" : "#2f9e63";
        return { text: text, title: tip.join("\n"), color: color };
      }

      function QuotaChip(props) {
        var React = props.React;
        var h = React.createElement;
        var t = props.t;
        var [data, setData] = React.useState(null);
        React.useEffect(function () {
          var alive = true;
          var load = async function () {
            try {
              var r = await call("/__hduhelp/quota");
              if (alive && r.data && r.data.ok) setData(r.data);
            } catch (e) { /* ignore */ }
          };
          load();
          var timer = setInterval(load, 30000);
          return function () { alive = false; clearInterval(timer); };
        }, []);
        if (!data || !data.loggedIn) return null;
        var v = quotaView(data.quota, t);
        return h("button", {
          type: "button",
          title: v.title,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "2px 7px",
            margin: "0 4px",
            borderRadius: "999px",
            border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
            background: "transparent",
            color: "inherit",
            fontSize: "11px",
            lineHeight: 1.4,
            cursor: "default",
            whiteSpace: "nowrap",
          },
        },
          h("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: v.color, flexShrink: 0 } }),
          h("span", null, v.text)
        );
      }

      var inject = ["slots", "locale"];

      function apply(ctx) {
        if (!React || !ctx.slots || !ctx.locale || typeof ctx.locale.register !== "function") {
          try { console.warn("[dsh-hduhelp-ai] 缺少 react/slots/locale，跳过设置面板"); } catch (e) {}
          return;
        }
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        }, "dsh-hduhelp-ai: locale");
        var t = ctx.locale.bind(NS);

        // ── 额度胶囊：只在当前会话的 provider 是 hduhelp 时渲染 ─────────────
        // 位置贴「完全权限 / 工作区内修改」按钮右边（主题渲染的 DOM，无相邻 slot）。
        // provider 从 ctx.modelDirectories 的会话 store 读，跟模型选择器同一份数据。
        var chip = { host: null, root: null, cleanup: null, owner: null };

        function mountChip() {
          if (chip.host || !ReactDOM || !ReactDOM.createRoot) return;
          var host = document.createElement("div");
          host.id = "dsh-hduhelp-quota-inline";
          host.style.cssText = "display:inline-flex;align-items:center;flex:none;margin-left:6px;";
          var root = ReactDOM.createRoot(host);
          root.render(React.createElement(QuotaChip, { t: t, React: React, inline: true }));

          var stopped = false;
          function anchor() {
            var el = document.querySelector(".dsh-claude-perm-container");
            if (el && el.parentElement) return el;
            var slot = document.querySelector('[data-slot="conversation.input.permission"]');
            if (slot && slot.parentElement) return slot;
            return null;
          }
          function place() {
            if (stopped) return false;
            var a = anchor();
            if (!a) return false;
            if (host.previousElementSibling === a) return true;
            a.insertAdjacentElement("afterend", host);
            return true;
          }
          var mo = new MutationObserver(function () { place(); });
          mo.observe(document.body, { childList: true, subtree: true });
          var timer = setInterval(place, 1500);
          place();

          chip.host = host;
          chip.root = root;
          chip.cleanup = function () {
            stopped = true;
            mo.disconnect();
            clearInterval(timer);
            try { root.unmount(); } catch (e) {}
            host.remove();
            chip.host = null;
            chip.root = null;
            chip.cleanup = null;
          };
        }

        function unmountChip() {
          if (chip.cleanup) { try { chip.cleanup(); } catch (e) {} }
          chip.host = null;
          chip.root = null;
          chip.cleanup = null;
        }

        function syncChip(sessionId, provider) {
          if (provider === "hduhelp") {
            chip.owner = sessionId;
            mountChip();
          } else if (chip.owner === sessionId) {
            chip.owner = null;
            unmountChip();
          }
        }

        // 空渲染桥：跑在 composer 槽位里拿 sessionId，并订阅该会话的模型选择。
        function ProviderBridge(props) {
          var sessionId = props && props.sessionId;
          React.useEffect(function () {
            if (!sessionId) return;
            var dirs = null;
            try { dirs = (typeof ctx.get === "function" ? ctx.get("modelDirectories") : null); } catch (e) { dirs = null; }
            if (!dirs) { try { dirs = ctx.modelDirectories; } catch (e) { dirs = null; } }
            if (!dirs || typeof dirs.directoryFor !== "function") return;
            var dir = null;
            try { dir = dirs.directoryFor(sessionId); } catch (e) { return; }
            var store = dir && dir.store;
            if (!store) return;
            function apply() {
              var snap = null;
              try { snap = store.getSnapshot(); } catch (e) { snap = null; }
              var current = snap && snap.current;
              syncChip(sessionId, current && current.provider);
            }
            apply();
            var unsub = null;
            try { unsub = store.subscribe(apply); } catch (e) { unsub = null; }
            return function () {
              if (typeof unsub === "function") { try { unsub(); } catch (e) {} }
              if (chip.owner === sessionId) { chip.owner = null; unmountChip(); }
            };
          }, [sessionId]);
          return null;
        }

        try {
          ctx.slots.inject("conversation.input.left", function () {
            return ctx.slots.register({
              name: "conversation.input.left",
              id: "hduhelp-ai-provider-bridge",
              order: -100,
            }, ProviderBridge);
          });
        } catch (e) { /* 没有 composer 槽位就只留设置页 */ }

        ctx.effect(function () { return function () { unmountChip(); }; }, "dsh-hduhelp-ai: quota chip");

        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "hduhelp-ai",
            order: 46,
            label: function () { return t("nav"); },
            locale: NS,
            inject: function () { return { t: t }; },
          }, function (ownerProps) {
            return React.createElement(HduhelpPanel, { ctx: ctx, t: t, React: React });
          });
        });
      }

      exports.inject = inject;
      exports.apply = apply;
      exports.name = "dsh-hduhelp-ai";
      return module.exports;
    },
  });
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : null);
