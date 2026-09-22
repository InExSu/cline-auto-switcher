// The dashboard page: one self-contained HTML document.
//
// No build step, no CDN, no framework. Everything below is assembled server-side
// and served from a single route, so the dashboard works offline and the whole
// UI is one file to read.
//
// Design: a paper account ledger. Warm bone ground, warm near-black ink, hairline
// rules that encode row structure, and two clearly separated type families —
// Georgia for anything prose, a mono with tabular figures for anything that is
// data (emails, ids, countdowns). One accent, rust, spent entirely on the account
// currently in use. The live countdown is the only thing that moves.

const CSS = `
:root{
  --paper:#f6f2e9;
  --ink:#191713;
  --rule:#ddd4c2;
  --rule-strong:#c6bba4;
  --muted:#7d7566;
  --live:#a33b12;
  --cooling:#8a6a1f;
  --serif:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;
  --mono:ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,monospace;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--paper);color:var(--ink);
  font-family:var(--serif);font-size:16px;line-height:1.55;font-kerning:normal;
}
.wrap{
  max-width:46rem;margin:0 auto;padding:4rem 1.5rem 2.5rem;
  min-height:100vh;display:flex;flex-direction:column;
}

.head{
  display:flex;align-items:baseline;justify-content:space-between;gap:2rem;
  flex-wrap:wrap;padding-bottom:.85rem;border-bottom:1px solid var(--rule-strong);
}
.title{margin:0;font-size:1.5rem;font-weight:400;letter-spacing:-.012em}
.model{font-family:var(--mono);font-size:.75rem;color:var(--muted);white-space:nowrap;margin:0}
.model span{color:var(--ink)}

.list{list-style:none;margin:0;padding:0}
.row{
  position:relative;display:grid;grid-template-columns:.75rem minmax(0,1fr) auto auto;
  align-items:center;column-gap:1.1rem;padding:.95rem 0 .95rem .6rem;
  border-bottom:1px solid var(--rule);
}
.row.is-live::before{
  content:"";position:absolute;left:0;top:.4rem;bottom:.4rem;width:2px;background:var(--live);
}
.dot{
  width:.5rem;height:.5rem;border-radius:50%;justify-self:center;
  border:1px solid var(--rule-strong);
}
.row.is-live .dot{background:var(--live);border-color:var(--live)}
.row.is-cooling .dot{border-color:var(--cooling)}

.who{min-width:0}
.email{
  font-family:var(--mono);font-size:.9375rem;line-height:1.35;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.id{font-family:var(--mono);font-size:.6875rem;color:var(--muted)}

.state{text-align:right;white-space:nowrap}
.cell{display:flex;align-items:center;gap:.7rem;justify-content:flex-end;min-width:7.5rem}
.word{font-size:.9375rem}
.row.is-live .word{color:var(--live)}
.row.is-cooling .word{color:var(--cooling)}
.meta{font-family:var(--mono);font-size:.6875rem;color:var(--muted)}
.count{font-family:var(--mono);font-size:.9375rem;font-variant-numeric:tabular-nums}

.btn{
  font-family:var(--mono);font-size:.75rem;line-height:1.2;padding:.34rem .72rem;
  border:1px solid var(--rule-strong);border-radius:2px;background:none;
  color:var(--ink);cursor:pointer;
}
.btn:hover:not(:disabled){border-color:var(--ink)}
.btn:disabled{color:var(--muted);border-color:var(--rule);cursor:default}
.btn.primary{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.btn.primary:hover:not(:disabled){background:#000}
.btn.plain{border:0;padding:.2rem 0;color:var(--muted);text-decoration:underline;text-underline-offset:2px}
.btn.plain:hover:not(:disabled){color:var(--ink)}

.panel{padding:1.35rem .6rem 1.6rem;border-bottom:1px solid var(--rule)}
.panel h2{margin:0 0 .9rem;font-size:1.0625rem;font-weight:400}
.step{margin:0 0 .5rem;color:var(--muted);font-size:.9375rem}
.code-row{display:flex;align-items:center;gap:1.1rem;flex-wrap:wrap;margin:.7rem 0 1.15rem}
.code{font-family:var(--mono);font-size:1.9rem;letter-spacing:.16em;font-variant-numeric:tabular-nums;line-height:1}
.actions{display:flex;align-items:center;gap:1.1rem;flex-wrap:wrap}
.status{font-family:var(--mono);font-size:.75rem;color:var(--muted);margin:1rem 0 0}
.status[data-tone="bad"]{color:var(--live)}

.foot{
  display:flex;align-items:center;justify-content:space-between;gap:1.5rem;
  flex-wrap:wrap;padding-top:1.5rem;margin-top:auto;
}
.foot-actions{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.foot .status{margin:0}
.empty{padding:2.25rem .6rem;border-bottom:1px solid var(--rule);color:var(--muted)}
.empty p{margin:0;max-width:38ch}
.empty strong{font-weight:400;color:var(--ink)}

:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}
@media (max-width:34rem){
  .wrap{padding:3rem 1.1rem 4.5rem}
  .row{grid-template-columns:.75rem minmax(0,1fr) auto;row-gap:.45rem}
  .state{grid-column:2 / 3;text-align:left}
  .row>.cell{grid-column:3 / 4;grid-row:1 / 2}
  .code{font-size:1.5rem}
}
`;

