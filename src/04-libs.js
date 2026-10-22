/* ============================================================
   LUMEN — LIBRARY LOADER (offline-capable)
   Loads CDN libraries with an IndexedDB cache fallback so the
   documentation keeps working with no network after first visit.
   Strategy per library:
     1. Inject <script src> (no CORS needed, uses HTTP cache).
     2. On success: best-effort fetch() of the source to cache it
        in IndexedDB for future offline use.
     3. On failure: read the cached source from IndexedDB and
        inject it inline. If no cache either, degrade gracefully.
   ============================================================ */

window.LumenLibs = (() => {
  const IDB_NAME = 'lumen-cache';
  const STORE = 'libs';

  // ---- tiny IndexedDB helper (promise-based) ----
  function openDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('no idb')); return; }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function cacheGet(key) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => reject(r.error);
      });
    } catch (e) { return null; }
  }
  async function cacheSet(key, value) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
    } catch (e) { /* cache write is best-effort */ }
  }

  const status = {}; // key -> 'cdn' | 'cache' | 'failed'

  // ---- loaders ----
  function injectScriptSrc(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.setAttribute('data-lumen-lib', '1'); // marked so exports can strip it (the loader re-adds it)
      const timer = setTimeout(() => { s.remove(); reject(new Error('timeout')); }, timeoutMs || 10000);
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = () => { clearTimeout(timer); s.remove(); reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
  }
  function injectScriptText(text) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.setAttribute('data-lumen-lib', '1');
      s.textContent = text;
      document.head.appendChild(s);
      resolve();
    });
  }
  function injectCssText(text) {
    const style = document.createElement('style');
    style.setAttribute('data-lumen-lib-css', '1');
    style.textContent = text;
    document.head.appendChild(style);
  }
  function injectCssHref(url) {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      const timer = setTimeout(() => reject(new Error('timeout')), 8000);
      link.onload = () => { clearTimeout(timer); resolve(); };
      link.onerror = () => { clearTimeout(timer); link.remove(); reject(new Error('css failed')); };
      document.head.appendChild(link);
    });
  }
  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }

  async function loadScriptLib(lib) {
    // 1) try live CDN
    try {
      await injectScriptSrc(lib.url, lib.timeout || 12000);
      status[lib.key] = 'cdn';
      // 2) cache for offline (best-effort; requires CORS which jsdelivr provides)
      fetchText(lib.url).then(t => cacheSet(lib.key, t)).catch(() => {});
      return true;
    } catch (e) { /* fall through */ }
    // 3) cached copy
    const cached = await cacheGet(lib.key);
    if (cached) {
      await injectScriptText(cached);
      status[lib.key] = 'cache';
      return true;
    }
    status[lib.key] = 'failed';
    return false;
  }

  async function loadCssLib(lib) {
    try {
      await injectCssHref(lib.url);
      status[lib.key] = 'cdn';
      fetchText(lib.url).then(t => cacheSet(lib.key, t)).catch(() => {});
      return true;
    } catch (e) { /* fall through */ }
    const cached = await cacheGet(lib.key);
    if (cached) {
      injectCssText(cached);
      status[lib.key] = 'cache';
      return true;
    }
    status[lib.key] = 'failed';
    return false;
  }

  const CRITICAL = [
    { key: 'marked',    url: 'https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js' },
    { key: 'dompurify', url: 'https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js' },
    { key: 'hljs',      url: 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js' },
    { key: 'jszip',     url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js' },
    { key: 'mermaid',   url: 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js', timeout: 20000 },
    { key: 'jsyaml',    url: 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js' },
  ];
  const CRITICAL_CSS = [
    { key: 'hljs-css', url: 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-dark.min.css' },
  ];

  // Lazy libs (loaded on demand by the engine)
  const LAZY = {
    'katex-js':  { key: 'katex-js',  url: 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js' },
    'katex-css': { key: 'katex-css', url: 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css', css: true },
  };

  async function boot() {
    // Parallel loading; scripts injected in order per key (fetch in parallel,
    // but injection must respect nothing — these libs are independent).
    await Promise.all([
      ...CRITICAL.map(loadScriptLib),
      ...CRITICAL_CSS.map(loadCssLib),
    ]);
    const ok = status.marked !== 'failed';
    return ok;
  }

  const ready = boot();

  async function ensure(keys) {
    for (const k of keys) {
      const lib = LAZY[k];
      if (!lib) continue;
      if (lib.done) continue;
      if (lib.css) await loadCssLib(lib);
      else await loadScriptLib(lib);
      lib.done = true;
    }
  }

  return { ready, ensure, status };
})();
