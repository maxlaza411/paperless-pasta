// Cloudflare Worker: robust proxy/injector for third-party pages
// Fixed: CSS MIME detection, binary handling, Next.js compatibility

const DEFAULT_XPATH =
  "/html/body/div[1]/div[2]/div/div/div/section/div/div[1]/div/div/section[2]/div/div/div/div/div/div[1]/div/div[3]/span/p/span/span[2]/span";

// ===== Early injected shim (runs BEFORE any site JS) =====
const HISTORY_NET_SHIM = String.raw`
(function(){
  try{
    var WORKER_ORIGIN = window.__PROXY_ORIGIN__ || location.origin;
    var WORKER_PATH = window.__PROXY_PATHNAME__ || location.pathname;
    var TARGET = (function(){ try { return new URL(window.__PROXY_TARGET__); } catch(_) { return null; } })();

    function toWorker(u){
      if (u == null || u === "") return u;
      var s = String(u);
      
      // Don't rewrite if already through worker
      if (s.indexOf(WORKER_ORIGIN) === 0 || s.indexOf(WORKER_PATH + "?u=") === 0) return u;
      
      try{
        // Resolve URL against target origin
        var base = TARGET ? TARGET.href : (window.location.protocol + "//" + window.location.host + "/");
        var abs = new URL(s, base);
        
        // Build new query params
        var params = new URLSearchParams(location.search);
        params.set("u", abs.href);
        
        // CRITICAL: Return full worker URL, not relative
        return WORKER_ORIGIN + WORKER_PATH + "?" + params.toString();
      }catch(e){ 
        console.warn("[shim] URL conversion failed:", s, e.message); 
        return u; 
      }
    }

    // More aggressive history patching - wrap the native methods before site loads
    var _pushState = history.pushState;
    var _replaceState = history.replaceState;
    
    Object.defineProperty(history, 'pushState', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function(state, title, url) {
        try {
          if (url !== undefined && url !== null) {
            var urlStr = String(url);
            // For history API, we need relative paths to avoid cross-origin errors
            if (urlStr.indexOf(WORKER_ORIGIN) === 0) {
              // Already a worker URL, make it relative
              var workerUrl = new URL(urlStr);
              var relativePath = workerUrl.pathname + workerUrl.search + workerUrl.hash;
              console.log("[shim] pushState (rel):", urlStr, "→", relativePath);
              return _pushState.call(this, state, title, relativePath);
            } else if (urlStr.indexOf("http") === 0) {
              // Full URL that needs proxying
              var newUrl = toWorker(urlStr);
              var workerUrl = new URL(newUrl);
              var relativePath = workerUrl.pathname + workerUrl.search + workerUrl.hash;
              console.log("[shim] pushState:", urlStr, "→", relativePath);
              return _pushState.call(this, state, title, relativePath);
            }
          }
          return _pushState.call(this, state, title, url);
        } catch(e) {
          console.warn("[shim] pushState error:", e.message);
          return _pushState.call(this, state, title);
        }
      }
    });

    Object.defineProperty(history, 'replaceState', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: function(state, title, url) {
        try {
          if (url !== undefined && url !== null) {
            var urlStr = String(url);
            // For history API, we need relative paths to avoid cross-origin errors
            if (urlStr.indexOf(WORKER_ORIGIN) === 0) {
              // Already a worker URL, make it relative
              var workerUrl = new URL(urlStr);
              var relativePath = workerUrl.pathname + workerUrl.search + workerUrl.hash;
              console.log("[shim] replaceState (rel):", urlStr, "→", relativePath);
              return _replaceState.call(this, state, title, relativePath);
            } else if (urlStr.indexOf("http") === 0) {
              // Full URL that needs proxying
              var newUrl = toWorker(urlStr);
              var workerUrl = new URL(newUrl);
              var relativePath = workerUrl.pathname + workerUrl.search + workerUrl.hash;
              console.log("[shim] replaceState:", urlStr, "→", relativePath);
              return _replaceState.call(this, state, title, relativePath);
            }
          }
          return _replaceState.call(this, state, title, url);
        } catch(e) {
          console.warn("[shim] replaceState error:", e.message);
          // Silently fail to prevent breaking the site
          return;
        }
      }
    });

    // Location methods
    try{ 
      var _assign = location.assign.bind(location);  
      location.assign = function(u){
        try { 
          var newUrl = toWorker(String(u));
          console.log("[shim] assign:", u, "→", newUrl);
          return _assign(newUrl); 
        } catch(e) { 
          console.warn("[shim] assign failed:", e.message); 
        }
      };
    }catch(_){}
    
    try{ 
      var _replace = location.replace.bind(location); 
      location.replace = function(u){
        try { 
          var newUrl = toWorker(String(u));
          console.log("[shim] replace:", u, "→", newUrl);
          return _replace(newUrl); 
        } catch(e) { 
          console.warn("[shim] replace failed:", e.message); 
        }
      };
    }catch(_){}
    
    try{ 
      var _open = window.open.bind(window);
      window.open = function(u, n, f){
        try { 
          var newUrl = toWorker(String(u));
          console.log("[shim] open:", u, "→", newUrl);
          return _open(newUrl, n, f); 
        } catch(e) { 
          console.warn("[shim] open failed:", e.message); 
          return null; 
        }
      };
    }catch(_){}

    // Fetch patching - only rewrite if not already a worker URL
    try{ 
      var _fetch = fetch.bind(window);
      window.fetch = function(input, init){
        try {
          var url = (typeof input === "string") ? input : (input && input.url ? input.url : String(input));
          // Skip if already through worker
          if (url.indexOf(WORKER_ORIGIN) === 0) return _fetch(input, init);
          
          var u2 = toWorker(url);
          console.log("[shim] fetch:", url, "→", u2);
          return (input instanceof Request) ? _fetch(new Request(u2, input), init) : _fetch(u2, init);
        } catch(e) {
          console.warn("[shim] fetch failed:", e.message);
          return _fetch(input, init);
        }
      };
    }catch(_){}
    
    // XHR patching
    try{ 
      var _xhrOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, async, user, pass){ 
        try {
          var urlStr = String(url);
          // Skip if already through worker
          if (urlStr.indexOf(WORKER_ORIGIN) === 0) {
            return _xhrOpen.call(this, method, url, async !== false, user, pass);
          }
          
          var u2 = toWorker(urlStr);
          console.log("[shim] XHR:", urlStr, "→", u2);
          return _xhrOpen.call(this, method, u2, async !== false, user, pass);
        } catch(e) {
          console.warn("[shim] XHR open failed:", e.message);
          return _xhrOpen.call(this, method, url, async !== false, user, pass);
        }
      };
    }catch(_){}

    // ===== CANVAS SUPPORT =====
    // Patch Image constructor and src setter
    try {
      var _ImageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (_ImageSrc && _ImageSrc.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
          get: _ImageSrc.get,
          set: function(url) {
            try {
              var urlStr = String(url);
              if (urlStr && !urlStr.startsWith('data:') && !urlStr.startsWith('blob:')) {
                // Skip if already through worker
                if (urlStr.indexOf(WORKER_ORIGIN) === 0) {
                  return _ImageSrc.set.call(this, url);
                }
                var rewritten = toWorker(urlStr);
                console.log("[shim] Image.src:", urlStr, "→", rewritten);
                return _ImageSrc.set.call(this, rewritten);
              }
            } catch(e) {
              console.warn("[shim] Image.src failed:", e.message);
            }
            return _ImageSrc.set.call(this, url);
          },
          configurable: true,
          enumerable: true
        });
      }
    } catch(e) {
      console.warn("[shim] Image.src patch failed:", e.message);
    }

    // Patch canvas context drawImage to handle Image objects
    try {
      var _drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(image) {
        try {
          // If the image hasn't loaded yet and has a src, ensure it's proxied
          if (image instanceof HTMLImageElement && image.src && !image.complete) {
            var src = image.src;
            if (src && !src.startsWith('data:') && !src.startsWith('blob:') && src.indexOf(WORKER_ORIGIN) === -1) {
              console.log("[shim] drawImage - lazy rewrite:", src);
              image.src = toWorker(src);
            }
          }
        } catch(e) {
          console.warn("[shim] drawImage pre-check failed:", e.message);
        }
        return _drawImage.apply(this, arguments);
      };
    } catch(e) {
      console.warn("[shim] drawImage patch failed:", e.message);
    }

    // Patch createImageBitmap
    try {
      if (window.createImageBitmap) {
        var _createImageBitmap = window.createImageBitmap.bind(window);
        window.createImageBitmap = function(image) {
          try {
            if (typeof image === 'string') {
              var rewritten = toWorker(image);
              console.log("[shim] createImageBitmap:", image, "→", rewritten);
              return _createImageBitmap(rewritten);
            }
          } catch(e) {
            console.warn("[shim] createImageBitmap failed:", e.message);
          }
          return _createImageBitmap.apply(window, arguments);
        };
      }
    } catch(e) {
      console.warn("[shim] createImageBitmap patch failed:", e.message);
    }

    // Patch WebGL texture loading
    try {
      if (window.WebGLRenderingContext) {
        var _texImage2D = WebGLRenderingContext.prototype.texImage2D;
        WebGLRenderingContext.prototype.texImage2D = function() {
          try {
            // If loading from URL (rare but possible)
            if (arguments.length > 0 && typeof arguments[arguments.length - 1] === 'string') {
              var url = arguments[arguments.length - 1];
              if (!url.startsWith('data:') && !url.startsWith('blob:')) {
                arguments[arguments.length - 1] = toWorker(url);
                console.log("[shim] WebGL texImage2D:", url);
              }
            }
          } catch(e) { console.warn("[shim] texImage2D failed:", e.message); }
          return _texImage2D.apply(this, arguments);
        };
      }

      if (window.WebGL2RenderingContext) {
        var _texImage2D2 = WebGL2RenderingContext.prototype.texImage2D;
        WebGL2RenderingContext.prototype.texImage2D = function() {
          try {
            if (arguments.length > 0 && typeof arguments[arguments.length - 1] === 'string') {
              var url = arguments[arguments.length - 1];
              if (!url.startsWith('data:') && !url.startsWith('blob:')) {
                arguments[arguments.length - 1] = toWorker(url);
                console.log("[shim] WebGL2 texImage2D:", url);
              }
            }
          } catch(e) { console.warn("[shim] texImage2D2 failed:", e.message); }
          return _texImage2D2.apply(this, arguments);
        };
      }
    } catch(e) {
      console.warn("[shim] WebGL texture patch failed:", e.message);
    }

    // Patch Image constructor for 'new Image()' calls
    try {
      var _Image = window.Image;
      window.Image = function(width, height) {
        var img = new _Image(width, height);
        var _imgSetSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (_imgSetSrc && _imgSetSrc.set) {
          Object.defineProperty(img, '_proxySrc', {
            set: function(url) {
              try {
                var urlStr = String(url);
                if (urlStr && !urlStr.startsWith('data:') && !urlStr.startsWith('blob:') && urlStr.indexOf(WORKER_ORIGIN) === -1) {
                  var rewritten = toWorker(urlStr);
                  console.log("[shim] new Image().src:", urlStr, "→", rewritten);
                  _imgSetSrc.set.call(this, rewritten);
                  return;
                }
              } catch(e) { console.warn("[shim] Image constructor src failed:", e.message); }
              _imgSetSrc.set.call(this, url);
            },
            get: function() {
              return _imgSetSrc.get.call(this);
            }
          });
        }
        return img;
      };
      window.Image.prototype = _Image.prototype;
    } catch(e) {
      console.warn("[shim] Image constructor patch failed:", e.message);
    }

    // Patch canvas.toDataURL and toBlob for CORS support
    try {
      var _toDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function() {
        try {
          return _toDataURL.apply(this, arguments);
        } catch(e) {
          console.warn("[shim] toDataURL CORS issue:", e.message);
          // Return empty canvas on CORS failure
          var fallback = document.createElement('canvas');
          fallback.width = this.width;
          fallback.height = this.height;
          return fallback.toDataURL.apply(fallback, arguments);
        }
      };
    } catch(e) {
      console.warn("[shim] toDataURL patch failed:", e.message);
    }

    // Patch video/audio src for canvas drawImage support
    try {
      var _VideoSrc = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'src');
      if (_VideoSrc && _VideoSrc.set) {
        Object.defineProperty(HTMLVideoElement.prototype, 'src', {
          get: _VideoSrc.get,
          set: function(url) {
            try {
              var urlStr = String(url);
              if (urlStr && !urlStr.startsWith('data:') && !urlStr.startsWith('blob:') && urlStr.indexOf(WORKER_ORIGIN) === -1) {
                var rewritten = toWorker(urlStr);
                console.log("[shim] Video.src:", urlStr, "→", rewritten);
                return _VideoSrc.set.call(this, rewritten);
              }
            } catch(e) { console.warn("[shim] Video.src failed:", e.message); }
            return _VideoSrc.set.call(this, url);
          },
          configurable: true,
          enumerable: true
        });
      }
    } catch(e) { console.warn("[shim] Video.src patch failed:", e.message); }

    // Patch background image setting via JavaScript
    try {
      var _setProperty = CSSStyleDeclaration.prototype.setProperty;
      CSSStyleDeclaration.prototype.setProperty = function(prop, value, priority) {
        try {
          if (prop === 'background-image' || prop === 'background') {
            var urlMatch = /url\(['"]?([^'")]+)['"]?\)/g;
            var newValue = String(value).replace(urlMatch, function(match, url) {
              if (!url.startsWith('data:') && !url.startsWith('blob:') && url.indexOf(WORKER_ORIGIN) === -1) {
                var rewritten = toWorker(url);
                console.log("[shim] CSS bg-image:", url, "→", rewritten);
                return 'url("' + rewritten + '")';
              }
              return match;
            });
            return _setProperty.call(this, prop, newValue, priority);
          }
        } catch(e) { console.warn("[shim] setProperty failed:", e.message); }
        return _setProperty.call(this, prop, value, priority);
      };
    } catch(e) { console.warn("[shim] setProperty patch failed:", e.message); }

    // Watch for dynamically created images and canvases
    try {
      var observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
          mutation.addedNodes.forEach(function(node) {
            if (node.nodeType === 1) { // Element node
              // Check if it's an image
              if (node.tagName === 'IMG' && node.src && !node.src.startsWith('data:') && !node.src.startsWith('blob:')) {
                if (node.src.indexOf(WORKER_ORIGIN) === -1) {
                  console.log("[shim] Rewriting dynamically added image:", node.src);
                  node.src = toWorker(node.src);
                }
                // Ensure crossorigin for canvas usage
                if (!node.hasAttribute('crossorigin')) {
                  node.setAttribute('crossorigin', 'anonymous');
                }
              }
              // Check for images within the added node
              if (node.querySelectorAll) {
                var imgs = node.querySelectorAll('img[src]');
                imgs.forEach(function(img) {
                  if (img.src && !img.src.startsWith('data:') && !img.src.startsWith('blob:') && img.src.indexOf(WORKER_ORIGIN) === -1) {
                    console.log("[shim] Rewriting nested image:", img.src);
                    img.src = toWorker(img.src);
                    if (!img.hasAttribute('crossorigin')) {
                      img.setAttribute('crossorigin', 'anonymous');
                    }
                  }
                });
              }
            }
          });
        });
      });
      
      // Start observing after DOM is ready
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        document.addEventListener('DOMContentLoaded', function() {
          observer.observe(document.body, { childList: true, subtree: true });
        });
      }
      console.log("[shim] DOM observer installed");
    } catch(e) {
      console.warn("[shim] DOM observer failed:", e.message);
    }

    // Intercept CSS.supports for animation detection
    try {
      if (window.CSS && window.CSS.supports) {
        var _cssSupports = window.CSS.supports.bind(window.CSS);
        window.CSS.supports = function() {
          var result = _cssSupports.apply(window.CSS, arguments);
          return result;
        };
      }
    } catch(e) {}

    window.__OVERLAY_HISTORY_PATCHED__ = true;
    window.__CANVAS_PATCHED__ = true;
    console.log("[shim] ✓ History, network, canvas, media APIs, and DOM observer patched");
  }catch(e){ 
    console.error("[shim] Initialization failed:", e.message, e.stack); 
  }
})();`;

