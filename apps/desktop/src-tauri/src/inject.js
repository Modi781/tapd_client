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