const BODY = `
<div class="wrap">
  <header class="head">
    <h1 class="title">Cline accounts</h1>
    <p class="model">model <span id="model">&mdash;</span></p>
  </header>

  <ul class="list" id="list"></ul>
  <div id="panelHost"></div>

  <footer class="foot">
    <p class="status" id="hint">Cline switches accounts automatically when a model hits its limit.</p>
    <div class="foot-actions">
      <button class="btn plain" id="rotate" type="button">rotate</button>
      <button class="btn plain" id="clearCool" type="button">clear cooldowns</button>
      <button class="btn" id="add" type="button">add an account</button>
    </div>
  </footer>

  <p class="sr" id="live" role="status" aria-live="polite"></p>
</div>
`;

const SCRIPT = `
// Dashboard behaviour. Plain ES5-ish browser JS: no framework, no build.
// Template literals are deliberately avoided so this file can be embedded in a
// JS template literal without escaping.
(function () {
  var TOKEN = __TOKEN__;

  function api(path, body) {
    var init = { headers: { "x-switcher-token": TOKEN } };
    if (body !== undefined) {
      init.method = "POST";
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        return data;
      });
    });
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function fmtLeft(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m " + pad(s % 60) + "s";
    return s + "s";
  }

  function ago(iso) {
    if (!iso) return null;
    var d = Date.now() - Date.parse(iso);
    if (!isFinite(d) || d < 0) return null;
    if (d < 60000) return "just now";
    var m = Math.floor(d / 60000);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  var state = { accounts: [], model: null };
  var flow = { phase: "idle" };
  var authTimer = null;

  var list = document.getElementById("list");
  var panelHost = document.getElementById("panelHost");
  var modelEl = document.getElementById("model");
  var addBtn = document.getElementById("add");
  var rotateBtn = document.getElementById("rotate");
  var clearBtn = document.getElementById("clearCool");
  var hint = document.getElementById("hint");
  var live = document.getElementById("live");

  function announce(msg) { live.textContent = msg; }

  function metaFor(a) {
    if (a.terminal) return "out of credits";
    if (a.coolingUntil) {
      var what = a.coolingFor || "all models";
      return a.strikes > 1 ? what + " \\u00b7 " + a.strikes + " strikes" : what;
    }
    var when = ago(a.lastUsedAt);
    if (when) return "last used " + when;
    return a.active ? "in providers.json" : "never used";
  }

  function buildRow(a) {
    var li = el("li", "row" + (a.active ? " is-live" : "") + (a.coolingUntil ? " is-cooling" : ""));
    li.appendChild(el("span", "dot"));

    var who = el("div", "who");
    var name = a.email || a.label || a.id;
    var emailEl = el("div", "email", name);
    emailEl.title = name;
    who.appendChild(emailEl);
    who.appendChild(el("div", "id", a.id));
    li.appendChild(who);

    var cell = el("div", "state");
    var line = el("div", "word", a.active ? "in use" : a.coolingUntil ? "cooling" : "available");
    if (a.coolingUntil) {
      var count = el("span", "count");
      count.dataset.until = String(a.coolingUntil);
      count.textContent = fmtLeft(a.coolingUntil - Date.now());
      line.appendChild(document.createTextNode(" "));
      line.appendChild(count);
    }
    cell.appendChild(line);
    cell.appendChild(el("div", "meta", metaFor(a)));
    li.appendChild(cell);

    var actions = el("div", "cell");
    if (!a.active) {
      var use = el("button", "btn", "use");
      use.type = "button";
      use.addEventListener("click", function () { switchTo(a.id, use); });
      actions.appendChild(use);

      var del = el("button", "btn plain", "remove");
      del.type = "button";
      del.addEventListener("click", function () { removeAccount(a, del); });
      actions.appendChild(del);
    }
    li.appendChild(actions);
    return li;
  }

  function renderRows() {
    list.innerHTML = "";
    if (!state.accounts.length) {
      var li = el("li", "empty");
      var p = document.createElement("p");
      p.appendChild(el("strong", null, "No accounts yet."));
      p.appendChild(document.createTextNode(
        " Add one and Cline moves to it automatically when a model hits its limit."
      ));
      li.appendChild(p);
      list.appendChild(li);
      return;
    }
    state.accounts.forEach(function (a) { list.appendChild(buildRow(a)); });
  }

  function switchTo(id, btn) {
    btn.disabled = true;
    btn.textContent = "switching";
    api("/api/switch", { id: id })
      .then(function (res) {
        announce("Now using " + (res.email || id));
        return refresh();
      })
      .catch(function (e) {
        hint.textContent = e.message;
        hint.dataset.tone = "bad";
        btn.disabled = false;
        btn.textContent = "use";
      });
  }

  function removeAccount(a, btn) {
    var name = a.email || a.label || a.id;
    if (!window.confirm("Remove " + name + " from the switcher?")) return;
    btn.disabled = true;
    api("/api/accounts/remove", { id: a.id })
      .then(function () { announce("Removed " + name); return refresh(); })
      .catch(function (e) {
        hint.textContent = e.message;
        hint.dataset.tone = "bad";
        btn.disabled = false;
        btn.textContent = "remove";
      });
  }

  function rotateNow(btn) {
    btn.disabled = true;
    api("/api/rotate", {})
      .then(function (res) {
        if (res.rotated) {
          var to = state.accounts.filter(function (a) { return a.id === res.to; })[0];
          announce("Rotated to " + (to ? to.email || to.label || to.id : res.to));
        } else {
          hint.textContent = "Nothing to rotate to. " +
            (res.reason === "no-accounts" ? "Add an account first." : "No other account is enrolled.");
          hint.dataset.tone = "bad";
        }
        return refresh();
      })
      .catch(function (e) {
        hint.textContent = e.message;
        hint.dataset.tone = "bad";
      })
      .then(function () { btn.disabled = false; });
  }

  function clearCooldowns(btn) {
    btn.disabled = true;
    api("/api/cooldowns/reset", {})
      .then(function (res) {
        announce(res.cleared ? "Cleared " + res.cleared + " cooldowns." : "No cooldowns to clear.");
        return refresh();
      })
      .catch(function (e) {
        hint.textContent = e.message;
        hint.dataset.tone = "bad";
      })
      .then(function () { btn.disabled = false; });
  }

  function copyCode(text, btn, label) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = "copied";
      setTimeout(function () { btn.textContent = old; }, 1600);
    };
    var fallback = function () { window.prompt("Copy " + (label || "this") + ":", text); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function renderPanel() {
    panelHost.innerHTML = "";
    if (flow.phase === "idle") return;
    var panel = el("section", "panel");

    if (flow.phase === "starting") {
      panel.appendChild(el("h2", null, "Add an account"));
      panel.appendChild(el("p", "status", "Requesting a sign-in code\\u2026"));
      panelHost.appendChild(panel);
      return;
    }

    if (flow.phase === "waiting") {
      panel.appendChild(el("h2", null, "Add an account"));
      panel.appendChild(el("p", "step",
        "Open the sign-in page, then sign in with the Google account you want to add."));
      panel.appendChild(el("p", "step", "Enter this code:"));

      var row = el("div", "code-row");
      row.appendChild(el("div", "code", flow.userCode));
      var copy = el("button", "btn", "copy code");
      copy.type = "button";
      copy.addEventListener("click", function () { copyCode(flow.userCode, copy, "code"); });
      row.appendChild(copy);
      panel.appendChild(row);

      var actions = el("div", "actions");
      var open = el("button", "btn primary", "Open sign-in page");
      open.type = "button";
      open.addEventListener("click", function () {
        window.open(flow.verificationUriComplete || flow.verificationUri, "_blank", "noopener");
      });
      actions.appendChild(open);

      var copyLink = el("button", "btn", "copy sign-in link");
      copyLink.type = "button";
      copyLink.addEventListener("click", function () {
        copyCode(flow.verificationUriComplete || flow.verificationUri, copyLink, "sign-in link");
      });
      actions.appendChild(copyLink);

      var cancel = el("button", "btn plain", "cancel");
      cancel.type = "button";
      cancel.addEventListener("click", cancelAdd);
      actions.appendChild(cancel);
      panel.appendChild(actions);

      var tip = el("p", "step",
        "Tip: To use a different Google account, click \\\"copy sign-in link\\\" and paste it into an Incognito / Private window or another browser profile.");
      tip.style.marginTop = "0.75rem";
      tip.style.fontSize = "0.8125rem";
      panel.appendChild(tip);

      var st = el("p", "status", null);
      st.id = "authStatus";
      panel.appendChild(st);
      panelHost.appendChild(panel);
      updateAuthStatus();
      return;
    }

    if (flow.phase === "done") {
      panel.appendChild(el("h2", null, "Account added"));
      panel.appendChild(el("p", "step", "Signed in as " + flow.email + "."));
      panelHost.appendChild(panel);
      return;
    }

    panel.appendChild(el("h2", null, "Could not add the account"));
    var bad = el("p", "status", flow.message);
    bad.dataset.tone = "bad";
    panel.appendChild(bad);
    var retryRow = el("div", "actions");
    var retry = el("button", "btn", "try again");
    retry.type = "button";
    retry.addEventListener("click", startAdd);
    retryRow.appendChild(retry);
    var cancel2 = el("button", "btn plain", "cancel");
    cancel2.type = "button";
    cancel2.addEventListener("click", function () {
      flow = { phase: "idle" };
      addBtn.disabled = false;
      renderPanel();
    });
    retryRow.appendChild(cancel2);
    panel.appendChild(retryRow);
    panelHost.appendChild(panel);
  }

  function updateAuthStatus() {
    var st = document.getElementById("authStatus");
    if (!st || flow.phase !== "waiting") return;
    var left = flow.expiresAt - Date.now();
    if (left <= 0) {
      // Expired: stop polling, drop the pending sign-in, offer a fresh code.
      if (authTimer) { clearInterval(authTimer); authTimer = null; }
      api("/api/auth/cancel", {}).catch(function () {});
      flow = { phase: "error", message: "That code expired before the sign-in finished." };
      addBtn.disabled = false;
      renderPanel();
      announce("Sign-in code expired");
      return;
    }
    st.textContent = "Waiting for you to finish. " + fmtLeft(left) + " left.";
    st.dataset.tone = "";
  }

  function startAdd() {
    if (flow.phase === "starting" || flow.phase === "waiting") return;
    if (authTimer) { clearInterval(authTimer); authTimer = null; }
    flow = { phase: "starting" };
    renderPanel();
    addBtn.disabled = true;
    announce("Requesting a sign-in code");

    api("/api/auth/start", {})
      .then(function (d) {
        flow = {
          phase: "waiting",
          userCode: d.userCode,
          verificationUri: d.verificationUri,
          verificationUriComplete: d.verificationUriComplete,
          expiresAt: Date.now() + d.expiresInSeconds * 1000,
        };
        renderPanel();
        announce("Waiting for sign-in. Code " + d.userCode);
        pollAuth();
      })
      .catch(function (e) {
        // Only a terminal phase re-enables the button: while a code is live
        // there is exactly one sign-in in flight.
        flow = { phase: "error", message: e.message };
        addBtn.disabled = false;
        renderPanel();
      });
  }

  function cancelAdd() {
    if (authTimer) { clearInterval(authTimer); authTimer = null; }
    flow = { phase: "idle" };
    addBtn.disabled = false;
    renderPanel();
    announce("Cancelled");
    api("/api/auth/cancel", {}).catch(function () {});
  }

  function pollAuth() {
    authTimer = setInterval(function () {
      if (flow.phase !== "waiting") {
        clearInterval(authTimer);
        authTimer = null;
        return;
      }
      api("/api/auth/state").then(function (s) {
        if (s.phase === "done") {
          clearInterval(authTimer);
          authTimer = null;
          flow = { phase: "done", email: s.email || "your account" };
          renderPanel();
          announce("Account added");
          refresh().then(function () {
            setTimeout(function () {
              if (flow.phase === "done") {
                flow = { phase: "idle" };
                addBtn.disabled = false;
                renderPanel();
              }
            }, 2600);
          });
        } else if (s.phase === "error") {
          clearInterval(authTimer);
          authTimer = null;
          flow = { phase: "error", message: s.message || "The sign-in did not complete." };
          addBtn.disabled = false;
          renderPanel();
        }
      }).catch(function () { /* keep waiting */ });
    }, 1500);
  }

  function tick() {
    var nodes = document.querySelectorAll(".count[data-until]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = fmtLeft(Number(nodes[i].dataset.until) - Date.now());
    }
    updateAuthStatus();
  }

  function refresh() {
    return api("/api/state").then(function (s) {
      state = s;
      modelEl.textContent = s.model || "not set";
      renderRows();
      if (hint.dataset.tone === "bad") {
        hint.textContent = "Cline switches accounts automatically when a model hits its limit.";
        hint.dataset.tone = "";
      }
    }).catch(function (e) {
      hint.textContent = "Cannot reach the switcher. " + e.message;
      hint.dataset.tone = "bad";
    });
  }

  addBtn.addEventListener("click", startAdd);
  rotateBtn.addEventListener("click", function () { rotateNow(rotateBtn); });
  clearBtn.addEventListener("click", function () { clearCooldowns(clearBtn); });
  refresh();
  setInterval(refresh, 10000);
  setInterval(tick, 1000);
`;

const SCRIPT_TAIL = `
})();
`;

export function renderPage({ token }) {
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1">',
		"<title>Cline accounts</title>",
		"<style>",
		CSS,
		"</style>",
		"</head>",
		"<body>",
		BODY,
		"<script>",
		SCRIPT.replaceAll("__TOKEN__", JSON.stringify(String(token))) + SCRIPT_TAIL,
		"</script>",
		"</body>",
		"</html>",
	].join("\n");
}