// ===== Overlay (served at /overlay.js) =====
const OVERLAY_JS = String.raw`
(() => {
  const P = (window.__INJECT_PARAMS__ || (() => {
    const sp = new URLSearchParams(location.search);
    const o = {};
    for (const [k, v] of sp) o[k] = v;
    return o;
  })());
  const NEW   = (P.name || P.n || "").trim();
  const XPATH = P.xp || "${DEFAULT_XPATH}";
  const SEL   = P.sel || "";
  const OLD   = (P.old || "").trim();
  const WHOLE = String(P.ww || "0") === "1";
  const DELAY = Math.max(0,  parseInt(P.delay || "300", 10));
  const TRIES = Math.max(1,  parseInt(P.tries || "900", 10));
  const INTER = Math.max(50, parseInt(P.interval || "100", 10));
  const SNAP  = String(P.snapshot || "0") === "1";
  const SVGOK = String(P.svg || "1") === "1";
  
  console.log("[overlay] Params:", {NEW, DELAY, TRIES});
  if (!NEW) { console.warn("[overlay] No name parameter"); return; }

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => s.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
  const reFrom = (s, whole) => new RegExp(whole ? "\\b" + esc(s) + "\\b" : esc(s), "g");

  function badge(msg, ms = 1600) {
    try {
      const b = document.createElement("div");
      b.textContent = msg;
      Object.assign(b.style, {
        position: "fixed", top: "0", left: "0", right: "0",
        padding: "6px 10px", background: "rgba(0,0,0,.75)", color: "#fff",
        font: "12px system-ui", zIndex: 2147483647, textAlign: "center"
      });
      document.documentElement.appendChild(b);
      setTimeout(() => b.remove(), ms);
    } catch(e) { console.warn("[overlay] Badge failed:", e.message); }
  }

  function find() {
    if (SEL) { 
      const el = document.querySelector(SEL); 
      if (el) { console.log("[overlay] Found via selector:", SEL); return el; }
    }
    try {
      const r = document.evaluate(XPATH, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (r.singleNodeValue) console.log("[overlay] Found via XPath");
      return r.singleNodeValue || null;
    } catch(e) { console.warn("[overlay] XPath failed:", e.message); return null; }
  }

  function replaceTextNodes(root, from, to, whole = false) {
    let n = 0, re = reFrom(from, whole);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue || "";
        if (!v.trim()) return NodeFilter.FILTER_REJECT;
        const p = (node.parentNode && node.parentNode.nodeName || "").toLowerCase();
        if (["script", "style", "noscript", "textarea", "input"].includes(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const t of nodes) {
      const nv = t.nodeValue.replace(re, to);
      if (nv !== t.nodeValue) { t.nodeValue = nv; n++; }
    }
    return n;
  }

  function replaceSVG(from, to, whole = false) {
    if (!SVGOK) return 0;
    let n = 0, re = reFrom(from, whole);
    document.querySelectorAll("svg text, svg tspan").forEach(t => {
      const v = t.textContent || "";
      const nv = v.replace(re, to);
      if (nv !== v) { t.textContent = nv; n++; }
    });
    return n;
  }

  async function freeze() {
    try { window.stop && window.stop(); } catch {}
    document.querySelectorAll("script").forEach(s => s.remove());
  }

  (async () => {
    try {
      await new Promise(res => {
        if (document.readyState === 'complete') res();
        else window.addEventListener("load", res, { once: true });
      });
      
      console.log("[overlay] Page loaded");
      if (DELAY) { console.log("[overlay] Waiting", DELAY, "ms"); await wait(DELAY); }

      if (OLD) {
        console.log("[overlay] Global replace:", OLD, "→", NEW);
        const n1 = replaceTextNodes(document.body, OLD, NEW, WHOLE);
        const n2 = replaceSVG(OLD, NEW, WHOLE);
        if (n1 + n2 > 0) {
          badge("Replaced " + (n1 + n2) + " node(s)");
          console.log("[overlay] ✓ Replaced", n1 + n2, "nodes");
          if (SNAP) { await wait(50); await freeze(); }
          return;
        }
        console.warn("[overlay] No matches found");
      }

      let el = null;
      console.log("[overlay] Searching, tries:", TRIES);
      for (let i = 0; i < TRIES; i++) {
        el = find();
        if (el) break;
        if (i % 20 === 0 && i > 0) console.log("[overlay] Try", i, "/", TRIES);
        await wait(INTER);
      }
      
      if (!el) { 
        badge("Target not found");
        console.error("[overlay] ✗ Not found after", TRIES, "tries");
        return; 
      }

      console.log("[overlay] Found! Current:", el.textContent);
      if (el.textContent !== NEW) {
        el.textContent = NEW;
        console.log("[overlay] ✓ Replaced");
      }

      if (SNAP) {
        await wait(40);
        await freeze();
        badge("Overlay (frozen)");
        return;
      }

      const applySticky = () => { 
        const n = find(); 
        if (n && n.textContent !== NEW) {
          console.log("[overlay] Re-applying");
          n.textContent = NEW;
        }
      };
      new MutationObserver(m => { 
        if (m.some(x => x.addedNodes && x.addedNodes.length)) applySticky(); 
      }).observe(document.documentElement, { childList: true, subtree: true });

      badge("Name → " + NEW);
      console.log("[overlay] ✓ Complete");
    } catch(e) {
      console.error("[overlay] Error:", e.message, e.stack);
    }
  })();
})();
`;

