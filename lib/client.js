// dsh-hduhelp-ai — 浏览器半边（client plugin bundle）。
//
// 由 dsh-client-modules 在 /plugins/dsh-hduhelp-ai/client.js 提供，经宿主
// __ModuleLoader__ 的 lazy-CJS 模块表执行。面板注册到 settings.section，
// 额度胶囊注册到宿主原生槽位 conversation.input.right（不再注入别人的 DOM）。
// 通过同源 fetch 调宿主 /__hduhelp/* 路由完成登录 / 登出 / 勾选模型 / 看额度。
(function (root) {
  if (!root || !root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== "function") return;

  root.__ModuleLoader__.load({
    id: "dsh-hduhelp-ai",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;

      var React = null;
      try { React = require("react"); } catch (e) { React = null; }

      var NS = "hduhelp-ai";

      var zh = {
        nav: "杭电助手 AI",
        title: "杭电助手 AI · DSH 模型接入",
        intro: "用杭电统一身份认证（学号 + 密码）登录后，插件把杭电助手的 AI 模型注册进 DSH 模型列表，仅供账号所有者本人使用。",
        user: "学号 / 工号",
        pass: "统一身份认证密码",
        login: "登录",
        loggingIn: "登录中…",
        logout: "退出登录",
        refresh: "立即续期",
        renewing: "续期中…",
        statusOk: "已登录",
        statusNo: "未登录",
        expiresAt: "凭证到期",
        manageModels: "模型注册",
        selectedCount: "已选",
        selectAll: "全选",
        selectNone: "清空",
        saveSelection: "保存选择",
        searchModels: "搜索模型 id / 名称",
        selectionSaved: "已保存",
        selectionRejected: "个 id 不在上游目录里，已忽略",
        selectionHint: "没勾选任何模型时，模型选择器里不会出现「杭电助手」；未勾选的模型直接调用会报错。",
        providerOk: "已注册 provider",
        providerNo: "未注册（宿主 llm 服务不可用）",
        providerHint: "登录后在聊天输入框上方的模型选择器里选「杭电助手」，就能直接用这里的模型跑 agent。",
        providerModels: "个模型",
        providerNoneSelected: "还没有勾选模型：勾选并保存后才会出现在模型选择器里。",
        capDeclared: "上游声明",
        ctxUndeclared: "上下文未声明",
        visionYes: "图片 ✓",
        visionNo: "图片 ✗",
        visionUnknown: "图片 ?（上游未声明）",
        visionConflict: "图片声明冲突，按不支持处理",
        toolsNo: "不支持工具调用",
        toolsUnknown: "工具能力未声明",
        quota: "用量额度",
        quotaSource: "仅统计本插件发出的请求；官方 App 的消耗不在内。",
        quotaUnknown: "AI —",
        quotaUnobserved: "尚未观测到额度（发一次请求后显示）",
        quotaExhausted: "额度已用尽",
        quotaMaybeBack: "额度可能已恢复，待下次请求确认",
        quotaStale: "待刷新",
        quota5h: "5 小时窗口",
        quota7d: "7 天窗口",
        quotaReset: "窗口重置于",
        quotaUsed: "已用",
        quotaObserved: "观测于",
        quotaWait: "分钟后恢复",
        fail: "失败",
        errMissing: "学号和密码都要填",
        lastFail: "上次失败：",
      };

      var en = {
        nav: "HDUHelp AI",
        title: "HDUHelp AI · DSH models",
        intro: "Sign in with your HDU campus account (student ID + password). The plugin registers HDUHelp AI models into DSH for the account owner's own use.",
        user: "Student ID",
        pass: "Campus password",
        login: "Sign in",
        loggingIn: "Signing in…",
        logout: "Sign out",
        refresh: "Renew now",
        renewing: "Renewing…",
        statusOk: "Signed in",
        statusNo: "Signed out",
        expiresAt: "Credential expires",
        manageModels: "Registered models",
        selectedCount: "selected",
        selectAll: "All",
        selectNone: "None",
        saveSelection: "Save",
        searchModels: "Search model id / name",
        selectionSaved: "Saved",
        selectionRejected: "ids are not in the upstream catalog and were ignored",
        selectionHint: "With no model selected, HDUHelp will not appear in the model selector; calling an unselected model fails.",
        providerOk: "provider registered",
        providerNo: "not registered (host llm service unavailable)",
        providerHint: "After signing in, pick \"HDUHelp\" in the model selector above the composer to run the agent on these models.",
        providerModels: "models",
        providerNoneSelected: "No model selected yet: pick some and save to make them appear in the selector.",
        capDeclared: "upstream-declared",
        ctxUndeclared: "context undeclared",
        visionYes: "image ✓",
        visionNo: "image ✗",
        visionUnknown: "image ? (undeclared)",
        visionConflict: "conflicting image declaration, treated as unsupported",
        toolsNo: "no tool calling",
        toolsUnknown: "tool support undeclared",
        quota: "Quota",
        quotaSource: "Counts only requests made by this plugin; the official app's usage is not included.",
        quotaUnknown: "AI —",
        quotaUnobserved: "No quota observed yet (send one request first)",
        quotaExhausted: "quota exhausted",
        quotaMaybeBack: "quota may have recovered; next request will confirm",
        quotaStale: "stale",
        quota5h: "5h window",
        quota7d: "7d window",
        quotaReset: "window resets",
        quotaUsed: "used",
        quotaObserved: "observed",
        quotaWait: "min to reset",
        fail: "failed",
        errMissing: "Student ID and password are both required",
        lastFail: "Last failure: ",
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
        err: { color: "#d9534f", fontSize: "12px" },
        ok: { color: "#2f9e63", fontSize: "12px" },
        hint: { fontSize: "12px", opacity: 0.6 },
      };

      function fmtClock(ts) {
        if (!ts) return "";
        var d = new Date(ts * 1000);
        var hh = String(d.getHours()).padStart(2, "0");
        var mm = String(d.getMinutes()).padStart(2, "0");
        return hh + ":" + mm;
      }

      /**
       * 额度只如实呈现「上次观测」：
       *   · 窗口过了 resetAt 只标「待刷新」，不当成 0%（滚动窗口重置不等于额度归零）。
       *   · 5h 重置不代表 7d 解限；只有新的成功观测才清除「用尽」。
       *   · retryAfter 走完只说「可能已恢复」，不宣称已恢复。
       */
      function quotaView(q, t) {
        var unknown = { text: t("quotaUnknown"), title: t("quota") + "\n" + t("quotaUnobserved") + "\n" + t("quotaSource"), color: "inherit", stale: true };
        if (!q) return unknown;

        var now = Date.now();
        var w5 = q.windows && q.windows["5h"];
        var w7 = q.windows && q.windows["7d"];

        function pctOf(w) {
          if (!w) return null;
          var n = Number(w.utilization);
          if (!isFinite(n)) return null;
          return Math.round(n * 100);
        }
        function staleOf(w) {
          return Boolean(w && w.resetAt && now >= w.resetAt * 1000);
        }
        var pct5 = pctOf(w5);
        var pct7 = pctOf(w7);
        var anyStale = staleOf(w5) || staleOf(w7);

        var tip = [t("quota"), t("quotaSource")];
        function line(name, w, pct) {
          if (!w || pct === null) return;
          var s = name + ": " + t("quotaUsed") + " " + pct + "%";
          if (w.resetAt) s += " · " + t("quotaReset") + " " + fmtClock(w.resetAt);
          if (w.observedAt) s += " · " + t("quotaObserved") + " " + fmtClock(w.observedAt / 1000);
          if (staleOf(w)) s += " · " + t("quotaStale");
          tip.push(s);
        }
        line(t("quota5h"), w5, pct5);
        line(t("quota7d"), w7, pct7);

        // 「用尽」只由新观测推翻：宿主在成功响应里写 exhausted=false。
        if (q.exhausted === true) {
          var waited = q.retryAfter && q.at && now > q.at + q.retryAfter * 1000;
          var text = waited ? t("quotaMaybeBack") : t("quotaExhausted");
          if (!waited && q.retryAfter) text += " · " + Math.ceil(q.retryAfter / 60) + t("quotaWait");
          if (q.retryAfter) tip.push(Math.ceil(q.retryAfter / 60) + " " + t("quotaWait"));
          return { text: text, title: tip.join("\n"), color: waited ? "#d98c34" : "#d9534f", stale: Boolean(waited) };
        }

        if (pct5 === null && pct7 === null) return unknown;

        var parts = [];
        if (pct5 !== null) parts.push("5h " + pct5 + "%");
        if (pct7 !== null) parts.push("7d " + pct7 + "%");
        if (anyStale) parts.push(t("quotaStale"));
        var worst = Math.max(pct5 === null ? 0 : pct5, pct7 === null ? 0 : pct7);
        var color = anyStale ? "inherit" : (worst >= 80 ? "#d98c34" : "#2f9e63");
        return { text: parts.join(" · "), title: tip.join("\n"), color: color, stale: anyStale };
      }

      function HduhelpPanel(props) {
        var t = props.t;
        var React = props.React;
        var h = React.createElement;
        var [state, setState] = React.useState(null);
        var [user, setUser] = React.useState("");
        var [pass, setPass] = React.useState("");
        var [busy, setBusy] = React.useState("");
        var [msg, setMsg] = React.useState(null);
        var [models, setModels] = React.useState(null);
        var [picked, setPicked] = React.useState({});
        var [query, setQuery] = React.useState("");
        var [saving, setSaving] = React.useState(false);

        var load = React.useCallback(async function () {
          var r = await call("/__hduhelp/status");
          if (r.data && r.data.ok) setState(r.data);
        }, []);

        React.useEffect(function () {
          load();
          var timer = setInterval(load, 6000);
          return function () { clearInterval(timer); };
        }, [load]);

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
          setPicked({});
          setBusy("");
        }

        async function doRenew() {
          setBusy("refresh");
          var r = await call("/__hduhelp/refresh", "POST", {});
          if (r.data && r.data.ok) { setState(r.data); setMsg(null); }
          else if (r.data && r.data.error) setMsg({ kind: "err", text: r.data.error });
          await load();
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
            var extra = (r.data.rejected && r.data.rejected.length)
              ? " · " + r.data.rejected.length + " " + t("selectionRejected")
              : "";
            setMsg({ kind: "ok", text: t("selectionSaved") + " · " + (r.data.selectedCount || 0) + extra });
            await loadModels();
            await load();
          } else {
            setMsg({ kind: "err", text: (r.data && r.data.error) || t("fail") });
          }
          setSaving(false);
        }

        var loggedIn = Boolean(state && state.loggedIn);
        var qv = quotaView(state && state.quota, t);
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
              state && state.renewing ? h("span", { style: S.hint }, t("renewing")) : null,
              loggedIn && state && state.expiresAt
                ? h("span", { style: S.hint }, t("expiresAt") + " " + fmtClock(Number(state.expiresAt) / 1000))
                : null,
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
              : (state && state.lastError
                  ? h("div", { style: S.err }, t("lastFail") + state.lastError)
                  : null),
            loggedIn ? h("div", { style: S.row },
              h("button", { style: S.btn, onClick: doRenew, disabled: busy === "refresh" }, t("refresh")),
              h("button", { style: S.btn, onClick: loadModels, disabled: busy === "models" }, t("manageModels"))
            ) : null
          ),

          state && state.provider ? h("div", { style: S.card },
            h("div", { style: S.row },
              h("span", { style: S.badge(state.provider.registered) },
                (state.provider.registered ? t("providerOk") : t("providerNo")) + " · " + state.provider.id),
              h("span", { style: S.hint }, (state.provider.models || 0) + " " + t("providerModels")),
              state.provider.sample && state.provider.sample.length
                ? h("span", { style: S.hint }, state.provider.sample.slice(0, 4).join(" · "))
                : null
            ),
            h("p", { style: S.p }, t("providerHint")),
            loggedIn && !state.provider.models
              ? h("p", { style: S.err }, t("providerNoneSelected"))
              : null,
            loggedIn ? h("div", { style: S.row },
              h("span", { style: S.label }, t("quota")),
              h("span", { style: { fontSize: "12px", color: qv.color } }, qv.text),
              h("span", { style: { flex: 1 } }),
              h("span", { style: S.hint }, t("quotaSource"))
            ) : null
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
            h("p", { style: S.hint }, t("capDeclared") + " · " + t("visionUnknown") + " / " + t("ctxUndeclared")),
            h("input", {
              style: S.input, placeholder: t("searchModels"), value: query,
              onChange: function (e) { setQuery(e.target.value); },
            }),
            h("div", { style: { maxHeight: "260px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px" } },
              (models.models || [])
                .filter(function (m) {
                  if (!query.trim()) return true;
                  var q = query.trim().toLowerCase();
                  return String(m.id).toLowerCase().indexOf(q) !== -1 || String(m.name || "").toLowerCase().indexOf(q) !== -1;
                })
                .map(function (m) {
                  var visionLabel = m.visionConflict ? t("visionConflict")
                    : m.vision === true ? t("visionYes")
                    : m.vision === false ? t("visionNo")
                    : t("visionUnknown");
                  return h("label", {
                    key: m.id,
                    style: { display: "flex", alignItems: "center", gap: "8px", padding: "3px 2px", cursor: "pointer", flexWrap: "wrap" },
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
                    m.contextWindow
                      ? h("span", { style: S.hint }, Math.round(m.contextWindow / 1000) + "k")
                      : h("span", { style: S.hint }, t("ctxUndeclared")),
                    h("span", { style: S.hint }, visionLabel),
                    m.functionCall === false ? h("span", { style: S.err }, t("toolsNo")) : null,
                    m.functionCall === null ? h("span", { style: S.hint }, t("toolsUnknown")) : null,
                    m.reasoningLevels && m.reasoningLevels.length
                      ? h("span", { style: S.hint }, "思考 " + m.reasoningLevels.join("/"))
                      : null
                  );
                })
            )
          ) : null
        );
      }

      /**
       * 额度胶囊：注册进宿主原生 composer 槽位，随会话渲染/卸载。
       * 只在当前会话选中的 provider 是 hduhelp 时显示，provider 从宿主的
       * modelDirectories 会话 store 订阅（与模型选择器同一份数据）。
       */
      function QuotaChip(props) {
        var React = props.React;
        var h = React.createElement;
        var t = props.t;
        var directory = props.directory;
        var [provider, setProvider] = React.useState(null);
        var [data, setData] = React.useState(null);

        React.useEffect(function () {
          if (!directory || typeof directory.getSnapshot !== "function") return;
          var alive = true;
          function read() {
            var snap = null;
            try { snap = directory.getSnapshot(); } catch (e) { snap = null; }
            var current = snap && snap.current;
            if (alive) setProvider(current && current.provider ? current.provider : null);
          }
          read();
          var unsub = null;
          try { unsub = directory.subscribe(read); } catch (e) { unsub = null; }
          return function () {
            alive = false;
            if (typeof unsub === "function") { try { unsub(); } catch (e) {} }
          };
        }, [directory]);

        var active = provider === "hduhelp";
        React.useEffect(function () {
          if (!active) return;
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
        }, [active]);

        if (!active || !data || !data.loggedIn) return null;
        var v = quotaView(data.quota, t);
        return h("span", {
          title: v.title,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "2px 7px",
            borderRadius: "999px",
            border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
            fontSize: "11px",
            lineHeight: 1.4,
            whiteSpace: "nowrap",
            opacity: v.stale ? 0.7 : 1,
          },
        },
          h("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: v.color === "inherit" ? "currentColor" : v.color, flexShrink: 0 } }),
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

        // 额度胶囊走原生槽位：conversation.input.right 是 session 级 list 槽位，
        // 由宿主负责挂载/卸载，插件不碰任何 DOM，也不依赖别的主题的私有 class。
        ctx.inject(["slots", "modelDirectories"], function (scope) {
          var models = scope.modelDirectories;
          scope.slots.inject("conversation.input.right", function () {
            return scope.slots.register({
              name: "conversation.input.right",
              id: "hduhelp-ai-quota",
              order: -10,
              locale: NS,
              inject: function (sessionId) {
                var directory = null;
                try { directory = models.directoryFor(sessionId).store; } catch (e) { directory = null; }
                return { t: t, React: React, directory: directory };
              },
            }, QuotaChip);
          });
        });

        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "hduhelp-ai",
            order: 46,
            label: function () { return t("nav"); },
            locale: NS,
            inject: function () { return { t: t }; },
          }, function () {
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