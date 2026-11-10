/*
 * Injected into every tapd.cn frame before page scripts run.
 *
 * Responsibilities:
 *  1. Record same-site XHR/fetch calls (metadata + truncated bodies) so the
 *     desktop app can map TAPD's internal web API during M0.
 *  2. Expose a tiny same-origin fetch helper (`__TAPDCB__.request`) that keeps
 *     the user's session cookies.
 *
 * Privacy: request headers are never recorded, so cookies/tokens stay inside
 * the webview. Bodies are bounded and only kept in memory.
 */
(function () {
  "use strict";

  if (window.__TAPDCB__ && window.__TAPDCB__.version === 1) return;

  var MAX_ENTRIES = 150;
  var MAX_REQ_BODY = 64 * 1024;
  var MAX_RES_BODY = 512 * 1024;
  var MAX_TOTAL = 32 * 1024 * 1024;
  var MAX_RPC_BODY = 5 * 1024 * 1024;

  var seq = 0;
  var totalBytes = 0;
  var internalDepth = 0;
  var entries = [];

  var nativeFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  var NativeXHR = window.XMLHttpRequest;
  var isTopFrame = true;
  try {
    isTopFrame = window.top === window;
  } catch (_) {
    isTopFrame = false;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function clip(value, limit) {
    if (typeof value !== "string") return null;
    if (value.length <= limit) return value;
    return value.slice(0, limit) + "\n/* __truncated__ */";
  }

  function isTapdHost(hostname) {
    return hostname === "tapd.cn" || /(^|\.)tapd\.cn$/i.test(hostname);
  }

  function absoluteUrl(raw) {
    try {
      return new URL(String(raw), window.location.href).href;
    } catch (_) {
      return String(raw || "");
    }
  }

  function isInteresting(url, contentType) {
    try {
      var parsed = new URL(url, window.location.href);
      if (!isTapdHost(parsed.hostname)) return false;
      if (parsed.pathname.indexOf("/api/") !== -1) return true;
      if (parsed.pathname.indexOf("/api/") === 0) return true;
      if (contentType && /json|javascript|text\/html|text\/plain/i.test(contentType)) {
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  function pushEntry(entry) {
    entry.ts = entry.ts || nowIso();
    entries.push(entry);
    totalBytes +=
      (entry.requestBody ? entry.requestBody.length : 0) +
      (entry.responseBody ? entry.responseBody.length : 0);

    while (entries.length > MAX_ENTRIES || totalBytes > MAX_TOTAL) {
      var removed = entries.shift();
      if (!removed) break;
      totalBytes -=
        (removed.requestBody ? removed.requestBody.length : 0) +
        (removed.responseBody ? removed.responseBody.length : 0);
    }
  }

  function report(entry) {
    if (isTopFrame) {
      pushEntry(entry);
      return;
    }
    try {
      window.top.postMessage({ __tapdcb: "entry", entry: entry }, "*");
    } catch (_) {
      /* cross-origin iframe: ignore */
    }
  }

  if (isTopFrame) {
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (data && data.__tapdcb === "entry" && data.entry) {
        pushEntry(data.entry);
      }
    });
  }

  function normalizeFetchRequest(input, init) {
    try {
      var method = "GET";
      var url = "";
      var body = null;

      if (typeof Request !== "undefined" && input instanceof Request) {
        method = input.method || "GET";
        url = input.url;
      } else {
        url = absoluteUrl(input);
      }

      if (init && init.method) method = init.method;
      if (init && typeof init.body === "string") body = clip(init.body, MAX_REQ_BODY);

      return { method: String(method).toUpperCase(), url: url, body: body };
    } catch (_) {
      return null;
    }
  }

  if (nativeFetch) {
    window.fetch = function (input, init) {
      var request = normalizeFetchRequest(input, init);
      var started = performance.now();
      var promise = nativeFetch(input, init);

      if (internalDepth > 0 || !request) return promise;

      promise
        .then(function (response) {
          try {
            if (!isInteresting(request.url, response.headers.get("content-type") || "")) {
              return;
            }
            var contentType = response.headers.get("content-type") || "";
            if (/text\/event-stream/i.test(contentType)) return;

            var lengthHeader = Number(response.headers.get("content-length") || 0);
            if (lengthHeader > 3 * 1024 * 1024) return;

            var clone = response.clone();
            clone.text().then(
              function (text) {
                var truncated = text.length > MAX_RES_BODY;
                report({
                  id: ++seq,
                  ts: nowIso(),
                  method: request.method,
                  url: request.url,
                  status: response.status,
                  contentType: contentType || null,
                  requestBody: request.body,
                  responseBody: truncated ? text.slice(0, MAX_RES_BODY) : text,
                  size: lengthHeader || null,
                  durationMs: Math.round(performance.now() - started),
                  error: null,
                  truncated: truncated,
                });
              },
              function () {}
            );
          } catch (_) {}
        })
        .catch(function (error) {
          if (!isInteresting(request.url, "")) return;
          report({
            id: ++seq,
            ts: nowIso(),
            method: request.method,
            url: request.url,
            status: null,
            contentType: null,
            requestBody: request.body,
            responseBody: null,
            size: null,
            durationMs: Math.round(performance.now() - started),
            error: String((error && error.message) || error),
            truncated: false,
          });
        });

      return promise;
    };
  }

  if (NativeXHR) {
    var WrappedXHR = function () {
      var xhr = new NativeXHR();
      var state = {
        method: "GET",
        url: "",
        body: null,
        capture: false,
        started: 0,
        contentType: null,
      };

      var originalOpen = xhr.open;
      var originalSend = xhr.send;
      var originalSetHeader = xhr.setRequestHeader;

      xhr.open = function (method, url) {
        state.method = String(method || "GET").toUpperCase();
        state.url = absoluteUrl(url);
        state.capture = isInteresting(state.url, null);
        return originalOpen.apply(xhr, arguments);
      };

      xhr.setRequestHeader = function (name, value) {
        if (String(name).toLowerCase() === "content-type") {
          state.contentType = String(value);
        }
        return originalSetHeader.apply(xhr, arguments);
      };

      xhr.send = function (body) {
        state.started = performance.now();
        if (typeof body === "string") state.body = clip(body, MAX_REQ_BODY);

        if (state.capture) {
          xhr.addEventListener("loadend", function () {
            try {
              var contentType = xhr.getResponseHeader("content-type") || state.contentType || "";
              if (!isInteresting(state.url, contentType)) return;

              var responseBody = null;
              var truncated = false;
              if (xhr.responseType === "" || xhr.responseType === "text") {
                var text = xhr.responseText || "";
                truncated = text.length > MAX_RES_BODY;
                responseBody = truncated ? text.slice(0, MAX_RES_BODY) : text;
              } else if (xhr.responseType === "json" && xhr.response) {
                var serialized = JSON.stringify(xhr.response);
                truncated = serialized.length > MAX_RES_BODY;
                responseBody = truncated ? serialized.slice(0, MAX_RES_BODY) : serialized;
              }

              report({
                id: ++seq,
                ts: nowIso(),
                method: state.method,
                url: state.url,
                status: xhr.status,
                contentType: contentType || null,
                requestBody: state.body,
                responseBody: responseBody,
                size: null,
                durationMs: Math.round(performance.now() - state.started),
                error: null,
                truncated: truncated,
              });
            } catch (_) {}
          });
        }

        return originalSend.apply(xhr, arguments);
      };

      return xhr;
    };
    WrappedXHR.prototype = NativeXHR.prototype;
    window.XMLHttpRequest = WrappedXHR;
  }

  /* ------------------------------------------------------------------
   * Login page bridge
   *
   * The desktop login screen does not open a separate window. Instead it
   * mirrors the QR code of the hidden TAPD login page:
   *
   *  - the tapd.cn frame activates the "企业微信登录" tab;
   *  - the login.work.weixin.qq.com iframe publishes the QR image, the
   *    scanned user and the expired state to the top frame;
   *  - after a scan, the WeCom panel offers "在企业微信桌面端打开" and
   *    "继续在浏览器中登录访问". We always pick the browser so the login
   *    finishes in the hidden webview instead of handing off to the app.
   *
   * Only UI state (QR URL, public avatar URL, name) crosses frames; the
   * session cookies never leave the webview.
   * ------------------------------------------------------------------ */

  var wecomHost = /(^|\.)work\.weixin\.qq\.com$/i.test(window.location.hostname);
  var tapdHost = isTapdHost(window.location.hostname);

  var loginBridge = {
    lastTabClick: 0,
    lastSwitch: 0,
    lastLinkClick: 0,
    lastRefresh: 0,
    qrShownAt: 0,
    sawQr: false,
    sawScan: false,
    badLoginAt: 0,
  };

  function compactText(node) {
    return String((node && node.textContent) || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isShown(node) {
    if (!node) return false;
    var rect = node.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    var style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function sizedAvatar(raw) {
    var url = absoluteAsset(raw);
    // WeCom avatar URLs end with a size segment (`/0` = original, ~1MB).
    return url.replace(/\/0(\?.*)?$/, "/132$1");
  }

  function absoluteAsset(raw) {
    try {
      var resolved = new URL(String(raw || ""), window.location.href).href;
      // The main window renders these images directly; avoid mixed content.
      return resolved.indexOf("http://") === 0
        ? "https://" + resolved.slice("http://".length)
        : resolved;
    } catch (_) {
      return "";
    }
  }

  function isAuthPath(raw) {
    var lower = String(raw || "").toLowerCase();
    return (
      lower.indexOf("/login") !== -1 ||
      lower.indexOf("/signin") !== -1 ||
      lower.indexOf("cloud_logins") !== -1 ||
      lower.indexOf("/register") !== -1
    );
  }

  function publishLogin(state) {
    state = state || {};
    state.at = Date.now();
    if (isTopFrame) {
      window.__TAPDCB_LOGIN__ = state;
      return;
    }
    try {
      window.top.postMessage({ __tapdcb: "login", state: state }, "*");
    } catch (_) {
      /* cross-origin top: ignore */
    }
  }

  var loadingLoginState = {
    phase: "loading",
    qrUrl: null,
    name: null,
    avatarUrl: null,
    corp: null,
    message: "正在准备登录页",
    host: "",
    at: 0,
  };

  function scanTopLoginPage() {
    if (!isTopFrame || !tapdHost) return;
    if (!isAuthPath(window.location.href)) return;
    var tab = document.querySelector(".login-tab-qy");
    if (!tab) {
      var form = document.querySelector("#login_cn_form, .login-form");
      if (!form) {
        // `/login` is TAPD's SPA shell; with a half-finished session it renders
        // "查找不到对应项目" instead of redirecting. Tell the UI to refresh,
        // which clears the stale cookie and opens the real login form.
        if (window.location.pathname === "/login") {
          if (!loginBridge.badLoginAt) loginBridge.badLoginAt = Date.now();
          if (Date.now() - loginBridge.badLoginAt > 2500) {
            publishLogin({
              phase: "error",
              qrUrl: null,
              name: null,
              avatarUrl: null,
              corp: null,
              message: "登录页状态异常，请刷新二维码",
              host: "tapd.cn",
            });
            return;
          }
        }

        // The WeCom/OAuth callback page is not the login form; a login is
        // already in flight and will land on the workspace shortly.
        publishLogin({
          phase: "loading",
          qrUrl: null,
          name: null,
          avatarUrl: null,
          corp: null,
          message: "正在完成登录",
          host: "tapd.cn",
        });
        return;
      }
      publishLogin({
        phase: "error",
        qrUrl: null,
        name: null,
        avatarUrl: null,
        corp: null,
        message: "当前登录页未提供企业微信扫码登录",
        host: "tapd.cn",
      });
      return;
    }

    loginBridge.badLoginAt = 0;

    var container = document.querySelector("#ww-login-container");
    var hasPanel = !!(container && container.children.length > 0);

    if (!hasPanel) {
      publishLogin({
        phase: "loading",
        qrUrl: null,
        name: null,
        avatarUrl: null,
        corp: null,
        message: "正在准备企业微信二维码",
        host: "tapd.cn",
      });
      if (Date.now() - loginBridge.lastTabClick > 1800) {
        loginBridge.lastTabClick = Date.now();
        try {
          tab.click();
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }

    var current = window.__TAPDCB_LOGIN__;
    var iframeFresh =
      current &&
      current.host === "work.weixin.qq.com" &&
      Date.now() - (current.at || 0) < 20000;

    if (!iframeFresh) {
      publishLogin({
        phase: "loading",
        qrUrl: null,
        name: null,
        avatarUrl: null,
        corp: null,
        message: "正在加载企业微信二维码",
        host: "tapd.cn",
      });
    }
  }

  function scanWecomPanel() {
    if (!wecomHost) return;
    // Only the frame that actually hosts the panel publishes state.
    if (!document.querySelector(".wwLogin_box, .wwLogin_qrcode, .wwLogin_quick_confirm")) {
      return;
    }

    var state = {
      phase: "loading",
      qrUrl: null,
      name: null,
      avatarUrl: null,
      corp: null,
      message: "正在等待二维码",
      host: "work.weixin.qq.com",
    };

    try {
      var qrImg = document.querySelector(".wwLogin_qrcode_img");
      if (isShown(qrImg)) {
        if (!loginBridge.sawQr) loginBridge.qrShownAt = Date.now();
        loginBridge.sawQr = true;
        state.qrUrl = absoluteAsset(qrImg.currentSrc || qrImg.src);
        var tip = compactText(document.querySelector(".wwLogin_qrcode_tips_cnt h4"));
        if (tip.indexOf("过期") !== -1) {
          state.phase = "expired";
          state.message = "二维码已过期";
        } else if (tip.indexOf("成功") !== -1 || tip.indexOf("确认") !== -1) {
          loginBridge.sawScan = true;
          state.phase = "scanned";
          state.message = tip || "扫码成功，请在手机上确认";
        } else {
          state.phase = "qr";
          state.message = null;
        }
      }

      var quick = document.querySelector(".wwLogin_quick_confirm");
      if (isShown(quick)) {
        var nameEl = quick.querySelector(".wwLogin_quick_name");
        var corpEl = nameEl ? nameEl.querySelector(".wwLogin_quick_name_orange") : null;
        var corp = corpEl ? compactText(corpEl).replace(/^@/, "") : "";
        var name = compactText(nameEl);
        if (corp) name = name.replace("@" + corp, "").trim();
        if (name.indexOf("@") !== -1) name = name.split("@")[0].trim();

        var avatarEl = quick.querySelector(".wwLogin_quick_userAvatar");
        state.name = name || null;
        state.corp = corp || null;
        state.avatarUrl = avatarEl ? sizedAvatar(avatarEl.src) : null;

        // The desktop quick-login panel can appear either before a scan (the
        // WeCom desktop account) or after one. Only the latter may continue:
        // a real scan leaves the "扫码成功" tip behind, and a QR that has been
        // on screen for a while means the user had time to scan.
        var canContinue =
          loginBridge.sawScan ||
          (loginBridge.sawQr && Date.now() - loginBridge.qrShownAt > 10000);

        if (!canContinue) {
          // WeCom desktop offered its own quick login before any scan. Force
          // the QR view so the only way in is scanning.
          state.phase = "loading";
          state.message = "正在加载二维码";
          state.qrUrl = null;
          loginBridge.sawQr = false;
          loginBridge.qrShownAt = 0;
          var switcher = quick.querySelector(".wwLogin_quick_switch");
          if (switcher && Date.now() - loginBridge.lastSwitch > 1600) {
            loginBridge.lastSwitch = Date.now();
            try {
              switcher.click();
            } catch (_) {
              /* ignore */
            }
          }
        } else {
          state.phase = "scanned";
          state.message = "已扫码，正在浏览器中完成登录";
          var browserLink = quick.querySelector("a.wwLogin_quick_open_wecom");
          if (
            browserLink &&
            /浏览器/.test(compactText(browserLink)) &&
            Date.now() - loginBridge.lastLinkClick > 3500
          ) {
            loginBridge.lastLinkClick = Date.now();
            // Never hand off to the installed WeCom desktop app.
            window.setTimeout(function () {
              try {
                browserLink.click();
              } catch (_) {
                /* ignore */
              }
            }, 800);
          }
        }
      }

      if (state.phase === "expired") {
        var refresh = document.querySelector(".wwLogin_qrcode_tips_cnt a");
        if (refresh && Date.now() - loginBridge.lastRefresh > 2500) {
          loginBridge.lastRefresh = Date.now();
          try {
            refresh.click();
          } catch (_) {
            /* ignore */
          }
        }
      }
    } catch (_) {
      /* transient DOM state while Vue re-renders: report loading next tick */
    }

    publishLogin(state);
  }

  function refreshLogin() {
    if (!isTopFrame || !tapdHost) return false;

    var container = document.querySelector("#ww-login-container");
    var frame = container ? container.querySelector("iframe") : null;
    if (frame && frame.contentWindow) {
      try {
        frame.contentWindow.postMessage({ __tapdcb: "cmd", cmd: "refreshQr" }, "*");
        return true;
      } catch (_) {
        /* fall through to a tab click */
      }
    }

    var tab = document.querySelector(".login-tab-qy");
    if (tab) {
      loginBridge.lastTabClick = 0;
      try {
        tab.click();
      } catch (_) {
        /* ignore */
      }
      return true;
    }
    return false;
  }

  if (isTopFrame) {
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (data && data.__tapdcb === "login" && data.state) {
        window.__TAPDCB_LOGIN__ = data.state;
      }
    });
    window.setInterval(scanTopLoginPage, 700);
  }

  if (wecomHost) {
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || data.__tapdcb !== "cmd" || data.cmd !== "refreshQr") return;
      var refresh = document.querySelector(".wwLogin_qrcode_tips_cnt a");
      if (refresh) {
        try {
          refresh.click();
          return;
        } catch (_) {
          /* ignore */
        }
      }
      var switcher = document.querySelector(".wwLogin_quick_switch");
      if (switcher) {
        try {
          switcher.click();
          return;
        } catch (_) {
          /* ignore */
        }
      }
      try {
        window.location.reload();
      } catch (_) {
        /* ignore */
      }
    });
    window.setInterval(scanWecomPanel, 600);
  }

  var api = {
    version: 1,

    ping: function () {
      var internals = window.__TAURI_INTERNALS__;
      return {
        url: window.location.href,
        title: document.title || "",
        readyState: document.readyState || "",
        hasInvoke: !!(internals && typeof internals.invoke === "function"),
        hasCapture: true,
        captureCount: entries.length,
        cookieLength: (document.cookie || "").length,
        userAgent: navigator.userAgent || "",
      };
    },

    snapshot: function () {
      return entries.slice();
    },

    clear: function () {
      entries = [];
      totalBytes = 0;
      seq = 0;
      return true;
    },

    loginState: function () {
      var state = window.__TAPDCB_LOGIN__ || loadingLoginState;
      return {
        phase: state.phase || "loading",
        qrUrl: state.qrUrl || null,
        name: state.name || null,
        avatarUrl: state.avatarUrl || null,
        corp: state.corp || null,
        message: state.message || null,
      };
    },

    refreshLogin: function () {
      return refreshLogin();
    },

    request: async function (options) {
      var opts = options || {};
      var method = String(opts.method || "GET").toUpperCase();
      var url = absoluteUrl(opts.url || "");
      var headers = Object.assign({}, opts.headers || {});
      var started = performance.now();

      if (!nativeFetch) {
        return {
          ok: false,
          status: 0,
          url: url,
          contentType: null,
          body: "",
          error: "fetch is unavailable in this frame",
        };
      }

      internalDepth++;
      try {
        var init = { method: method, credentials: "include", headers: headers };
        if (opts.body != null) {
          init.body = opts.body;
          var hasContentType = Object.keys(headers).some(function (key) {
            return key.toLowerCase() === "content-type";
          });
          if (!hasContentType) init.headers["Content-Type"] = "application/json";
        }

        var response = await nativeFetch(url, init);
        var text = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          url: response.url || url,
          contentType: response.headers.get("content-type"),
          body: clip(text, MAX_RPC_BODY) || "",
          error: null,
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          url: url,
          contentType: null,
          body: "",
          error: String((error && error.message) || error),
        };
      } finally {
        internalDepth--;
        void started;
      }
    },
  };

  try {
    Object.defineProperty(window, "__TAPDCB__", {
      value: api,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch (_) {
    window.__TAPDCB__ = api;
  }
})();