// ===== Helpers =====
function parseCookies(h){ 
  const out = {}; 
  if (!h) return out;
  for (const part of h.split(/; */)) { 
    const i = part.indexOf("="); 
    if (i === -1) continue;
    try {
      out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1)); 
    } catch(e) {}
  }
  return out;
}

function buildSearchWithU(originalSearch, absHref) {
  const keep = new URLSearchParams();
  const orig = new URLSearchParams(originalSearch);
  // Preserve important params
  for (const key of ['name', 'n', 'persist', 'forceHTML', 'delay', 'tries', 'interval', 'xp', 'sel', 'old', 'ww', 'snapshot', 'svg']) {
    if (orig.has(key)) keep.set(key, orig.get(key));
  }
  keep.set('u', absHref);
  return keep.toString();
}

// CRITICAL: Fix MIME type detection
function isLikelyHTML(req, upstream, here) {
  const targetURL = here.searchParams.get("u");
  
  // Check URL pattern first - most reliable
  if (targetURL) {
    const urlLower = targetURL.toLowerCase();
    // Explicit non-HTML file types by extension
    if (urlLower.match(/\.(css|js|json|xml|txt|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|ico|pdf|zip|mp4|mp3|webm|ogg)(\?|$)/i)) {
      return false;
    }
    // CSS files often don't have .css extension (Google Fonts)
    if (urlLower.includes('fonts.googleapis.com/css') || 
        urlLower.includes('/css?') ||
        urlLower.includes('font') && (urlLower.includes('woff') || urlLower.includes('ttf'))) {
      return false;
    }
  }
  
  // Check content-type from response
  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  
  // Explicit non-HTML types - MUST passthrough as-is
  if (ct.includes("text/css") || 
      ct.includes("application/javascript") || 
      ct.includes("text/javascript") ||
      ct.includes("application/json") ||
      ct.includes("font/") || 
      ct.includes("application/font") ||
      ct.includes("image/") || 
      ct.includes("video/") || 
      ct.includes("audio/") ||
      ct.includes("application/pdf") ||
      ct.includes("application/zip") ||
      ct.includes("application/octet-stream") ||
      ct.includes("text/plain") ||
      ct.includes("application/xml") ||
      ct.includes("text/xml")) {
    return false;
  }
  
  // Explicit HTML types
  if (ct.includes("text/html") || ct.includes("application/xhtml")) {
    return true;
  }
  
  // Force HTML only for top-level document requests with forceHTML=1
  const force = here.searchParams.get("forceHTML") === "1" && isTopLevelDocument(req);
  if (force) return true;
  
  // Check Accept header only if content-type is ambiguous
  const accept = (req.headers.get("accept") || "").toLowerCase();
  return accept.includes("text/html") && isTopLevelDocument(req);
}

function isTopLevelDocument(req) {
  return (req.headers.get('sec-fetch-dest') || '') === 'document';
}

function isSkippableUrl(u){ 
  return !u || u.startsWith("data:") || u.startsWith("blob:") || 
         u.startsWith("about:") || u.startsWith("javascript:") || 
         u.startsWith("#"); 
}

// CSS url(...) rewriting
function rewriteCssUrls(text, cssBaseHref, workerOriginPath, originalSearch){
  return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, p) => {
    if (isSkippableUrl(p)) return m;
    let abs;
    try { abs = new URL(p, cssBaseHref).href; } catch { return m; }
    const qstr = buildSearchWithU(originalSearch, abs);
    return `url(${q}${workerOriginPath}?${qstr}${q})`;
  });
}

// ----- HTML Rewriter handlers -----
class RemoveMetaCSP { 
  element(e){ 
    const hv = (e.getAttribute("http-equiv") || "").toLowerCase();
    if (hv === "content-security-policy" || hv === "content-security-policy-report-only") {
      e.remove();
    }
  }
}

class StripBase { element(e){ e.remove(); } }

// Inject base + shim + overlay
class InjectHead {
  constructor(targetHref, overlaySrc, paramsBlob, origin, path){
    this.t = targetHref; 
    this.oSrc = overlaySrc; 
    this.params = paramsBlob; 
    this.origin = origin; 
    this.path = path;
  }
  element(e){
    // CRITICAL: Inject shim FIRST before base tag, so it runs before ANY other script
    e.prepend(`<script>
(function(){
  // Emergency early patch - runs before EVERYTHING
  window.__SHIM_ERRORS__ = [];
  window.__SHIM_LOGS__ = [];
  console.log("[early-shim] Installing emergency patches");
  
  // Store original console for debugging
  var _log = console.log.bind(console);
  var _warn = console.warn.bind(console);
  var _error = console.error.bind(console);
  
  // Log critical errors
  window.addEventListener('error', function(e) {
    window.__SHIM_ERRORS__.push({
      msg: e.message,
      src: e.filename,
      line: e.lineno,
      col: e.colno
    });
    _error("[error]", e.message, "at", e.filename + ":" + e.lineno);
  });
  
  // Catch unhandled promise rejections
  window.addEventListener('unhandledrejection', function(e) {
    window.__SHIM_ERRORS__.push({
      type: 'promise',
      reason: e.reason
    });
    _error("[promise rejection]", e.reason);
  });
})();
</script>`, { html: true });

    // Inject base tag
    e.prepend(`<base href="${this.t}">`, { html: true });
    
    // Inject config
    e.prepend(`<script>
      window.__INJECT_PARAMS__ = ${JSON.stringify(this.params)};
      window.__PROXY_ORIGIN__ = ${JSON.stringify(this.origin)};
      window.__PROXY_TARGET__ = ${JSON.stringify(this.t)};
      window.__PROXY_PATHNAME__ = ${JSON.stringify(this.path)};
    </script>`, { html: true });
    
    // Inject main shim
    e.prepend(`<script>${HISTORY_NET_SHIM}</script>`, { html: true });
    
    // Add debugging helper
    e.append(`<script>
(function(){
  // Helper to debug what's loaded
  window.__checkProxyStatus__ = function() {
    console.log("=== PROXY STATUS ===");
    console.log("History patched:", !!window.__OVERLAY_HISTORY_PATCHED__);
    console.log("Canvas patched:", !!window.__CANVAS_PATCHED__);
    console.log("Errors:", window.__SHIM_ERRORS__);
    console.log("Images on page:", document.querySelectorAll('img').length);
    console.log("Canvases on page:", document.querySelectorAll('canvas').length);
    
    var imgs = Array.from(document.querySelectorAll('img'));
    console.log("Image sources:", imgs.map(i => i.src.substring(0, 100)));
    
    var canvases = Array.from(document.querySelectorAll('canvas'));
    console.log("Canvas dimensions:", canvases.map(c => c.width + 'x' + c.height));
  };
  
  console.log("[debug] Type '__checkProxyStatus__()' to see proxy status");
})();
</script>`, { html: true });
    
    // Inject overlay last
    e.append(`<script defer src="${this.oSrc}"></script>`, { html: true });
  }
}

// Rewrite href/src to worker
class RewriteAttrToWorker {
  constructor(workerOriginPath, originalSearch, baseHref){
    this.w = workerOriginPath; 
    this.q = originalSearch; 
    this.b = baseHref;
  }
  _toWorker(abs) { return `${this.w}?${buildSearchWithU(this.q, abs)}`; }
  _abs(u){ try { return new URL(u, this.b).href; } catch { return null; } }
  
  element(e){
    // Handle standard src/href attributes
    for (const name of ["href", "src", "poster", "data-src", "data-background", "data-image"]) {
      const val = e.getAttribute(name);
      if (!val || isSkippableUrl(val)) continue;
      const abs = this._abs(val); 
      if (!abs) continue;
      e.setAttribute(name, this._toWorker(abs));
    }
    
    // srcset
    const ss = e.getAttribute("srcset");
    if (ss){
      const items = ss.split(",").map(s => s.trim()).filter(Boolean).map(item => {
        const m = item.match(/^(\S+)(\s+\d+[wx])?$/);
        if (!m) return item;
        const url = m[1], d = m[2] || "";
        if (isSkippableUrl(url)) return item;
        const abs = this._abs(url); 
        if (!abs) return item;
        return `${this._toWorker(abs)}${d}`;
      });
      e.setAttribute("srcset", items.join(", "));
    }
    
    // Handle data-srcset for lazy loading
    const dss = e.getAttribute("data-srcset");
    if (dss){
      const items = dss.split(",").map(s => s.trim()).filter(Boolean).map(item => {
        const m = item.match(/^(\S+)(\s+\d+[wx])?$/);
        if (!m) return item;
        const url = m[1], d = m[2] || "";
        if (isSkippableUrl(url)) return item;
        const abs = this._abs(url); 
        if (!abs) return item;
        return `${this._toWorker(abs)}${d}`;
      });
      e.setAttribute("data-srcset", items.join(", "));
    }
    
    // Remove integrity checks and add crossorigin for canvas compatibility
    const tag = e.tagName.toLowerCase();
    if ((tag === "link" || tag === "script") && e.hasAttribute("integrity")) {
      e.removeAttribute("integrity");
    }
    
    // Set crossorigin="anonymous" for images to enable canvas usage
    if (tag === "img" && !e.hasAttribute("crossorigin")) {
      e.setAttribute("crossorigin", "anonymous");
    }
    
    // Set crossorigin for video/audio for canvas usage
    if ((tag === "video" || tag === "audio") && !e.hasAttribute("crossorigin")) {
      e.setAttribute("crossorigin", "anonymous");
    }
    
    // Remove restrictive crossorigin on scripts/links
    if ((tag === "link" || tag === "script") && e.hasAttribute("crossorigin")) {
      e.removeAttribute("crossorigin");
    }

    // inline style attribute url(...)
    const style = e.getAttribute("style");
    if (style) {
      const rewritten = rewriteCssUrls(style, this.b, this.w, this.q);
      if (rewritten !== style) e.setAttribute("style", rewritten);
    }
  }
}

// Rewrite inline <style> content
class RewriteStyleTag {
  constructor(workerOriginPath, originalSearch, baseHref){ 
    this.w = workerOriginPath; 
    this.q = originalSearch; 
    this.b = baseHref; 
  }
  text(t){ 
    const out = rewriteCssUrls(t.text, this.b, this.w, this.q); 
    if (out !== t.text) t.replace(out); 
  }
}

// ===== core worker =====
function passthrough(upstream, allowCORS = true){
  const h = new Headers(upstream.headers);
  h.delete("content-security-policy"); 
  h.delete("content-security-policy-report-only"); 
  h.delete("x-frame-options");
  
  if (allowCORS) {
    h.set("access-control-allow-origin", "*");
    h.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    h.set("access-control-allow-headers", "*");
    h.set("access-control-allow-credentials", "true");
    
    // Critical for canvas: allow images to be used in canvas
    const ct = (h.get("content-type") || "").toLowerCase();
    if (ct.includes("image/")) {
      h.set("cross-origin-resource-policy", "cross-origin");
      h.set("timing-allow-origin", "*");
    }
  }
  
  return new Response(upstream.body, { 
    status: upstream.status, 
    statusText: upstream.statusText,
    headers: h 
  });
}

function resolveTarget(here, cookieOrigin){
  const u = here.searchParams.get("u");
  if (u) {
    try {
      return new URL(u);
    } catch(e) {
      console.error("Invalid target URL:", u);
      return null;
    }
  }
  if (cookieOrigin) {
    try {
      return new URL(here.pathname + here.search, cookieOrigin);
    } catch(e) {
      return null;
    }
  }
  return null;
}

export default {
  async fetch(req){
    try {
      const here = new URL(req.url);
      
      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": "*",
            "access-control-max-age": "86400",
          }
        });
      }
      
      const cookies = parseCookies(req.headers.get("cookie") || "");
      const cookieOrigin = cookies.__pt || null;

      // Serve overlay
      if (here.pathname === "/overlay.js") {
        return new Response(OVERLAY_JS, { 
          headers: { 
            "content-type": "application/javascript; charset=utf-8", 
            "cache-control": "public, max-age=3600",
            "access-control-allow-origin": "*"
          } 
        });
      }

      const targetURL = resolveTarget(here, cookieOrigin);
      if (!targetURL) {
        return new Response(`Cloudflare Proxy Worker

Usage: /?u=<URL>&name=<name>

Parameters:
  u (required)    - Target URL (URL encoded)
  name (required) - Replacement text
  
Optional:
  sel       - CSS selector for element
  xp        - XPath for element  
  old       - Text to find/replace globally
  ww        - Whole word match (1)
  delay     - Delay in ms (default 300)
  tries     - Retry attempts (default 900)
  interval  - Retry interval ms (default 100)
  persist   - Keep origin cookie (1)
  forceHTML - Force HTML processing (1)
  snapshot  - Freeze after replace (1)

Example:
  /?u=https%3A%2F%2Fexample.com&name=John&sel=.username
`, { 
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }

      // Forward request upstream
      const init = {
        method: req.method,
        headers: new Headers(req.headers),
        redirect: "follow"
      };
      
      // Clean headers
      for (const k of ["host", "cf-connecting-ip", "cf-ray", "cf-visitor", "x-forwarded-proto", "x-forwarded-for"]) {
        init.headers.delete(k);
      }
      
      // Set proper origin headers
      init.headers.set("referer", targetURL.origin + "/");
      init.headers.set("origin", targetURL.origin);
      
      // Body for POST/PUT/etc
      if (!["GET", "HEAD"].includes(req.method)) {
        init.body = await req.arrayBuffer();
      }

      const upstream = await fetch(targetURL, init);

      // CSS: rewrite url(...) and preserve MIME type
      const ct = (upstream.headers.get("content-type") || "").toLowerCase();
      const targetURLLower = targetURL.href.toLowerCase();
      
      // Detect CSS by content-type OR URL pattern
      const isCSS = ct.includes("text/css") || 
                    targetURLLower.includes('fonts.googleapis.com/css') ||
                    targetURLLower.includes('/css?') ||
                    targetURLLower.match(/\.css(\?|$)/i);
      
      if (isCSS) {
        const cssText = await upstream.text();
        const rewritten = rewriteCssUrls(cssText, targetURL.href, `${here.origin}${here.pathname}`, here.search);
        const h = new Headers(upstream.headers);
        h.set("content-type", "text/css; charset=utf-8"); // FORCE correct MIME type
        h.delete("content-security-policy"); 
        h.delete("content-security-policy-report-only"); 
        h.delete("x-frame-options");
        h.set("access-control-allow-origin", "*");
        h.set("access-control-allow-methods", "GET, POST, OPTIONS");
        h.set("access-control-allow-headers", "*");
        h.set("cache-control", "public, max-age=31536000");
        return new Response(rewritten, { status: upstream.status, headers: h });
      }

      // Non-HTML passthrough (images, fonts, JS, JSON, etc.)
      if (!isLikelyHTML(req, upstream, here)) {
        const h = new Headers(upstream.headers);
        h.delete("content-security-policy"); 
        h.delete("content-security-policy-report-only"); 
        h.delete("x-frame-options");
        
        // Enhanced CORS for all assets
        h.set("access-control-allow-origin", "*");
        h.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
        h.set("access-control-allow-headers", "*");
        h.set("access-control-allow-credentials", "true");
        
        // Get content type
        const ct = (h.get("content-type") || "").toLowerCase();
        
        // Critical for canvas: allow images to be used
        if (ct.includes("image/")) {
          h.set("cross-origin-resource-policy", "cross-origin");
          h.set("timing-allow-origin", "*");
        }
        
        // Font files need special handling
        if (ct.includes("font") || ct.includes("woff") || ct.includes("ttf") || ct.includes("otf") || ct.includes("eot")) {
          h.set("cross-origin-resource-policy", "cross-origin");
          // Ensure correct MIME types for fonts
          if (targetURL.href.includes('.woff2')) h.set("content-type", "font/woff2");
          else if (targetURL.href.includes('.woff')) h.set("content-type", "font/woff");
          else if (targetURL.href.includes('.ttf')) h.set("content-type", "font/ttf");
          else if (targetURL.href.includes('.otf')) h.set("content-type", "font/otf");
          else if (targetURL.href.includes('.eot')) h.set("content-type", "application/vnd.ms-fontobject");
        }
        
        // SVG files
        if (ct.includes("svg") || targetURL.href.includes('.svg')) {
          h.set("content-type", "image/svg+xml");
          h.set("cross-origin-resource-policy", "cross-origin");
        }
        
        return new Response(upstream.body, { 
          status: upstream.status, 
          statusText: upstream.statusText,
          headers: h 
        });
      }

      // HTML: inject shim + rewrite
      const headers = new Headers(upstream.headers);
      headers.delete("content-security-policy");
      headers.delete("content-security-policy-report-only");
      headers.delete("x-frame-options");
      headers.set("content-type", "text/html; charset=utf-8");
      
      // Cookie to remember origin
      headers.append("set-cookie", `__pt=${encodeURIComponent(targetURL.origin)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800`);

      const rewriter = new HTMLRewriter()
        .on("meta[http-equiv]", new RemoveMetaCSP())
        .on("base", new StripBase())
        .on("head", new InjectHead(
          targetURL.href,
          new URL("/overlay.js", here.origin).href,
          Object.fromEntries(here.searchParams), 
          here.origin, 
          here.pathname
        ))
        // Rewrite all asset references
        .on("a[href]",         new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("form[action]",    new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("img[src]",        new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("img[srcset]",     new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("img",             new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("source[src]",     new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("source[srcset]",  new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("video[poster]",   new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("video[src]",      new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("audio[src]",      new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("canvas",          new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("script[src]",     new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on('link[rel~="stylesheet"]', new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on('link[rel~="preload"]',    new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on('link[rel~="prefetch"]',   new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("iframe[src]",     new RewriteAttrToWorker(`${here.origin}${here.pathname}`, here.search, targetURL.href))
        .on("style",           new RewriteStyleTag(`${here.origin}${here.pathname}`, here.search, targetURL.href));

      const transformed = rewriter.transform(upstream);
      return new Response(transformed.body, { 
        status: upstream.status, 
        statusText: upstream.statusText,
        headers 
      });
      
    } catch(e) {
      console.error("Worker error:", e.message, e.stack);
      return new Response(`Proxy Error: ${e.message}\n\nStack: ${e.stack}`, { 
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }
  }
};
