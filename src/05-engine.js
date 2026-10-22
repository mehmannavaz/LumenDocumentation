/* ============================================================
   LUMEN ENGINE
   ============================================================ */

const Lumen = (() => {
  const STORAGE_KEY = 'lumen-docs-v1';
  const SETTINGS_KEY = 'lumen-settings';
  const VERSIONS_KEY = 'lumen-versions';
  const MAX_VERSIONS = 15;

  // -------- Default documentation content (substantial demo) --------
  // Read lazily from window.__LUMEN_DEFAULT_PAGES__ which is set by a script
  // tag further down the document. Reading lazily (not at IIFE parse time)
  // is essential because the pages script runs AFTER this engine script.
  const getDefaultDocs = () => (window.__LUMEN_DEFAULT_PAGES__ || []);

  // -------- State --------
  const state = {
    pages: [],
    currentPageId: null,
    settings: {
      theme: 'midnight',
      font: 16,
      dir: 'ltr',
      density: 'comfortable',
      // --- new settings (v1.1) ---
      viewMode: false,          // read-only mode for viewers
      accent: '',               // custom accent color ('' = theme default)
      customCss: '',            // user CSS applied on top of everything
      compressImages: true,     // downscale large images on upload
      sync: { repo: '', branch: 'main', path: 'lumen-data.json', token: '', auto: false },
      ai: { endpoint: '', model: '', key: '' },
    },
    doc: {
      name: 'Lumen',
      description: 'A single-file static documentation engine',
      version: '1.1',
      author: '',
      icon: '✦',
    },
    bookmarks: [],
    history: [],
    annotations: {},
    lastVisited: {},
    searchIndex: [],
  };

  // -------- Version snapshots (document history) --------
  let versions = [];

  // -------- DOM refs --------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // -------- Utilities --------
  const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const slugify = (s) => s.toLowerCase().trim().replace(/[^\w\u0600-\u06FF\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '') || 'page-' + Date.now();
  const toPersian = (n) => String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
  const wordCount = (text) => (text.match(/\S+/g) || []).length;
  const readingTime = (text) => Math.max(1, Math.ceil(wordCount(text) / 220));
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Auto-detect text direction based on character content.
  // Returns 'rtl' if the text has more RTL characters (Persian/Arabic/Hebrew) than LTR, else 'ltr'.
  function detectDirection(text) {
    const rtlChars = text.match(/[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g);
    const ltrChars = text.match(/[a-zA-Z]/g);
    const rtlCount = rtlChars ? rtlChars.length : 0;
    const ltrCount = ltrChars ? ltrChars.length : 0;
    return rtlCount > ltrCount ? 'rtl' : 'ltr';
  }

  // -------- Persistence --------
  // Pages/bookmarks/settings live in localStorage (small).
  // Uploaded files (base64 media) live in IndexedDB (large, ~unlimited quota)
  // and are mirrored into the in-memory `fileStore` map for fast rendering.
  // This split fixes the old "uploads blow the 5MB localStorage limit" bug.

  // ---- IndexedDB file store ----
  const FileDB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
        const req = indexedDB.open('lumen-files', 1);
        req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
        req.onsuccess = () => { this._db = req.result; resolve(this._db); };
        req.onerror = () => reject(req.error);
      });
    },
    async put(id, rec) {
      try {
        const db = await this.open();
        await new Promise((resolve, reject) => {
          const r = db.transaction('files', 'readwrite').objectStore('files').put(rec, id);
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      } catch (e) { console.warn('FileDB.put failed:', e); }
    },
    async del(id) {
      try {
        const db = await this.open();
        await new Promise((resolve, reject) => {
          const r = db.transaction('files', 'readwrite').objectStore('files').delete(id);
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      } catch (e) { /* best-effort */ }
    },
    async clear() {
      try {
        const db = await this.open();
        await new Promise((resolve, reject) => {
          const r = db.transaction('files', 'readwrite').objectStore('files').clear();
          r.onsuccess = () => resolve();
          r.onerror = () => reject(r.error);
        });
      } catch (e) { /* best-effort */ }
    },
    async all() {
      try {
        const db = await this.open();
        return await new Promise((resolve, reject) => {
          const out = {};
          const r = db.transaction('files', 'readonly').objectStore('files').openCursor();
          r.onsuccess = () => {
            const cur = r.result;
            if (cur) { out[cur.key] = cur.value; cur.continue(); }
            else resolve(out);
          };
          r.onerror = () => reject(r.error);
        });
      } catch (e) { return {}; }
    },
  };

  let saveWarned = false;
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        pages: state.pages,
        bookmarks: state.bookmarks,
        annotations: state.annotations,
        lastVisited: state.lastVisited,
        doc: state.doc,
        // NOTE: fileStore intentionally NOT here anymore — it lives in IndexedDB.
      }));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
      saveWarned = false;
    } catch (e) {
      console.warn('Save failed:', e);
      if (!saveWarned) {
        saveWarned = true;
        toast('⚠ Could not save — browser storage is full. Export a backup and remove large pages.', '⚠');
      }
    }
  }

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      // If no saved pages, check for embedded doc meta (from an exported HTML)
      if (!data.pages || !data.pages.length) {
        if (window.__LUMEN_DOC_META__) Object.assign(state.doc, window.__LUMEN_DOC_META__);
        if (window.__LUMEN_DEFAULT_SETTINGS__) Object.assign(state.settings, window.__LUMEN_DEFAULT_SETTINGS__);
        if (window.__LUMEN_FILE_STORE__) {
          Object.assign(fileStore, window.__LUMEN_FILE_STORE__);
          persistFileStore(); // move embedded files into IndexedDB
        }
        state.pages = getDefaultDocs().slice();
      } else {
        state.pages = data.pages;
      }
      state.bookmarks = data.bookmarks || [];
      state.annotations = data.annotations || {};
      state.lastVisited = data.lastVisited || {};
      if (data.doc) Object.assign(state.doc, data.doc);
      // MIGRATION: older versions kept base64 files inside localStorage —
      // move them to IndexedDB once, then strip them from the localStorage copy.
      if (data.fileStore && Object.keys(data.fileStore).length) {
        Object.assign(fileStore, data.fileStore);
        persistFileStore().then(() => {
          try {
            const clean = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            delete clean.fileStore;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
          } catch (e) { /* best-effort */ }
        });
      }
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      // Deep-merge the nested setting groups so partial stored settings don't wipe defaults
      ['sync', 'ai'].forEach(k => {
        if (s[k] && typeof s[k] === 'object') s[k] = { ...state.settings[k], ...s[k] };
      });
      Object.assign(state.settings, s);
    } catch (e) {
      console.warn('Load failed, using defaults:', e);
      state.pages = getDefaultDocs().slice();
    }
  }

  // Write every in-memory file into IndexedDB (used on import / migration / embedded boot)
  async function persistFileStore() {
    const ids = Object.keys(fileStore);
    for (const id of ids) await FileDB.put(id, fileStore[id]);
  }

  // Remove files that are no longer referenced by any page (garbage collection)
  async function gcFiles() {
    const used = new Set();
    state.pages.forEach(p => {
      const m = (p.content || '').match(/file:\/\/([a-z0-9]+)/g) || [];
      m.forEach(ref => used.add(ref.slice(7)));
    });
    const ids = Object.keys(fileStore);
    for (const id of ids) {
      if (!used.has(id)) {
        delete fileStore[id];
        await FileDB.del(id);
      }
    }
  }

  // -------- Version snapshots (documents act like code) --------
  function loadVersions() {
    try { versions = JSON.parse(localStorage.getItem(VERSIONS_KEY) || '[]'); }
    catch (e) { versions = []; }
  }
  function saveVersions() {
    // Quota-safe: if it doesn't fit, drop the oldest snapshot and retry
    while (true) {
      try { localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions)); return; }
      catch (e) {
        if (versions.length > 1) versions.pop();
        else { try { localStorage.removeItem(VERSIONS_KEY); } catch (_) {} versions = []; return; }
      }
    }
  }
  function snapshot(label) {
    loadVersions();
    versions.unshift({
      id: 'v' + Date.now().toString(36),
      ts: Date.now(),
      label: label || 'Manual snapshot',
      pageCount: state.pages.length,
      wordCount: state.pages.reduce((s, p) => s + wordCount(p.content || ''), 0),
      data: {
        pages: JSON.parse(JSON.stringify(state.pages)),
        doc: { ...state.doc },
        bookmarks: [...state.bookmarks],
      },
    });
    if (versions.length > MAX_VERSIONS) versions.length = MAX_VERSIONS;
    saveVersions();
  }
  function openVersions() {
    loadVersions();
    const list = $('#versionsList');
    if (!list) return;
    if (!versions.length) {
      list.innerHTML = '<div class="version-empty">No snapshots yet. Snapshots are created automatically before destructive actions (delete, import, reset, apply remote update), or manually with the button above.</div>';
    } else {
      list.innerHTML = versions.map(v => `
        <div class="version-item" data-id="${v.id}">
          <div class="version-info">
            <div class="version-label">${escapeHtml(v.label)}</div>
            <div class="version-meta">${timeAgo(v.ts)} · ${v.pageCount} pages · ${v.wordCount.toLocaleString()} words</div>
          </div>
          <div class="version-actions">
            <button class="btn" data-restore="${v.id}">Restore</button>
            <button class="btn" data-delversion="${v.id}">✕</button>
          </div>
        </div>`).join('');
      list.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', () => restoreVersion(b.dataset.restore)));
      list.querySelectorAll('[data-delversion]').forEach(b => b.addEventListener('click', () => {
        versions = versions.filter(v => v.id !== b.dataset.delversion);
        saveVersions();
        openVersions();
      }));
    }
    $('#versionsModal').classList.add('open');
  }
  function restoreVersion(id) {
    const v = versions.find(x => x.id === id);
    if (!v) return;
    if (!confirm('Restore "' + v.label + '"?\n\nYour current state is snapshotted first, so nothing is lost.')) return;
    snapshot('Auto — before restore');
    state.pages = JSON.parse(JSON.stringify(v.data.pages));
    if (v.data.doc) state.doc = { ...v.data.doc };
    state.bookmarks = (v.data.bookmarks || []).slice();
    applyDocSettings();
    buildSearchIndex();
    save();
    gcFiles();
    renderSidebar();
    go(state.pages[0] ? state.pages[0].id : null);
    $('#versionsModal').classList.remove('open');
    toast('Restored: ' + v.label, '⏱');
  }

  // -------- Document metadata --------
  function applyDocSettings() {
    const brandText = document.querySelector('.brand-text');
    const brandVersion = document.querySelector('.brand-version');
    const brandDot = document.querySelector('.brand-dot');
    if (brandText) brandText.textContent = state.doc.name || 'Lumen';
    if (brandVersion) brandVersion.textContent = state.doc.version ? 'v' + state.doc.version : '';
    // brand-dot is a colored circle, leave it alone
    document.title = state.doc.name + (state.doc.description ? ' · ' + state.doc.description : '');
    let metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', state.doc.description || state.doc.name);
    const loadingText = document.querySelector('.loading-text');
    if (loadingText) loadingText.textContent = 'Loading ' + (state.doc.name || 'Lumen');
    const loaderBrand = document.querySelector('.loader-brand');
    if (loaderBrand) loaderBrand.textContent = (state.doc.name || 'LUMEN').toUpperCase() + ' · DOCUMENTATION';
    // Update settings inputs if they exist
    const docNameInput = $('#docName');
    const docDescInput = $('#docDesc');
    const docVersionInput = $('#docVersion');
    const docAuthorInput = $('#docAuthor');
    const docIconInput = $('#docIcon');
    if (docNameInput) docNameInput.value = state.doc.name;
    if (docDescInput) docDescInput.value = state.doc.description;
    if (docVersionInput) docVersionInput.value = state.doc.version;
    if (docAuthorInput) docAuthorInput.value = state.doc.author;
    if (docIconInput) docIconInput.value = state.doc.icon;
  }

  function setDocField(field, value) {
    state.doc[field] = value;
    applyDocSettings();
    save();
  }

  // -------- Markdown rendering with custom extensions --------
  function configureMarked() {
    const renderer = new marked.Renderer();
    renderer.heading = (text, level, raw, slugger) => {
      // marked v4 passes a Slugger as 4th arg — it dedupes repeated headings
      const id = slugger ? slugger.slug(raw) : slugify(raw);
      return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true"></a>${text}</h${level}>`;
    };
    const originalLink = renderer.link.bind(renderer);
    renderer.link = (href, title, text) => {
      if (href && href.startsWith('page://')) {
        const id = href.slice(7);
        return `<a href="#${id}" class="internal-link" data-page="${id}">${text}</a>`;
      }
      if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
        return `<a href="${href}" title="${title || ''}" target="_blank" rel="noopener" class="external-link">${text}<span class="ext-icon"> ↗</span></a>`;
      }
      return originalLink(href, title, text);
    };
    const originalCode = renderer.code.bind(renderer);
    renderer.code = (code, lang) => {
      if (lang === 'mermaid') {
        return `<div class="mermaid">${code}</div>`;
      }
      const language = lang && window.hljs && hljs.getLanguage(lang) ? lang : 'plaintext';
      try {
        const highlighted = window.hljs ? hljs.highlight(code, { language, ignoreIllegals: true }).value : escapeHtml(code);
        const label = lang ? `<span class="code-lang">${lang}</span>` : '';
        return `<pre><code class="hljs language-${language}">${highlighted}</code>${label}<button class="copy-btn" data-code="${encodeURIComponent(code)}" title="Copy">⎘</button></pre>`;
      } catch (e) {
        return `<pre><code>${escapeHtml(code)}</code></pre>`;
      }
    };
    const originalParagraph = renderer.paragraph.bind(renderer);
    renderer.paragraph = (text) => {
      // Convert inline badges: [badge:success:Label]
      text = text.replace(/\[badge:(success|info|warning|danger|neutral):([^\]]+)\]/g, (m, type, label) => `<span class="badge badge-${type}">${label}</span>`);
      // Convert inline kbd: [kbd:Ctrl+K]
      text = text.replace(/\[kbd:([^\]]+)\]/g, (m, keys) => `<span class="kbd-group">${keys.split('+').map(k => `<kbd>${k}</kbd>`).join('')}</span>`);
      return originalParagraph(text);
    };
    marked.setOptions({
      renderer,
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false,
      smartLists: true,
    });
  }

  // Pre-process markdown for custom blocks (callouts, details, cards)
  // Storage for math equations extracted during preprocessing
  // (so marked doesn't touch them, and KaTeX can render them after)
  const mathStore = [];
  let mathStoreIdx = 0;

  function preprocessMarkdown(md) {
    // Reset math store on each render
    mathStore.length = 0;
    mathStoreIdx = 0;

    // ---- STEP 1: protect code FIRST ----
    // Fenced code blocks and inline code spans are extracted before any block
    // transformation runs, so :::syntax shown inside code examples (like the
    // "Syntax" sections of the docs) is displayed verbatim instead of being
    // rendered as a real block.
    const codeBlocks = [];
    md = md.replace(/```[\s\S]*?```/g, (m) => {
      const idx = codeBlocks.length;
      codeBlocks.push(m);
      return `\u0000CODEBLOCK${idx}\u0000`;
    });
    const codeSpans = [];
    md = md.replace(/`[^`\n]+`/g, (m) => {
      const idx = codeSpans.length;
      codeSpans.push(m);
      return `\u0000CODESPAN${idx}\u0000`;
    });

    // ---- STEP 2: block extensions ----
    // All block openers are anchored to the start of a line (^... with /gm),
    // so mentioning ":::flow" in a heading or mid-sentence never triggers a block.

    // Callouts: :::tip / :::info / :::warning / :::danger / :::quote
    md = md.replace(/^:::(tip|info|warning|danger|quote)[ \t]*\n([\s\S]*?)^:::[ \t]*$/gm, (m, type, body) => {
      const icons = { tip: '✓', info: 'i', warning: '!', danger: '✕', quote: '"' };
      const titles = { tip: 'Tip', info: 'Note', warning: 'Warning', danger: 'Important', quote: 'Quote' };
      const b = (body || '').trim();
      return `<div class="callout callout-${type}"><div class="callout-title"><span class="callout-icon">${icons[type]}</span>${titles[type]}</div><div class="callout-body">${marked.parseInline ? marked.parseInline(b) : b}</div></div>`;
    });

    // Cards: :::card-grid\n:::card Title\n...body...\n:::\n:::
    md = md.replace(/^:::card-grid[ \t]*\n([\s\S]*?)\n:::[ \t]*\n:::(?![ \t]*card)/gm, (m, inner) => {
      const fullInner = inner + '\n:::';
      const cards = fullInner.match(/:::card\s+([^\n]+)\s*\n([\s\S]*?):::/g) || [];
      const cardsHtml = cards.map(c => {
        const match = c.match(/:::card\s+([^\n]+)\s*\n([\s\S]*?):::/);
        if (!match) return '';
        const title = match[1].trim();
        const body = match[2].trim();
        return `<div class="card"><div class="card-title">${title}</div><div class="card-body">${marked.parse(body)}</div></div>`;
      }).join('');
      return `<div class="card-grid">${cardsHtml}</div>`;
    });

    // Swagger / OpenAPI: :::swagger\n{json or url}\n:::
    md = md.replace(/^:::swagger[ \t]*\n([\s\S]*?)^:::[ \t]*$/gm, (m, body) => {
      const trimmed = (body || '').trim();
      if (!trimmed) return '<div class="swagger-error">Empty swagger block</div>';
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        return `<div class="swagger-container" data-spec-url="${escapeHtml(trimmed)}"><div class="swagger-loading">Loading API spec…</div></div>`;
      }
      return `<div class="swagger-container" data-spec="${encodeURIComponent(trimmed)}"><div class="swagger-loading">Loading API spec…</div></div>`;
    });

    // Image slider: :::slider\n![alt](url)\n:::
    md = md.replace(/^:::slider[ \t]*\n([\s\S]*?)^:::[ \t]*$/gm, (m, body) => {
      const lines = (body || '').trim().split('\n').filter(l => l.trim());
      const slides = lines.map(line => {
        const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
        if (imgMatch) {
          const alt = imgMatch[1] || '';
          const url = imgMatch[2];
          return `<div class="slider-slide"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">${alt ? '<figcaption>' + escapeHtml(alt) + '</figcaption>' : ''}</div>`;
        }
        return '';
      }).join('');
      if (!slides) return '<div class="swagger-error">Empty slider — add images with ![alt](url)</div>';
      return `<div class="slider" data-slider="1"><div class="slider-track">${slides}</div><button class="slider-btn prev" onclick="Lumen.sliderGo(this,-1)">‹</button><button class="slider-btn next" onclick="Lumen.sliderGo(this,1)">›</button><div class="slider-dots"></div></div>`;
    });

    // Interactive screenshot walkthrough: :::tour
    // Each line: ![alt](url) followed by optional hotspots:  x%,y% -> stepNumber
    // Clicking a hotspot jumps to that step. Shows an app "in work" using only images.
    md = md.replace(/^:::tour[ \t]*\n([\s\S]*?)^:::[ \t]*$/gm, (m, body) => {
      const lines = (body || '').trim().split('\n').filter(l => l.trim());
      const steps = [];
      lines.forEach(line => {
        const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)(.*)$/);
        if (!imgMatch) return;
        const hotspots = [];
        const rest = imgMatch[3] || '';
        let hm;
        const hre = /(\d+(?:\.\d+)?)\s*%?,\s*(\d+(?:\.\d+)?)\s*%?\s*->\s*(\d+)/g;
        while ((hm = hre.exec(rest)) !== null) {
          hotspots.push({ x: parseFloat(hm[1]), y: parseFloat(hm[2]), to: parseInt(hm[3]) });
        }
        steps.push({ alt: imgMatch[1] || '', url: imgMatch[2], hotspots });
      });
      if (!steps.length) return '<div class="swagger-error">Empty tour — add steps with ![alt](url) and optional hotspots: 40%,62 -> 2</div>';
      return `<div class="tour" data-tour="${encodeURIComponent(JSON.stringify(steps))}"><div class="tour-loading">Loading walkthrough…</div></div>`;
    });

    // Flowchart: :::flow — 4 shapes, 4 directions, auto-organize
    //   A[Square]  B(Circle)  C{Diamond}  D<Hexagon>
    //   A > B   (B to the right of A)     A < B   (B to the left)
    //   A ^ B   (B above A)               A v B   (B below A)
    //   Optional edge label:  A > B | yes
    md = md.replace(/^:::flow[ \t]*\n([\s\S]*?)^:::[ \t]*$/gm, (m, body) => {
      return `<div class="flow-chart" data-flow="${encodeURIComponent(body || '')}"><div class="tour-loading">Drawing flowchart…</div></div>`;
    });

    // External embed: :::embed\nhttps://...\n:::  (sandboxed iframe)
    md = md.replace(/^:::embed[ \t]*\n([\s\S]*?)^:::[ \t]*$/gm, (m, body) => {
      const url = (body || '').trim().split(/\s+/)[0];
      if (!/^https:\/\//i.test(url)) {
        return '<div class="swagger-error">Embed requires an https:// URL (e.g. a YouTube share link)</div>';
      }
      return `<div class="embed-wrap"><iframe src="${escapeHtml(url)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" referrerpolicy="no-referrer" allowfullscreen></iframe></div>`;
    });

    // ---- STEP 3: math ----
    // Protect $$...$$ (display) and $...$ (inline) from marked by replacing with
    // placeholders. KaTeX renders them after marked finishes. Code was already
    // extracted in step 1, so math inside code never matches.

    // Display math first (greedy, multi-line)
    md = md.replace(/\$\$([\s\S]+?)\$\$/g, (m, eq) => {
      const idx = mathStoreIdx++;
      mathStore[idx] = { display: true, eq: eq };
      return `\n\n@@MATH${idx}@@\n\n`;
    });
    // Inline math — only match $...$ that is NOT preceded/followed by $ (to avoid $$)
    md = md.replace(/(?<![\\$])\$([^\$\n]+?)\$(?!\$)/g, (m, eq) => {
      // Skip if the equation is empty or looks like money ($5)
      if (/^\d+(\.\d+)?$/.test(eq.trim())) return m;
      const idx = mathStoreIdx++;
      mathStore[idx] = { display: false, eq: eq };
      return `@@MATH${idx}@@`;
    });

    // ---- STEP 4: restore code so marked can highlight it ----
    md = md.replace(/\u0000CODESPAN(\d+)\u0000/g, (m, idx) => codeSpans[parseInt(idx)]);
    md = md.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (m, idx) => codeBlocks[parseInt(idx)]);

    return md;
  }

  // After marked produces HTML, restore math placeholders and render with KaTeX.
  // Returns HTML string. KaTeX is called lazily — if not loaded, leaves placeholders
  // that will be rendered when KaTeX arrives.
  function restoreMath(html) {
    return html.replace(/@@MATH(\d+)@@/g, (m, idx) => {
      const item = mathStore[parseInt(idx)];
      if (!item) return '';
      if (window.katex) {
        try {
          return window.katex.renderToString(item.eq, { displayMode: item.display, throwOnError: false });
        } catch (e) {
          return '<span style="color:#f87171">[math error]</span>';
        }
      }
      // KaTeX not loaded yet — leave a placeholder span for later rendering
      const tag = item.display ? 'div' : 'span';
      return `<${tag} class="math-placeholder" data-math-idx="${idx}" data-display="${item.display}">${escapeHtml(item.display ? '$$' + item.eq + '$$' : '$' + item.eq + '$')}</${tag}>`;
    });
  }

  // Render any leftover math-placeholder elements with KaTeX (called after lazy load completes)
  function renderMathPlaceholders(rootEl) {
    if (!window.katex) return;
    rootEl.querySelectorAll('.math-placeholder').forEach(el => {
      const idx = parseInt(el.dataset.mathIdx);
      const item = mathStore[idx];
      if (!item) return;
      try {
        const rendered = window.katex.renderToString(item.eq, { displayMode: item.display === 'true' || item.display === true, throwOnError: false });
        el.outerHTML = rendered;
      } catch (e) {
        el.textContent = '[math error]';
      }
    });
  }

  function renderMarkdown(md) {
    const processed = preprocessMarkdown(md);
    let html = marked.parse(processed);
    html = restoreMath(html);
    // Resolve file:// references to their stored data URLs (so the editor source stays short)
    html = resolveFileRefs(html);
    return window.DOMPurify ? DOMPurify.sanitize(html, {
      ADD_TAGS: ['div', 'span', 'audio', 'video', 'source', 'embed', 'figure', 'figcaption', 'iframe', 'details', 'summary'],
      ADD_ATTR: ['class', 'data-page', 'data-code', 'data-spec', 'data-spec-url', 'data-endpoint', 'data-method', 'data-path', 'data-scheme', 'data-math-idx', 'data-display', 'data-tour', 'data-flow', 'data-slider', 'id', 'target', 'rel', 'aria-hidden', 'controls', 'src', 'type', 'width', 'height', 'style', 'sandbox', 'loading', 'allowfullscreen', 'referrerpolicy', 'open'],
    }) : html;
  }

  // -------- File store --------
  // Dropped files are stored here (in memory, persisted to IndexedDB).
  // The editor source references them as file://ID — short and clean.
  // At render time, resolveFileRefs() swaps them back to data URLs.
  const fileStore = {};  // { id: { name, type, dataUrl } }
  // (defined early so save()/load() can reference it)

  function resolveFileRefs(html) {
    // Replace file://ID in src="..." and href="..." attributes with the stored data URL
    return html.replace(/\bfile:\/\/([a-z0-9]+)/g, (m, id) => {
      const f = fileStore[id];
      return f ? f.dataUrl : m;
    });
  }

  // Resolve a single file://ID url to its data URL (used by tour images etc.)
  function resolveFileUrl(url) {
    const m = String(url || '').match(/^file:\/\/([a-z0-9]+)$/);
    if (m && fileStore[m[1]]) return fileStore[m[1]].dataUrl;
    return url;
  }

  function saveFileToStore(name, type, dataUrl) {
    const id = 'f' + Math.random().toString(36).slice(2, 10);
    fileStore[id] = { name, type, dataUrl };
    FileDB.put(id, fileStore[id]); // async, fire-and-forget
    return id;
  }

  // -------- Search index --------
  function buildSearchIndex() {
    state.searchIndex = [];
    state.pages.forEach(page => {
      // Index whole page
      state.searchIndex.push({
        type: 'page',
        pageId: page.id,
        title: page.title,
        snippet: (page.content || '').slice(0, 200).replace(/[#*`]/g, ''),
        score: 1,
      });
      // Index headings
      const headings = (page.content || '').match(/^#{1,6}\s+.+$/gm) || [];
      headings.forEach(h => {
        const level = h.match(/^#+/)[0].length;
        const text = h.replace(/^#+\s+/, '');
        state.searchIndex.push({
          type: level === 1 ? 'h1' : level === 2 ? 'h2' : 'heading',
          pageId: page.id,
          title: text,
          snippet: 'Section heading',
          score: 0.7,
        });
      });
    });
  }

  function search(query) {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const terms = q.split(/\s+/);
    const results = [];
    state.searchIndex.forEach(item => {
      const titleMatch = item.title.toLowerCase().includes(q);
      const termsMatch = terms.every(t => item.title.toLowerCase().includes(t) || (item.snippet && item.snippet.toLowerCase().includes(t)));
      if (titleMatch || termsMatch) {
        const page = state.pages.find(p => p.id === item.pageId);
        if (page) {
          results.push({
            ...item,
            pageTitle: page.title,
            pageIcon: page.icon || '📄',
            score: item.score + (titleMatch ? 1 : 0),
          });
        }
      }
    });
    return results.sort((a, b) => b.score - a.score).slice(0, 12);
  }

  // -------- Routing --------
  function go(pageId, anchor) {
    if (!pageId) return;
    state.currentPageId = pageId;
    state.history.push(pageId);
    if (state.history.length > 50) state.history.shift();
    state.lastVisited[pageId] = Date.now();
    save();
    renderPage(pageId, anchor);
    renderSidebar();
    renderStatusbar();
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.getElementById('content').scrollTop = 0;
  }

  function goNext() {
    const idx = state.pages.findIndex(p => p.id === state.currentPageId);
    if (idx < state.pages.length - 1) go(state.pages[idx + 1].id);
  }
  function goPrev() {
    const idx = state.pages.findIndex(p => p.id === state.currentPageId);
    if (idx > 0) go(state.pages[idx - 1].id);
  }

  // -------- Rendering --------
  function renderPage(pageId, anchor) {
    const page = state.pages.find(p => p.id === pageId);
    if (!page) return;
    const idx = state.pages.findIndex(p => p.id === pageId);
    const num = String(idx + 1).padStart(2, '0');
    const total = String(state.pages.length).padStart(2, '0');
    const isCover = page.layout === 'cover';

    const html = renderMarkdown(page.content || '');
    const subtitle = page.subtitle ? `<div class="page-subtitle">${escapeHtml(page.subtitle)}</div>` : '';
    const tags = (page.tags || []).map(t => `<span class="badge badge-neutral">${escapeHtml(t)}</span>`).join(' ');

    const prev = state.pages[idx - 1];
    const next = state.pages[idx + 1];
    const prevHtml = prev ? `<a class="page-nav-link prev" onclick="Lumen.go('${prev.id}')"><div class="page-nav-label">← Previous</div><div class="page-nav-title">${escapeHtml(prev.title)}</div></a>` : '<div></div>';
    const nextHtml = next ? `<a class="page-nav-link next" onclick="Lumen.go('${next.id}')"><div class="page-nav-label">Next →</div><div class="page-nav-title">${escapeHtml(next.title)}</div></a>` : '<div></div>';

    const pageDir = page.dir || detectDirection(page.content || '') || state.settings.dir;
    const dirAttr = pageDir === 'rtl' ? 'dir="rtl"' : (pageDir === 'auto' ? 'dir="auto"' : 'dir="ltr"');

    // Cover layout: title slide — no breadcrumb, no page-meta, larger title
    const headerHtml = isCover ? `
      <div class="page-header cover-header">
        <div class="page-header-actions">
          <button class="page-action-btn" onclick="Lumen.openEditor('${pageId}')" title="Edit page">✎ Edit</button>
          <button class="page-action-btn page-action-delete" onclick="Lumen.deletePage('${pageId}')" title="Delete page">🗑</button>
        </div>
        <h1 class="page-title cover-title">${escapeHtml(page.title)}</h1>
        ${subtitle}
      </div>
    ` : `
      <div class="page-header">
        <div class="page-header-actions">
          <button class="page-action-btn" onclick="Lumen.openEditor('${pageId}')" title="Edit page">✎ Edit</button>
          <button class="page-action-btn page-action-delete" onclick="Lumen.deletePage('${pageId}')" title="Delete page">🗑</button>
        </div>
        <div class="page-breadcrumb">
          <a onclick="Lumen.go('cover')">Home</a>
          <span class="sep">/</span>
          <span>${escapeHtml(page.section || 'Documentation')}</span>
          <span class="sep">/</span>
          <span style="color: var(--accent);">${escapeHtml(page.title)}</span>
        </div>
        <h1 class="page-title">${escapeHtml(page.title)}</h1>
        ${subtitle}
        <div class="page-meta">
          <span class="page-meta-item">📄 Page ${num} of ${total}</span>
          <span class="page-meta-item">⏱ ${readingTime(page.content || '')} min read</span>
          <span class="page-meta-item">📝 ${wordCount(page.content || '')} words</span>
          ${tags ? `<span class="page-meta-item">${tags}</span>` : ''}
        </div>
      </div>
    `;

    $('#page').innerHTML = `
      ${headerHtml}
      <div class="markdown" ${dirAttr}>${html}</div>
      <nav class="page-nav">${prevHtml}${nextHtml}</nav>
    `;

    // KaTeX — math is already rendered to HTML in renderMarkdown() via restoreMath().
    // If KaTeX wasn't loaded at render time, math-placeholder elements exist — load KaTeX and render them.
    const pageEl = $('#page');
    if (pageEl.querySelector('.math-placeholder')) {
      ensureKatexLoaded().then(() => renderMathPlaceholders(pageEl));
    }

    // Mermaid
    const mermaidEls = $$('#page .mermaid');
    if (mermaidEls.length && window.mermaid) {
      try {
        window.mermaid.run({ nodes: mermaidEls });
      } catch (e) {}
    }

    // Swagger / OpenAPI
    const swaggerEls = $$('#page .swagger-container');
    if (swaggerEls.length) {
      swaggerEls.forEach(el => initializeSwagger(el));
    }

    // Sliders — build dots and set initial position
    $$('#page .slider').forEach(slider => initializeSlider(slider));

    // Interactive walkthroughs + flowcharts
    initializeTours($('#page'));
    initializeFlows($('#page'));

    // Copy buttons
    $$('#page .copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const code = decodeURIComponent(btn.dataset.code);
        navigator.clipboard.writeText(code).then(() => {
          btn.classList.add('copied');
          btn.innerText = '✓';
          setTimeout(() => { btn.classList.remove('copied'); btn.innerText = '⎘'; }, 1500);
          toast('Code copied to clipboard');
        });
      });
    });

    // Image zoom
    $$('#page img').forEach(img => {
      img.addEventListener('click', () => zoomImage(img.src));
    });

    // Internal links
    $$('#page a.internal-link').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        go(a.dataset.page);
      });
    });

    // Build TOC from headings (h2-h4)
    renderTOC();

    // Update URL hash
    if (window.location.hash !== '#' + pageId) {
      history.replaceState(null, '', '#' + pageId + (anchor ? ',' + anchor : ''));
    }

    // Scroll to anchor if specified
    if (anchor) {
      setTimeout(() => {
        const el = document.getElementById(anchor);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }

  // -------- Swagger / OpenAPI renderer --------
  // Credentials are stored per-spec in memory only — never persisted to localStorage.
  const swaggerCredentials = new Map();

  async function initializeSwagger(container) {
    const url = container.dataset.specUrl;
    const inline = container.dataset.spec;
    let spec;
    try {
      if (url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        try { spec = JSON.parse(text); }
        catch { spec = window.jsyaml ? jsyaml.load(text) : null; if (!spec) throw new Error('Failed to parse (install js-yaml for YAML support)'); }
      } else {
        const raw = decodeURIComponent(inline);
        try { spec = JSON.parse(raw); }
        catch { spec = window.jsyaml ? jsyaml.load(raw) : null; if (!spec) throw new Error('Invalid JSON'); }
      }
      if (!spec || !spec.paths) throw new Error('Not a valid OpenAPI spec (missing paths)');
      renderSwagger(container, spec);
    } catch (e) {
      container.innerHTML = '<div class="swagger-error">⚠ Failed to load API spec: ' + escapeHtml(e.message) + '</div>';
    }
  }

  function renderSwagger(container, spec) {
    const info = spec.info || {};
    const servers = spec.servers || [];
    const paths = spec.paths || {};
    const components = spec.components || {};
    const securitySchemes = components.securitySchemes || {};
    const specId = 'sw-' + Math.random().toString(36).slice(2, 8);
    container.dataset.specId = specId;

    // Initialize credential store for this spec
    if (!swaggerCredentials.has(specId)) {
      const creds = {};
      Object.keys(securitySchemes).forEach(name => { creds[name] = { type: securitySchemes[name].type, value: '' }; });
      swaggerCredentials.set(specId, creds);
    }

    let html = '<div class="swagger">';

    // Info section
    html += '<div class="swagger-info">';
    html += '<span class="swagger-title">' + escapeHtml(info.title || 'API') + '</span>';
    if (info.version) html += '<span class="swagger-version">v' + escapeHtml(info.version) + '</span>';
    if (info.description) html += '<div class="swagger-desc">' + escapeHtml(info.description) + '</div>';
    if (servers.length) {
      html += '<div class="swagger-servers">Base URL: <code>' + escapeHtml(servers[0].url) + '</code>';
      if (servers.length > 1) html += ' <span>(' + servers.length + ' servers available)</span>';
      html += '</div>';
    }
    html += '</div>';

    // Auth panel
    const schemeKeys = Object.keys(securitySchemes);
    if (schemeKeys.length) {
      html += '<div class="swagger-auth">';
      html += '<div class="swagger-auth-header">🔐 Authentication — credentials stored in memory only</div>';
      schemeKeys.forEach(name => {
        const scheme = securitySchemes[name];
        html += renderAuthInput(specId, name, scheme);
      });
      html += '</div>';
    }

    // Group endpoints by tag
    const tags = {};
    const tagOrder = [];
    Object.keys(paths).forEach(path => {
      const methods = paths[path] || {};
      ['get','post','put','delete','patch','options','head'].forEach(method => {
        const op = methods[method];
        if (!op) return;
        const tag = (op.tags && op.tags[0]) || 'Default';
        if (!tags[tag]) { tags[tag] = []; tagOrder.push(tag); }
        tags[tag].push({ path, method, op });
      });
    });

    tagOrder.forEach(tag => {
      html += '<div class="swagger-tag">';
      html += '<div class="swagger-tag-title">' + escapeHtml(tag) + '</div>';
      tags[tag].forEach(({ path, method, op }) => {
        html += renderEndpoint(specId, path, method, op, servers, securitySchemes);
      });
      html += '</div>';
    });

    html += '</div>';
    container.innerHTML = html;

    // Attach handlers
    attachSwaggerHandlers(container, spec, specId);
  }

  function renderAuthInput(specId, name, scheme) {
    const type = scheme.type;
    let label, placeholder, html = '';
    html += '<div class="swagger-auth-scheme">';
    html += '<div class="swagger-auth-scheme-label"><strong>' + escapeHtml(name) + '</strong> — ' + escapeHtml(type);
    if (scheme.description) html += ' · ' + escapeHtml(scheme.description);
    html += '</div>';
    if (type === 'http' && scheme.scheme === 'bearer') {
      html += '<input type="password" class="swagger-auth-input" data-auth="' + escapeHtml(specId) + ':' + escapeHtml(name) + '" data-auth-type="bearer" placeholder="Bearer token" autocomplete="off">';
    } else if (type === 'apiKey') {
      const loc = scheme.in || 'header';
      html += '<input type="text" class="swagger-auth-input" data-auth="' + escapeHtml(specId) + ':' + escapeHtml(name) + '" data-auth-type="apikey" data-auth-in="' + escapeHtml(loc) + '" data-auth-name="' + escapeHtml(scheme.name || 'X-API-Key') + '" placeholder="' + escapeHtml(scheme.name || 'API Key') + ' value" autocomplete="off">';
    } else if (type === 'http' && scheme.scheme === 'basic') {
      html += '<div class="swagger-auth-row"><input type="text" class="swagger-auth-input" data-auth="' + escapeHtml(specId) + ':' + escapeHtml(name) + ':user" data-auth-type="basic-user" placeholder="Username" autocomplete="off"><input type="password" class="swagger-auth-input" data-auth="' + escapeHtml(specId) + ':' + escapeHtml(name) + ':pass" data-auth-type="basic-pass" placeholder="Password" autocomplete="off"></div>';
    } else {
      html += '<div class="swagger-auth-scheme-label">Auth type "' + escapeHtml(type) + '" not supported for try-it-out</div>';
    }
    html += '</div>';
    return html;
  }

  function renderEndpoint(specId, path, method, op, servers, securitySchemes) {
    const params = op.parameters || [];
    const requestBody = op.requestBody;
    const responses = op.responses || {};
    const security = op.security || [];
    const baseUrl = (servers && servers[0]) ? servers[0].url : '';
    const methodUpper = method.toUpperCase();

    let html = '<div class="swagger-endpoint" data-endpoint="' + escapeHtml(specId + ':' + method + path) + '">';
    // Summary row (click to expand)
    html += '<div class="swagger-endpoint-summary">';
    html += '<span class="swagger-method-badge swagger-method-' + method + '">' + methodUpper + '</span>';
    html += '<span class="swagger-path">' + escapeHtml(path) + '</span>';
    if (op.summary) html += '<span class="swagger-summary-text">' + escapeHtml(op.summary) + '</span>';
    html += '<span class="swagger-endpoint-toggle">▶</span>';
    html += '</div>';

    // Details
    html += '<div class="swagger-endpoint-details">';

    // Description
    if (op.description) html += '<div class="swagger-desc-text">' + escapeHtml(op.description) + '</div>';

    // Parameters reference table
    if (params.length) {
      html += '<div class="swagger-section-label">Parameters</div>';
      html += '<table class="swagger-params"><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Description</th></tr></thead><tbody>';
      params.forEach(p => {
        const schema = p.schema || {};
        html += '<tr>';
        html += '<td class="swagger-param-name">' + escapeHtml(p.name) + (p.required ? '<span class="swagger-param-required">*</span>' : '') + '</td>';
        html += '<td class="swagger-param-in">' + escapeHtml(p.in) + '</td>';
        html += '<td class="swagger-param-type">' + escapeHtml(schema.type || '') + '</td>';
        html += '<td class="swagger-param-desc">' + escapeHtml(p.description || '') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    }

    // Try-it-out form
    html += '<div class="swagger-section-label">Try it out</div>';
    html += '<div class="swagger-tryout">';
    // Path/query params as inputs
    if (params.length) {
      params.forEach(p => {
        const schema = p.schema || {};
        const required = p.required ? '<span class="swagger-req">*</span>' : '';
        html += '<div class="swagger-input-row">';
        html += '<label class="swagger-input-label">' + escapeHtml(p.name) + required + ' <span class="swagger-param-in">(' + escapeHtml(p.in) + ')</span></label>';
        html += '<input type="text" class="swagger-input-field" data-param="' + escapeHtml(p.in) + ':' + escapeHtml(p.name) + '" placeholder="' + escapeHtml(schema.type || 'string') + '" autocomplete="off">';
        html += '</div>';
      });
    }
    // Request body
    if (requestBody && requestBody.content) {
      const content = requestBody.content['application/json'] || requestBody.content[Object.keys(requestBody.content)[0]];
      if (content) {
        const example = content.example ? JSON.stringify(content.example, null, 2) : (content.schema ? '{}' : '');
        html += '<div class="swagger-input-row"><label class="swagger-input-label">body</label></div>';
        html += '<textarea class="swagger-textarea" data-body="1" placeholder="Request body (JSON)">' + escapeHtml(example) + '</textarea>';
      }
    }
    // Auth indicator
    if (security.length && Object.keys(securitySchemes).length) {
      const schemeNames = security.map(s => Object.keys(s)[0]).filter(n => securitySchemes[n]);
      if (schemeNames.length) {
        html += '<div class="swagger-response-meta">🔒 Uses auth: ' + escapeHtml(schemeNames.join(', ')) + ' — set credentials above</div>';
      }
    }
    // Try button
    html += '<button class="swagger-try-btn" data-try="' + escapeHtml(specId + ':' + method + path) + '">⚡ Send request</button>';
    // Response area
    html += '<div class="swagger-response" data-response="' + escapeHtml(specId + ':' + method + path) + '"></div>';
    html += '</div>'; // tryout

    // Responses reference
    const respKeys = Object.keys(responses);
    if (respKeys.length) {
      html += '<div class="swagger-section-label">Responses</div>';
      respKeys.forEach(code => {
        const r = responses[code];
        const colorClass = (code >= 200 && code < 300) ? 'success' : (code >= 400) ? 'error' : (code >= 300 && code < 400) ? 'redirect' : '';
        html += '<div class="swagger-response-meta"><span class="swagger-response-status ' + colorClass + '">' + escapeHtml(code) + '</span> ' + escapeHtml(r.description || '') + '</div>';
      });
    }

    html += '</div>'; // details
    html += '</div>'; // endpoint
    return html;
  }

  function attachSwaggerHandlers(container, spec, specId) {
    const servers = spec.servers || [];
    const securitySchemes = (spec.components || {}).securitySchemes || {};

    // Expand/collapse endpoints
    container.querySelectorAll('.swagger-endpoint-summary').forEach(summary => {
      summary.addEventListener('click', () => {
        summary.parentElement.classList.toggle('open');
      });
    });

    // Auth inputs — store in memory
    container.querySelectorAll('.swagger-auth-input').forEach(input => {
      input.addEventListener('input', () => {
        const creds = swaggerCredentials.get(specId) || {};
        const key = input.dataset.auth.split(':')[1];
        const authType = input.dataset.authType;
        if (authType === 'bearer') {
          creds[key] = { type: 'bearer', value: input.value };
        } else if (authType === 'apikey') {
          creds[key] = { type: 'apikey', value: input.value, in: input.dataset.authIn, name: input.dataset.authName };
        } else if (authType === 'basic-user') {
          creds[key] = creds[key] || { type: 'basic', user: '', pass: '' };
          creds[key].user = input.value;
          creds[key].type = 'basic';
        } else if (authType === 'basic-pass') {
          creds[key] = creds[key] || { type: 'basic', user: '', pass: '' };
          creds[key].pass = input.value;
          creds[key].type = 'basic';
        }
        swaggerCredentials.set(specId, creds);
      });
    });

    // Try-it-out buttons
    container.querySelectorAll('.swagger-try-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const endpointId = btn.dataset.try;
        const match = endpointId.match(/^[^:]+:([^:]+):(.*)$/);
        if (!match) return;
        const method = match[1];
        const path = match[2];
        const endpointEl = btn.closest('.swagger-endpoint');
        if (!endpointEl) return;
        executeSwaggerRequest(specId, method, path, endpointEl, servers, spec.paths[path][method], spec.security || []);
      });
    });
  }

  async function executeSwaggerRequest(specId, method, path, endpointEl, servers, op, globalSecurity) {
    const responseEl = endpointEl.querySelector('.swagger-response');
    const btn = endpointEl.querySelector('.swagger-try-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Sending…';
    responseEl.classList.add('show');

    const baseUrl = (servers && servers[0]) ? servers[0].url.replace(/\/$/, '') : '';
    let url = path;
    const headers = {};
    const queryParams = [];

    // Collect parameter values
    endpointEl.querySelectorAll('.swagger-input-field[data-param]').forEach(input => {
      const val = input.value.trim();
      if (!val) return;
      const [loc, name] = input.dataset.param.split(':');
      if (loc === 'path') {
        url = url.replace('{' + name + '}', encodeURIComponent(val));
      } else if (loc === 'query') {
        queryParams.push(encodeURIComponent(name) + '=' + encodeURIComponent(val));
      } else if (loc === 'header') {
        headers[name] = val;
      }
    });
    if (queryParams.length) url += '?' + queryParams.join('&');

    // Body
    let body = null;
    const bodyEl = endpointEl.querySelector('.swagger-textarea[data-body]');
    if (bodyEl && bodyEl.value.trim()) {
      body = bodyEl.value.trim();
      headers['Content-Type'] = 'application/json';
    }

    // Auth
    const creds = swaggerCredentials.get(specId) || {};
    const security = op.security || globalSecurity || [];
    if (security.length) {
      security.forEach(sec => {
        const schemeName = Object.keys(sec)[0];
        const cred = creds[schemeName];
        if (!cred || !cred.value) return;
        if (cred.type === 'bearer') {
          headers['Authorization'] = 'Bearer ' + cred.value;
        } else if (cred.type === 'apikey') {
          if (cred.in === 'header') headers[cred.name] = cred.value;
          else if (cred.in === 'query') url += (url.includes('?') ? '&' : '?') + encodeURIComponent(cred.name) + '=' + encodeURIComponent(cred.value);
        } else if (cred.type === 'basic') {
          if (cred.user !== undefined && cred.pass !== undefined) {
            headers['Authorization'] = 'Basic ' + btoa(cred.user + ':' + cred.pass);
          }
        }
      });
    }

    // Build full URL after auth (apiKey-in-query may have modified url)
    const fullUrl = baseUrl + url;

    // Build curl for display
    let curl = 'curl -X ' + method.toUpperCase() + ' "' + fullUrl + '"';
    Object.keys(headers).forEach(h => { curl += ' \\\n  -H "' + h + ': ' + headers[h] + '"'; });
    if (body) curl += ' \\\n  -d \'' + body.replace(/'/g, "'\\''") + "'";

    // Execute
    const startTime = Date.now();
    try {
      const res = await fetch(fullUrl, { method: method.toUpperCase(), headers, body: body || undefined });
      const elapsed = Date.now() - startTime;
      const text = await res.text();
      let bodyDisplay = text;
      try { bodyDisplay = JSON.stringify(JSON.parse(text), null, 2); } catch (e) {}

      const statusClass = (res.status >= 200 && res.status < 300) ? 'success' : (res.status >= 400) ? 'error' : (res.status >= 300 && res.status < 400) ? 'redirect' : '';
      responseEl.innerHTML =
        '<div class="swagger-response-status ' + statusClass + '">Status: ' + res.status + ' ' + (res.statusText || '') + ' · ' + elapsed + 'ms</div>' +
        '<div class="swagger-response-body">' + escapeHtml(bodyDisplay || '(empty response)') + '</div>' +
        '<div class="swagger-response-meta">Response size: ' + (text.length).toLocaleString() + ' bytes</div>' +
        '<div class="swagger-curl" title="Click to copy">📋 ' + escapeHtml(curl) + '</div>';
      // Click curl to copy
      responseEl.querySelector('.swagger-curl').addEventListener('click', () => {
        navigator.clipboard.writeText(curl).then(() => toast('cURL copied'));
      });
    } catch (e) {
      responseEl.innerHTML =
        '<div class="swagger-response-status error">⚠ Request failed: ' + escapeHtml(e.message) + '</div>' +
        '<div class="swagger-response-body">' + escapeHtml(e.stack || e.message) + '</div>' +
        '<div class="swagger-response-meta">This is likely a CORS restriction. The API server must allow cross-origin requests from this domain, or you must run Lumen from the same origin as the API.</div>' +
        '<div class="swagger-curl" title="Click to copy">📋 ' + escapeHtml(curl) + '</div>';
      responseEl.querySelector('.swagger-curl').addEventListener('click', () => {
        navigator.clipboard.writeText(curl).then(() => toast('cURL copied'));
      });
    }
    btn.disabled = false;
    btn.textContent = '⚡ Send request';
  }

  // -------- Image slider --------
  function initializeSlider(slider) {
    const track = slider.querySelector('.slider-track');
    const slides = slider.querySelectorAll('.slider-slide');
    const dotsContainer = slider.querySelector('.slider-dots');
    if (!track || !slides.length) return;
    slider.dataset.current = '0';
    // Build dots
    if (dotsContainer) {
      dotsContainer.innerHTML = Array.from(slides).map((_, i) =>
        `<div class="slider-dot${i === 0 ? ' active' : ''}" data-idx="${i}"></div>`
      ).join('');
      dotsContainer.querySelectorAll('.slider-dot').forEach(dot => {
        dot.addEventListener('click', () => sliderGoTo(slider, parseInt(dot.dataset.idx)));
      });
    }
    // Touch / swipe support
    let startX = 0, isDown = false;
    track.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; isDown = true; }, { passive: true });
    track.addEventListener('touchend', (e) => {
      if (!isDown) return;
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 50) sliderGo(slider.querySelector('.slider-btn'), dx < 0 ? 1 : -1);
      isDown = false;
    }, { passive: true });
  }

  function sliderGo(btn, direction) {
    const slider = btn.closest('.slider');
    if (!slider) return;
    const current = parseInt(slider.dataset.current || '0');
    const slides = slider.querySelectorAll('.slider-slide');
    const total = slides.length;
    let next = current + direction;
    if (next < 0) next = total - 1;
    if (next >= total) next = 0;
    sliderGoTo(slider, next);
  }

  function sliderGoTo(slider, idx) {
    const track = slider.querySelector('.slider-track');
    const slides = slider.querySelectorAll('.slider-slide');
    const dots = slider.querySelectorAll('.slider-dot');
    if (!track || !slides.length) return;
    const isRTL = document.documentElement.getAttribute('dir') === 'rtl';
    const offset = isRTL ? idx * 100 : -idx * 100;
    track.style.transform = `translateX(${offset}%)`;
    slider.dataset.current = idx;
    dots.forEach((d, i) => d.classList.toggle('active', i === idx));
  }

  // -------- Interactive screenshot walkthrough (:::tour) --------
  // Shows an app "in work" using only images: each step is a screenshot,
  // hotspots (x%,y% -> step) are clickable circles that jump between steps.
  function initializeTours(rootEl) {
    rootEl.querySelectorAll('.tour').forEach(tour => {
      if (tour.dataset.ready) return;
      tour.dataset.ready = '1';
      let steps;
      try { steps = JSON.parse(decodeURIComponent(tour.dataset.tour)); }
      catch (e) { tour.innerHTML = '<div class="swagger-error">Invalid tour data</div>'; return; }
      if (!steps.length) return;

      const stage = document.createElement('div');
      stage.className = 'tour-stage';
      const img = document.createElement('img');
      img.className = 'tour-img';
      img.alt = steps[0].alt || '';
      img.src = resolveFileUrl(steps[0].url);
      stage.appendChild(img);

      const caption = document.createElement('div');
      caption.className = 'tour-caption';

      const controls = document.createElement('div');
      controls.className = 'tour-controls';
      controls.innerHTML =
        '<button class="tour-btn prev" title="Previous step">‹</button>' +
        '<div class="tour-dots">' + steps.map((_, i) => `<span class="tour-dot${i === 0 ? ' active' : ''}" data-i="${i}"></span>`).join('') + '</div>' +
        '<span class="tour-counter">1 / ' + steps.length + '</span>' +
        '<button class="tour-btn next" title="Next step">›</button>';
      tour.innerHTML = '';
      tour.appendChild(stage);
      tour.appendChild(caption);
      tour.appendChild(controls);

      let current = 0;
      function renderHotspots() {
        stage.querySelectorAll('.tour-hotspot').forEach(h => h.remove());
        (steps[current].hotspots || []).forEach(h => {
          if (h.to < 1 || h.to > steps.length) return;
          const btn = document.createElement('button');
          btn.className = 'tour-hotspot';
          btn.style.left = h.x + '%';
          btn.style.top = h.y + '%';
          btn.title = 'Go to step ' + h.to;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            show(h.to - 1, true);
          });
          stage.appendChild(btn);
        });
      }
      function show(i, viaHotspot) {
        current = Math.max(0, Math.min(steps.length - 1, i));
        const s = steps[current];
        img.src = resolveFileUrl(s.url);
        img.alt = s.alt || '';
        caption.textContent = (current + 1) + '. ' + (s.alt || '');
        caption.style.display = s.alt ? '' : 'none';
        controls.querySelector('.tour-counter').textContent = (current + 1) + ' / ' + steps.length;
        controls.querySelectorAll('.tour-dot').forEach((d, di) => d.classList.toggle('active', di === current));
        renderHotspots();
        if (viaHotspot) {
          stage.classList.remove('pulse');
          void stage.offsetWidth; // restart animation
          stage.classList.add('pulse');
        }
      }
      controls.querySelector('.prev').addEventListener('click', () => show(current - 1));
      controls.querySelector('.next').addEventListener('click', () => show(current + 1));
      controls.querySelectorAll('.tour-dot').forEach(d => d.addEventListener('click', () => show(parseInt(d.dataset.i))));
      show(0);
    });
  }

  // -------- Flowchart engine (:::flow) --------
  // 4 shapes (square / circle / diamond / hexagon), 4 directions (> < ^ v),
  // auto-organize via direction-constrained grid relaxation, rendered as SVG.
  function parseFlow(src) {
    const nodes = new Map(); // id -> { id, label, shape }
    const edges = [];        // { from, to, dir, label }
    (src || '').split('\n').forEach(line => {
      const l = line.trim();
      if (!l || l.startsWith('#') || l.startsWith('//')) return;
      // Node: ID[Label] | ID(Label) | ID{Label} | ID<Label>
      const nm = l.match(/^([A-Za-z0-9_-]+)\s*([\[\(\{<])([^)\]\}>]*)[\]\)\}>]$/);
      if (nm) {
        const label = nm[3].trim() || nm[1];
        nodes.set(nm[1], { id: nm[1], label, shape: nm[2] });
        return;
      }
      // Edge: A > B | label   (also ->, <, ^, v)
      const em = l.match(/^([A-Za-z0-9_-]+)\s*(->|>|<|\^|v|V)\s*([A-Za-z0-9_-]+)(?:\s*\|\s*(.+))?$/);
      if (em) {
        let dir = em[2] === '->' ? '>' : (em[2] === 'V' ? 'v' : em[2]);
        // "A -> B" and "A > B" both mean B sits to the RIGHT of A
        edges.push({ from: em[1], to: em[3], dir, label: (em[4] || '').trim() });
        if (!nodes.has(em[1])) nodes.set(em[1], { id: em[1], label: em[1], shape: '[' });
        if (!nodes.has(em[3])) nodes.set(em[3], { id: em[3], label: em[3], shape: '[' });
        return;
      }
    });
    return { nodes, edges };
  }

  function layoutFlow(nodes, edges) {
    const DELTA = { '>': [1, 0], '<': [-1, 0], '^': [0, -1], 'v': [0, 1] };
    const ids = [...nodes.keys()];
    const pos = new Map();
    if (!ids.length) return pos;

    // roots = nodes with no incoming edges
    const inc = new Map(ids.map(i => [i, 0]));
    edges.forEach(e => inc.set(e.to, (inc.get(e.to) || 0) + 1));
    const roots = ids.filter(i => !inc.get(i));
    if (!roots.length) roots.push(ids[0]);

    // BFS processing order
    const order = [];
    const seen = new Set();
    const q = [...roots];
    while (q.length) {
      const n = q.shift();
      if (seen.has(n)) continue;
      seen.add(n);
      order.push(n);
      edges.filter(e => e.from === n).forEach(e => q.push(e.to));
    }
    ids.forEach(i => { if (!seen.has(i)) order.push(i); });

    // Initial placement: roots stacked vertically at column 0
    roots.forEach((r, i) => pos.set(r, { x: 0, y: i * 2 }));

    // Pass 1 — place unplaced nodes at the desired spot of their first incoming edge
    for (const e of edges) {
      if (!pos.has(e.from)) pos.set(e.from, { x: 0, y: pos.size * 2 });
      if (!pos.has(e.to)) {
        const d = DELTA[e.dir] || DELTA['>'];
        const p = pos.get(e.from);
        let x = p.x + d[0], y = p.y + d[1];
        // collision shove: move down until the cell is free
        while ([...pos.values()].some(c => c.x === x && c.y === y)) y += 1;
        pos.set(e.to, { x, y });
      }
    }
    ids.forEach(i => { if (!pos.has(i)) pos.set(i, { x: 0, y: pos.size * 2 }); });

    // Pass 2 — relaxation: pull nodes toward their direction targets, then
    // snap to a grid and resolve collisions. Repeated a few times so the
    // layout settles into a tidy arrangement that honors all 4 directions.
    const occupied = (p, skipId) => {
      for (const [id, c] of pos) { if (id !== skipId && c.x === p.x && c.y === p.y) return true; }
      return false;
    };
    for (let it = 0; it < 8; it++) {
      for (const e of edges) {
        if (roots.includes(e.to)) continue; // anchors stay put
        const a = pos.get(e.from), b = pos.get(e.to);
        const d = DELTA[e.dir] || DELTA['>'];
        const tx = a.x + d[0], ty = a.y + d[1];
        b.x += (tx - b.x) * 0.45;
        b.y += (ty - b.y) * 0.45;
      }
      // snap + de-collide in a stable order
      order.forEach(id => {
        const p = pos.get(id);
        p.x = Math.round(p.x); p.y = Math.round(p.y);
        while (occupied(p, id)) p.y += 1;
      });
    }

    // Normalize to 0-based
    const minX = Math.min(...[...pos.values()].map(p => p.x));
    const minY = Math.min(...[...pos.values()].map(p => p.y));
    pos.forEach(p => { p.x -= minX; p.y -= minY; });
    return pos;
  }

  function initializeFlows(rootEl) {
    rootEl.querySelectorAll('.flow-chart').forEach(el => {
      if (el.dataset.ready) return;
      el.dataset.ready = '1';
      let parsed;
      try { parsed = parseFlow(decodeURIComponent(el.dataset.flow)); }
      catch (e) { el.innerHTML = '<div class="swagger-error">Invalid flow data</div>'; return; }
      const { nodes, edges } = parsed;
      if (!nodes.size) { el.innerHTML = '<div class="swagger-error">Empty flowchart</div>'; return; }

      const pos = layoutFlow(nodes, edges);

      // --- geometry ---
      const pad = 16;
      const nodeW = (label) => Math.max(96, Math.min(240, label.length * 8.2 + 36));
      const H_SQUARE = 46, H_HEX = 46, H_CIRCLE = 52, H_DIAMOND = 74;
      const heightFor = (shape) => shape === '{' ? H_DIAMOND : shape === '(' ? H_CIRCLE : H_SQUARE;
      const colW = Math.max(...[...nodes.values()].map(n => nodeW(n.label))) + 64;
      const rowH = 84;
      const W = (id) => nodeW(nodes.get(id).label);
      const cx = (id) => pos.get(id).x * colW + colW / 2;
      const cy = (id) => pos.get(id).y * rowH + heightFor(nodes.get(id).shape) / 2;
      const maxX = Math.max(...[...pos.values()].map(p => p.x));
      const maxY = Math.max(...[...pos.values()].map(p => p.y));
      const svgW = (maxX + 1) * colW + pad * 2;
      const svgH = (maxY + 1) * rowH + Math.max(...[...nodes.values()].map(n => heightFor(n.shape))) + pad;

      let svg = `<svg viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" role="img" style="max-width:100%;height:auto;">`;
      svg += `<defs><marker id="lfa" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"/></marker></defs>`;

      // edges first (under nodes)
      edges.forEach(e => {
        const a = { x: cx(e.from), y: cy(e.from) };
        const b = { x: cx(e.to), y: cy(e.to) };
        const dx = b.x - a.x, dy = b.y - a.y;
        // pick anchor sides based on dominant direction
        let x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
        if (Math.abs(dx) >= Math.abs(dy)) { x1 = a.x + Math.sign(dx) * W(e.from) / 2; x2 = b.x - Math.sign(dx) * W(e.to) / 2; }
        else { y1 = a.y + Math.sign(dy) * heightFor(nodes.get(e.from).shape) / 2; y2 = b.y - Math.sign(dy) * heightFor(nodes.get(e.to).shape) / 2; }
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        const c1x = x1 + (mx - x1) * 0.5, c1y = y1, c2x = mx + (x2 - mx) * 0.5, c2y = y2;
        svg += `<path class="flow-edge" d="M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}" marker-end="url(#lfa)"/>`;
        if (e.label) {
          svg += `<rect class="flow-edge-label-bg" x="${mx - e.label.length * 3.4 - 4}" y="${my - 9}" width="${e.label.length * 6.8 + 8}" height="18" rx="4"/>`;
          svg += `<text class="flow-edge-label" x="${mx}" y="${my + 4}" text-anchor="middle">${escapeHtml(e.label)}</text>`;
        }
      });

      // nodes
      nodes.forEach(n => {
        const p = pos.get(n.id);
        const w = W(n.id), h = heightFor(n.shape);
        const x = p.x * colW + (colW - w) / 2 + pad;
        const y = p.y * rowH + (h === H_DIAMOND ? 12 : 6);
        const cxx = x + w / 2, cyy = y + h / 2;
        if (n.shape === '(') {
          svg += `<ellipse class="flow-node" cx="${cxx}" cy="${cyy}" rx="${w / 2}" ry="${h / 2}"/>`;
        } else if (n.shape === '{') {
          svg += `<polygon class="flow-node" points="${cxx},${y} ${x + w},${cyy} ${cxx},${y + h} ${x},${cyy}"/>`;
        } else if (n.shape === '<') {
          const cut = 14;
          svg += `<polygon class="flow-node" points="${x + cut},${y} ${x + w - cut},${y} ${x + w},${cyy} ${x + w - cut},${y + h} ${x + cut},${y + h} ${x},${cyy}"/>`;
        } else {
          svg += `<rect class="flow-node" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>`;
        }
        // wrap long labels into two lines
        const words = n.label.split(/\s+/);
        let lines = [], cur = '';
        words.forEach(wd => {
          if ((cur + ' ' + wd).trim().length > Math.floor(w / 8.2) && cur) { lines.push(cur); cur = wd; }
          else cur = (cur + ' ' + wd).trim();
        });
        if (cur) lines.push(cur);
        if (lines.length > 2) { lines = [lines[0], lines[1] + '…']; }
        lines.forEach((ln, li) => {
          svg += `<text class="flow-label" x="${cxx}" y="${cyy - (lines.length - 1) * 8 + li * 16 + 5}" text-anchor="middle">${escapeHtml(ln)}</text>`;
        });
      });

      svg += '</svg>';
      el.innerHTML = svg;
    });
  }

  let tocScrollBound = false;
  function renderTOC() {
    const headings = $$('#page .markdown h2, #page .markdown h3, #page .markdown h4');
    const list = $('#tocList');
    if (!headings.length) { list.innerHTML = '<li style="padding: 8px 10px; font-size: 11px; color: var(--text-muted);">No sections on this page.</li>'; return; }
    list.innerHTML = Array.from(headings).map(h => {
      const level = h.tagName.toLowerCase();
      const id = h.id;
      const text = h.textContent;
      return `<li><a class="toc-link level-${level.replace('h','')}" data-anchor="${id}" onclick="Lumen.scrollToAnchor('${id}')">${escapeHtml(text)}</a></li>`;
    }).join('');

    // Active heading on scroll — bind ONCE (rebinding on every render leaked listeners)
    if (!tocScrollBound) {
      const content = $('#content');
      content.addEventListener('scroll', debounce(updateActiveTOC, 80), { passive: true });
      tocScrollBound = true;
    }
  }

  function updateActiveTOC() {
    const headings = $$('#page .markdown h2, #page .markdown h3, #page .markdown h4');
    if (!headings.length) return;
    const scrollY = $('#content').scrollTop + 100;
    let active = headings[0];
    for (const h of headings) {
      if (h.offsetTop <= scrollY) active = h;
      else break;
    }
    $$('.toc-link').forEach(l => l.classList.toggle('active', l.dataset.anchor === active.id));
    // Update progress
    const total = $('#content').scrollHeight - $('#content').clientHeight;
    const pct = total > 0 ? Math.min(100, Math.round(($('#content').scrollTop / total) * 100)) : 100;
    $('#statusProgressBar').style.width = pct + '%';
  }

  function scrollToAnchor(id) {
    const el = document.getElementById(id);
    if (el) {
      const offsetTop = el.offsetTop - 80;
      $('#content').scrollTo({ top: offsetTop, behavior: 'smooth' });
    }
  }

  function renderSidebar() {
    const sidebar = $('#sidebar');
    // Group pages by section
    const sections = {};
    state.pages.forEach(p => {
      const s = p.section || 'Documentation';
      if (!sections[s]) sections[s] = [];
      sections[s].push(p);
    });

    let html = '';
    // Bookmarks section
    if (state.bookmarks.length) {
      html += `<div class="sidebar-section">
        <div class="sidebar-section-title"><span>★ Bookmarks</span><span class="count">${state.bookmarks.length}</span></div>`;
      state.bookmarks.forEach(id => {
        const p = state.pages.find(x => x.id === id);
        if (p) html += navItemHTML(p, true);
      });
      html += `</div>`;
    }

    // Sections
    Object.entries(sections).forEach(([section, pages]) => {
      html += `<div class="sidebar-section">
        <div class="sidebar-section-title"><span>${escapeHtml(section)}</span><span class="count">${pages.length}</span></div>`;
      pages.forEach(p => html += navItemHTML(p, false));
      html += `</div>`;
    });

    sidebar.innerHTML = html;

    // Click handlers
    $$('.nav-item').forEach(item => {
      item.addEventListener('click', () => go(item.dataset.page));
    });
  }

  function navItemHTML(p, isBookmark) {
    const active = p.id === state.currentPageId ? ' active' : '';
    const bookmarked = state.bookmarks.includes(p.id) ? ' bookmarked' : '';
    const tag = p.tag ? `<span class="nav-tag">${escapeHtml(p.tag)}</span>` : '';
    return `<a class="nav-item${active}${bookmarked}" data-page="${p.id}" title="${escapeHtml(p.title)}">
      <span class="nav-icon">${p.icon || '📄'}</span>
      <span class="nav-label">${escapeHtml(p.title)}</span>
      ${tag}
    </a>`;
  }

  function renderStatusbar() {
    const page = state.pages.find(p => p.id === state.currentPageId);
    if (!page) return;
    const idx = state.pages.findIndex(p => p.id === state.currentPageId);
    const total = state.pages.length;
    $('#statusPage').textContent = `${idx + 1} / ${total} · ${page.title}`;
    $('#statusWords').textContent = `${wordCount(page.content || '').toLocaleString()} words`;
    $('#statusReading').textContent = `${readingTime(page.content || '')} min read`;
    $('#statusLang').textContent = (page.dir || state.settings.dir).toUpperCase();
    const last = state.lastVisited[page.id];
    $('#statusLastVisited').textContent = last ? `Last visited ${timeAgo(last)}` : '';
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  }

  // -------- Themes --------
  const THEMES = ['midnight', 'glass', 'daylight', 'sepia', 'terminal'];
  function setTheme(theme) {
    state.settings.theme = theme;
    document.body.setAttribute('data-theme', theme);
    $('#themeVal').textContent = theme;
    save();
    renderThemeGrid();
    // Keep Mermaid diagrams in sync with light/dark themes
    if (window.mermaid) {
      const light = theme === 'daylight' || theme === 'sepia';
      try {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: light ? 'default' : 'dark' });
        if (state.currentPageId && $('#page .mermaid')) renderPage(state.currentPageId);
      } catch (e) { /* non-fatal */ }
    }
  }
  function cycleTheme() {
    const i = THEMES.indexOf(state.settings.theme);
    setTheme(THEMES[(i + 1) % THEMES.length]);
    toast(`Theme: ${THEMES[(i + 1) % THEMES.length]}`);
  }
  function renderThemeGrid() {
    const grid = $('#themeGrid');
    const swatches = {
      midnight: 'linear-gradient(135deg, #0e0e12, #18181d)',
      glass: 'linear-gradient(135deg, #0f0c29, #302b63)',
      daylight: 'linear-gradient(135deg, #fafaf7, #ffffff)',
      sepia: 'linear-gradient(135deg, #f4ecd8, #fbf3df)',
      terminal: 'linear-gradient(135deg, #000, #0a1a0a)',
    };
    grid.innerHTML = THEMES.map(t => `
      <div class="theme-card ${state.settings.theme === t ? 'active' : ''}" data-theme="${t}">
        <div class="swatch" style="background: ${swatches[t]}; border: 1px solid var(--border);"></div>
        <div>${t}</div>
      </div>
    `).join('');
    $$('.theme-card').forEach(c => c.addEventListener('click', () => setTheme(c.dataset.theme)));
  }

  // -------- Settings --------
  function applySettings() {
    document.body.setAttribute('data-theme', state.settings.theme);
    document.documentElement.setAttribute('dir', state.settings.dir);
    document.documentElement.style.setProperty('--base-font-size', state.settings.font + 'px');
    // Density: always set BOTH values (previously switching back to comfortable
    // never reset the compact value — a small but real bug)
    const compact = state.settings.density === 'compact';
    document.documentElement.style.setProperty('--density-pad', compact ? '0.7em' : '1em');
    document.documentElement.style.setProperty('--density-gap', compact ? '0.7em' : '1em');
    applyAccent();
    applyCustomCss();
    applyViewMode();
    $('#themeVal').textContent = state.settings.theme;
    $('#fontVal').textContent = state.settings.font + 'px';
    $('#dirVal').textContent = state.settings.dir.toUpperCase();
    $('#densityVal').textContent = state.settings.density;
    $('#fontSlider').value = state.settings.font;
    renderThemeGrid();
  }

  // -------- Customization: accent color + custom CSS --------
  function applyAccent() {
    const c = state.settings.accent;
    const root = document.documentElement;
    if (!c) {
      // reset to theme defaults
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-bright');
      root.style.removeProperty('--accent-dim');
      root.style.removeProperty('--accent-glow');
    } else {
      root.style.setProperty('--accent', c);
      root.style.setProperty('--accent-bright', c);
      root.style.setProperty('--accent-dim', `color-mix(in srgb, ${c} 18%, transparent)`);
      root.style.setProperty('--accent-glow', `color-mix(in srgb, ${c} 35%, transparent)`);
    }
    const picker = $('#accentColor');
    if (picker) picker.value = c || '#d4af7f';
  }

  function applyCustomCss() {
    let el = document.getElementById('lumenCustomCss');
    if (!el) {
      el = document.createElement('style');
      el.id = 'lumenCustomCss';
      document.head.appendChild(el);
    }
    el.textContent = state.settings.customCss || '';
  }

  function setAccent(color) {
    state.settings.accent = color || '';
    applyAccent();
    save();
  }

  function setCustomCss(css) {
    state.settings.customCss = css || '';
    applyCustomCss();
    save();
  }

  // -------- Viewer mode (read-only for people who just read) --------
  function applyViewMode() {
    document.body.classList.toggle('view-mode', !!state.settings.viewMode);
    const btn = $('#toggleViewMode');
    if (btn) {
      btn.classList.toggle('is-on', !!state.settings.viewMode);
      btn.title = state.settings.viewMode ? 'Viewer mode is ON — click to enable editing [V]' : 'Toggle viewer mode (hide all editing UI) [V]';
    }
  }

  function toggleViewMode() {
    state.settings.viewMode = !state.settings.viewMode;
    applyViewMode();
    save();
    renderCmd($('#cmdInput').value || '');
    toast(state.settings.viewMode ? '🔒 Viewer mode — editing hidden. Press V to get it back.' : '🔓 Editor mode enabled', state.settings.viewMode ? '🔒' : '🔓');
  }

  function setDir(dir) {
    state.settings.dir = dir;
    applySettings();
    save();
  }

  function setFont(val) {
    state.settings.font = parseInt(val);
    applySettings();
    save();
  }

  function setDensity(d) {
    state.settings.density = d;
    applySettings();
    save();
  }

  // -------- Export / Import --------
  async function exportMarkdown() {
    if (!window.JSZip) { toast('JSZip not loaded'); return; }
    const zip = new JSZip();
    const docsFolder = zip.folder('docs');
    const assetsFolder = zip.folder('assets');

    // Build index
    let indexText = `# ${document.title}\n\nExported: ${new Date().toISOString()}\n\n## Contents\n\n`;
    state.pages.forEach((p, i) => {
      const num = String(i + 1).padStart(2, '0');
      const slug = slugify(p.title);
      const filename = `${num}-${slug}.md`;
      const frontmatter = `---\ntitle: ${p.title}\nsection: ${p.section || ''}\nicon: ${p.icon || '📄'}\ntags: ${(p.tags || []).join(', ')}\ndir: ${p.dir || state.settings.dir}\norder: ${i + 1}\n---\n\n`;
      docsFolder.file(filename, frontmatter + (p.content || ''));
      indexText += `${i + 1}. [${p.title}](${filename})\n`;
    });

    // Extract images embedded as data URLs into assets folder
    let assetCount = 0;
    state.pages.forEach(p => {
      const matches = (p.content || '').match(/!\[[^\]]*\]\(data:image[^)]+\)/g) || [];
      matches.forEach((m, idx) => {
        const dataMatch = m.match(/data:image\/(\w+);base64,([^)]+)/);
        if (dataMatch) {
          const ext = dataMatch[1] === 'jpeg' ? 'jpg' : dataMatch[1];
          const b64 = dataMatch[2];
          const assetName = `${slugify(p.title)}-${idx + 1}.${ext}`;
          assetsFolder.file(assetName, b64, { base64: true });
          assetCount++;
        }
      });
    });

    // README
    docsFolder.file('README.md', `# Lumen Documentation Export\n\nThis folder contains ${state.pages.length} markdown pages exported from a Lumen single-file documentation.\n\n## Structure\n\n- \`docs/\` — All pages as numbered .md files with frontmatter\n- \`assets/\` — Embedded images extracted as files\n\n## Re-import\n\nYou can drag these .md files back into Lumen to restore the documentation.\n\nGenerated: ${new Date().toISOString()}\n`);

    zip.file('INDEX.md', indexText);
    zip.file('lumen-data.json', JSON.stringify({
      pages: state.pages,
      bookmarks: state.bookmarks,
      annotations: state.annotations,
      version: 1,
      exportedAt: new Date().toISOString(),
    }, null, 2));

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lumen-docs-${new Date().toISOString().slice(0,10)}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`Exported ${state.pages.length} pages, ${assetCount} assets`);
  }

  function exportJSON() {
    const data = { pages: state.pages, bookmarks: state.bookmarks, annotations: state.annotations, doc: state.doc, fileStore: fileStore, version: 1, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lumen-data-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Exported JSON backup');
  }

  function importJSON() { $('#jsonInput').click(); }

  // -------- Export single standalone HTML --------
  // Produces a complete .html file with the user's pages + metadata embedded.
  // The exported file is a runnable Lumen instance — open it anywhere.
  function exportSingleHTML() {
    toast('Building standalone HTML…');

    // 1) Build a CLEAN clone of the current document (no transient UI state,
    //    no runtime-injected nodes) so the export is a pristine boot file.
    const clone = document.documentElement.cloneNode(true);
    // remove dynamic nodes that will be re-created at boot
    clone.querySelectorAll('#fileProgressOverlay, #lumenCustomCss, style[data-lumen-lib-css], script[data-lumen-lib]').forEach(n => n.remove());
    // reset body state classes
    const cloneBody = clone.querySelector('body');
    if (cloneBody) cloneBody.removeAttribute('class');
    // reset overlays + loading screen
    clone.querySelectorAll('.modal-overlay, .cmd-overlay, .grid-view, .editor-overlay, .zoom-overlay, .search-results, .editor-drophint')
      .forEach(el => el.classList.remove('open'));
    const loading = clone.querySelector('#loading');
    if (loading) loading.classList.remove('hidden');
    // clear runtime-rendered content (it is rebuilt from the embedded pages)
    ['page', 'sidebar', 'tocList', 'gridContainer', 'editorPreview', 'versionsList', 'cmdResults', 'searchResults'].forEach(id => {
      const el = clone.querySelector('#' + id);
      if (el) el.innerHTML = '';
    });
    const editorText = clone.querySelector('#editorText');
    if (editorText) editorText.textContent = '';
    // reset scroll-dependent attributes on dynamic widgets
    clone.querySelectorAll('[data-slider]').forEach(el => el.remove());
    clone.querySelectorAll('.tour, .flow-chart').forEach(el => el.remove());

    let fullHtml = '<!DOCTYPE html>\n' + clone.outerHTML;

    // 2) Build the embedded content block
    const pagesToEmbed = state.pages.map(p => ({
      id: p.id,
      title: p.title,
      subtitle: p.subtitle || '',
      section: p.section || 'Documentation',
      icon: p.icon || '📄',
      tags: p.tags || [],
      dir: p.dir || state.settings.dir,
      layout: p.layout,
      content: p.content || '',
    }));
    const docMeta = { ...state.doc };
    const settingsToEmbed = { ...state.settings };
    const fileStoreToEmbed = { ...fileStore };

    // IMPORTANT: escape any literal closing-script sequence inside the JSON
    // payloads, otherwise one written in a page would terminate the embedded
    // script tag early and corrupt the export. (The escaped form is identical
    // once JS parses the string.)
    const safe = (json) => json.replace(/<\x2fscript/gi, '<\\/script');
    const pagesJson = safe(JSON.stringify(pagesToEmbed, null, 2));
    const docMetaJson = safe(JSON.stringify(docMeta, null, 2));
    const settingsJson = safe(JSON.stringify(settingsToEmbed, null, 2));
    const fileStoreJson = safe(JSON.stringify(fileStoreToEmbed, null, 2));

    // Build replacement script block. Split the closing tag so the HTML parser
    // does not prematurely close our own script.
    const replacementBlock = '<!-- EMBEDDED DOCUMENTATION CONTENT (generated by Lumen export) -->\n'
      + '<scr' + 'ipt>\n'
      + 'window.__LUMEN_DEFAULT_PAGES__ = ' + pagesJson + ';\n'
      + 'window.__LUMEN_DOC_META__ = ' + docMetaJson + ';\n'
      + 'window.__LUMEN_DEFAULT_SETTINGS__ = ' + settingsJson + ';\n'
      + 'window.__LUMEN_FILE_STORE__ = ' + fileStoreJson + ';\n'
      + '</scr' + 'ipt>';

    // 3) Replace the documentation content block (handles both original and previously-exported markers)
    // The pattern below uses an escaped slash in the closing-tag part so the
    // HTML parser never sees a real terminator inside this engine script.
    const markerRegex = /<!-- (?:DEFAULT|EMBEDDED) DOCUMENTATION CONTENT[^>]*-->\s*<script>[\s\S]*?<\x2fscript>/;
    let newHtml = fullHtml;
    if (!markerRegex.test(newHtml)) {
      toast('Export failed: documentation block not found', '⚠');
      return;
    }
    newHtml = newHtml.replace(markerRegex, () => replacementBlock);

    // 4) Update static fallback text (visible before JS runs)
    newHtml = newHtml.replace(/<title>[^<]*<\/title>/,
      '<title>' + escapeHtml(state.doc.name + (state.doc.description ? ' · ' + state.doc.description : '')) + '<\/title>');
    newHtml = newHtml.replace(/<meta name="description" content="[^"]*">/,
      '<meta name="description" content="' + escapeHtml(state.doc.description || state.doc.name) + '">');
    newHtml = newHtml.replace(/<span class="brand-text">[^<]*<\/span>/,
      '<span class="brand-text">' + escapeHtml(state.doc.name) + '<\/span>');
    newHtml = newHtml.replace(/<span class="brand-version">[^<]*<\/span>/,
      '<span class="brand-version">' + escapeHtml(state.doc.version ? 'v' + state.doc.version : '') + '<\/span>');
    newHtml = newHtml.replace(/<div class="loading-text">[^<]*<\/div>/,
      '<div class="loading-text">' + escapeHtml('Loading ' + state.doc.name) + '<\/div>');
    newHtml = newHtml.replace(/<div class="loader-brand">[^<]*<\/div>/,
      '<div class="loader-brand">' + escapeHtml((state.doc.name || 'LUMEN').toUpperCase() + ' · DOCUMENTATION') + '<\/div>');

    // 5) Trigger download
    const blob = new Blob([newHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = slugify(state.doc.name || 'documentation') + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const kb = Math.round(newHtml.length / 1024);
    toast('Exported standalone HTML (' + (kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB') + ')');
  }

  // -------- New document from scratch --------
  function openNewDocModal() {
    // Pre-fill with defaults if user hasn't customized, else current values
    $('#newDocName').value = state.doc.name !== 'Lumen' ? state.doc.name : 'My Documentation';
    $('#newDocDesc').value = state.doc.description !== 'A single-file static documentation engine' ? state.doc.description : '';
    $('#newDocVersion').value = state.doc.version !== '1.0' ? state.doc.version : '1.0';
    $('#newDocIcon').value = state.doc.icon !== '✦' ? state.doc.icon : '📚';
    $('#newDocModal').classList.add('open');
    setTimeout(() => $('#newDocName').focus(), 50);
  }

  function confirmNewDoc() {
    const name = $('#newDocName').value.trim() || 'My Documentation';
    const desc = $('#newDocDesc').value.trim();
    const version = $('#newDocVersion').value.trim() || '1.0';
    const icon = $('#newDocIcon').value.trim() || '📚';

    if (state.pages.length) snapshot('Before new document "' + name + '"');
    state.doc = { name, description: desc, version, author: state.doc.author || '', icon };
    state.pages = [{
      id: 'cover',
      title: name,
      subtitle: desc,
      section: 'Start',
      icon: icon,
      tags: [],
      dir: state.settings.dir,
      layout: 'cover',
      content: '> ' + (desc || 'Welcome to your new documentation.') + '\n\n'
        + 'This is the cover page. Edit it with the pencil icon, or delete it and start fresh.\n\n'
        + '## Get started\n\n'
        + '- Press [kbd:E] to create a new page\n'
        + '- Press [kbd:⌘K] to open the command palette\n'
        + '- Press [kbd:⌘S] to save in the editor\n'
        + '- Click the gear icon for settings, themes, and document metadata\n'
        + '- Press [kbd:G] to see all pages in the grid view\n\n'
        + ':::tip\n'
        + 'Everything you write is saved to your browser automatically. Use **Export** in the top bar to save your work as a standalone HTML file or a zip of markdown.\n'
        + ':::\n',
    }];
    state.bookmarks = [];
    state.annotations = {};
    state.lastVisited = {};
    state.currentPageId = null;

    applyDocSettings();
    buildSearchIndex();
    save();
    renderSidebar();
    go('cover');
    $('#newDocModal').classList.remove('open');
    toast('Created new document: ' + name);
  }

  // -------- Universal delete page --------
  // Used by the editor, the grid view, and any other UI that needs to delete a page.
  function deletePage(pageId) {
    if (!pageId) return false;
    const page = state.pages.find(p => p.id === pageId);
    if (!page) return false;
    // Confirm before deleting
    if (!confirm('Delete "' + page.title + '"? A snapshot is taken first, so you can restore it from History (H).')) return false;
    snapshot('Before deleting "' + page.title + '"');
    // Remove from pages
    state.pages = state.pages.filter(p => p.id !== pageId);
    // Remove from bookmarks
    const bmIdx = state.bookmarks.indexOf(pageId);
    if (bmIdx >= 0) state.bookmarks.splice(bmIdx, 1);
    // Remove from last visited
    delete state.lastVisited[pageId];
    // Clean up files no longer referenced
    gcFiles();
    // Rebuild search index
    buildSearchIndex();
    save();
    renderSidebar();
    // Navigate away if we're on the deleted page
    if (state.currentPageId === pageId) {
      if (state.pages.length > 0) {
        go(state.pages[0].id);
      } else {
        // No pages left — create a default cover
        state.pages.push({
          id: 'cover',
          title: state.doc.name || 'Untitled',
          section: 'Start',
          icon: state.doc.icon || '📄',
          dir: state.settings.dir,
          layout: 'cover',
          content: '# ' + (state.doc.name || 'Untitled') + '\n\nNo pages yet. Press E to create one.\n',
        });
        save();
        renderSidebar();
        go('cover');
      }
    }
    toast('Page deleted — restore it anytime with H (History)');
    return true;
  }

  async function handleFileImport(files) {
    const newPages = [];
    for (const file of files) {
      if (file.name.endsWith('.md') || file.name.endsWith('.markdown') || file.name.endsWith('.txt')) {
        const text = await file.text();
        const { meta, body } = parseFrontmatter(text);
        const title = meta.title || file.name.replace(/\.(md|markdown|txt)$/, '');
        newPages.push({
          id: slugify(title) + '-' + Math.random().toString(36).slice(2, 6),
          title,
          section: meta.section || 'Imported',
          icon: meta.icon || '📄',
          tags: meta.tags ? meta.tags.split(',').map(s => s.trim()).filter(Boolean) : [],
          dir: meta.dir || state.settings.dir,
          content: body,
        });
      }
    }
    if (newPages.length === 0) { toast('No .md files found'); return; }
    state.pages.push(...newPages);
    buildSearchIndex();
    save();
    renderSidebar();
    toast(`Imported ${newPages.length} pages`);
  }

  function parseFrontmatter(text) {
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) return { meta: {}, body: text };
    const meta = {};
    m[1].split('\n').forEach(line => {
      const idx = line.indexOf(':');
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return { meta, body: m[2] };
  }

  // -------- Editor --------
  let editingPageId = null;
  let katexLoaded = false;

  // Lazy-load KaTeX only when math content is detected (through the offline-capable loader)
  function ensureKatexLoaded() {
    if (katexLoaded || window.katex) { katexLoaded = true; return Promise.resolve(); }
    if (window.LumenLibs) {
      return window.LumenLibs.ensure(['katex-js', 'katex-css']).then(() => {
        katexLoaded = !!window.katex;
        if (!katexLoaded) console.warn('KaTeX failed to load');
      });
    }
    return Promise.resolve();
  }

  function openEditor(pageId) {
    if (state.settings.viewMode) { toast('Viewer mode is on — press V to enable editing', '🔒'); return; }
    editingPageId = pageId || null;
    const page = pageId ? state.pages.find(p => p.id === pageId) : null;
    $('#editorTitle').value = page ? page.title : '';
    $('#editorIcon').value = page ? (page.icon || '📄') : '📄';
    $('#editorSection').value = page ? (page.section || '') : '';
    $('#editorText').value = page ? (page.content || '') : '# New Page\n\nStart writing markdown…\n';
    $('#editorDelete').style.display = page ? 'block' : 'none';
    // Show toolbar by default
    $('#editorToolbar').classList.remove('hidden');
    $('#editorOverlay').classList.add('open');
    updateEditorPreview();
    // Use oninput to avoid stacking listeners
    $('#editorText').oninput = debounce(() => {
      updateEditorPreview();
      // Lazy-load KaTeX if math is detected
      const text = $('#editorText').value;
      if ((text.includes('$$') || text.includes('\\(') || text.includes('\\[')) && !katexLoaded) {
        ensureKatexLoaded().then(updateEditorPreview);
      }
    }, 200);
    setTimeout(() => $('#editorTitle').focus(), 50);
  }
  function closeEditor() {
    $('#editorOverlay').classList.remove('open');
    $('#pageLinkDropdown').classList.remove('open');
    editingPageId = null;
  }
  function updateEditorPreview() {
    const text = $('#editorText').value;
    $('#editorPreview').innerHTML = renderMarkdown(text);
    // Initialize sliders in preview
    $('#editorPreview').querySelectorAll('.slider').forEach(s => initializeSlider(s));
    // Walkthroughs + flowcharts in preview
    initializeTours($('#editorPreview'));
    initializeFlows($('#editorPreview'));
    // If KaTeX was not loaded at render time, math-placeholder elements exist — load KaTeX and render them
    const preview = $('#editorPreview');
    if (preview.querySelector('.math-placeholder')) {
      ensureKatexLoaded().then(() => renderMathPlaceholders(preview));
    }
  }
  function saveEditorPage() {
    const title = $('#editorTitle').value.trim() || 'Untitled';
    const icon = $('#editorIcon').value.trim() || '📄';
    const section = $('#editorSection').value.trim() || 'Documentation';
    const content = $('#editorText').value;
    // Auto-detect direction based on content (Persian/Arabic → rtl, else ltr)
    const detectedDir = detectDirection(content);
    let isNew = false;
    if (editingPageId) {
      const p = state.pages.find(x => x.id === editingPageId);
      if (p) { p.title = title; p.icon = icon; p.section = section; p.content = content; p.dir = detectedDir; }
    } else {
      const id = slugify(title) + '-' + Math.random().toString(36).slice(2, 6);
      state.pages.push({ id, title, icon, section, content, tags: [], dir: detectedDir });
      editingPageId = id;
      isNew = true;
    }
    buildSearchIndex();
    save();
    renderSidebar();
    if (isNew) go(editingPageId);              // navigate to the newly created page
    else if (state.currentPageId === editingPageId || !state.currentPageId) renderPage(editingPageId);
    toast('Page saved');
    closeEditor();
  }
  function deleteEditorPage() {
    if (!editingPageId) return;
    const pageIdToDelete = editingPageId;
    closeEditor();
    deletePage(pageIdToDelete);
  }

  // -------- Formatting toolbar --------
  function applyFormat(fmt) {
    const ta = $('#editorText');
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const before = ta.value.substring(0, start);
    const after = ta.value.substring(end);
    let snippet = '';
    let placeholder = '';
    let cursorAtEnd = false;

    switch (fmt) {
      case 'h1': snippet = `\n# ${selected || 'Heading 1'}\n`; placeholder = 'Heading 1'; break;
      case 'h2': snippet = `\n## ${selected || 'Heading 2'}\n`; placeholder = 'Heading 2'; break;
      case 'h3': snippet = `\n### ${selected || 'Heading 3'}\n`; placeholder = 'Heading 3'; break;
      case 'bold': snippet = `**${selected || 'bold text'}**`; placeholder = 'bold text'; break;
      case 'italic': snippet = `*${selected || 'italic text'}*`; placeholder = 'italic text'; break;
      case 'strike': snippet = `~~${selected || 'strikethrough'}~~`; placeholder = 'strikethrough'; break;
      case 'code': snippet = `\`${selected || 'code'}\``; placeholder = 'code'; break;
      case 'link': snippet = `[${selected || 'link text'}](https://)`; placeholder = 'link text'; break;
      case 'image': snippet = `![${selected || 'alt text'}](https://)`; placeholder = 'alt text'; break;
      case 'codeblock': snippet = `\n\`\`\`js\n${selected || '// code here'}\n\`\`\`\n`; placeholder = '// code here'; break;
      case 'quote': snippet = `\n> ${selected || 'Quote text'}\n`; placeholder = 'Quote text'; break;
      case 'hr': snippet = `\n---\n`; cursorAtEnd = true; break;
      case 'table': snippet = `\n| Header 1 | Header 2 | Header 3 |\n|----------|----------|----------|\n| Cell 1   | Cell 2   | Cell 3   |\n| Cell 4   | Cell 5   | Cell 6   |\n`; cursorAtEnd = true; break;
      case 'math': snippet = `$$\n${selected || 'E = mc^2'}\n$$`; placeholder = 'E = mc^2'; if (!katexLoaded) ensureKatexLoaded().then(updateEditorPreview); break;
      case 'callout-tip': snippet = `\n:::tip\n${selected || 'Helpful tip here'}\n:::\n`; placeholder = 'Helpful tip here'; break;
      case 'callout-warning': snippet = `\n:::warning\n${selected || 'Warning text here'}\n:::\n`; placeholder = 'Warning text here'; break;
      case 'badge': snippet = `[badge:success:${selected || 'Label'}]`; placeholder = 'Label'; break;
      case 'slider': snippet = `\n:::slider\n![Image 1](https://picsum.photos/800/400?random=1)\n![Image 2](https://picsum.photos/800/400?random=2)\n![Image 3](https://picsum.photos/800/400?random=3)\n:::\n`; cursorAtEnd = true; break;
      case 'mermaid': snippet = `\n\`\`\`mermaid\ngraph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Action 1]\n  B -->|No| D[Action 2]\n  C --> E[End]\n  D --> E\n\`\`\`\n`; cursorAtEnd = true; break;
      case 'flow': snippet = `\n:::flow\nSTART[Start]\nCHECK{Ready?}\nLOAD<Load config>\nSAVE(Save result)\nSTART > CHECK\nCHECK v LOAD | yes\nCHECK > SAVE | no\nLOAD > SAVE\n:::\n`; cursorAtEnd = true; break;
      case 'tour': snippet = `\n:::tour\n![Step 1 — click the gear icon](https://picsum.photos/800/450?random=10) 88%,12% -> 2\n![Step 2 — the settings panel](https://picsum.photos/800/450?random=11)\n:::\n`; cursorAtEnd = true; break;
      case 'embed': snippet = `\n:::embed\nhttps://www.youtube.com/embed/aqz-KE-bpKQ\n:::\n`; cursorAtEnd = true; break;
    }

    ta.value = before + snippet + after;
    // Position cursor
    if (selected) {
      // If there was a selection, place cursor after the inserted snippet
      ta.selectionStart = ta.selectionEnd = start + snippet.length;
    } else if (cursorAtEnd) {
      ta.selectionStart = ta.selectionEnd = start + snippet.length;
    } else if (placeholder) {
      // Select the placeholder text so user can type to replace it
      const phIdx = snippet.indexOf(placeholder);
      if (phIdx >= 0) {
        ta.selectionStart = start + phIdx;
        ta.selectionEnd = start + phIdx + placeholder.length;
      }
    }
    ta.focus();
    updateEditorPreview();
  }

  // -------- Page link dropdown --------
  function togglePageLinkDropdown() {
    const dropdown = $('#pageLinkDropdown');
    const btn = $('#tbPageLink');
    if (dropdown.classList.contains('open')) {
      dropdown.classList.remove('open');
      return;
    }
    // Build list of pages (excluding the one being edited)
    const pages = state.pages.filter(p => p.id !== editingPageId);
    if (!pages.length) {
      dropdown.innerHTML = '<div class="page-link-item" style="color: var(--text-muted);">No other pages yet</div>';
    } else {
      dropdown.innerHTML = pages.map(p =>
        `<div class="page-link-item" data-page-id="${p.id}" data-page-title="${escapeHtml(p.title)}">
          <span class="pl-icon">${p.icon || '📄'}</span>
          <span>${escapeHtml(p.title)}</span>
          <span class="pl-section">${escapeHtml(p.section || '')}</span>
        </div>`
      ).join('');
      dropdown.querySelectorAll('.page-link-item').forEach(item => {
        item.addEventListener('click', () => {
          const title = item.dataset.pageTitle;
          const id = item.dataset.pageId;
          insertPageLink(title, id);
          dropdown.classList.remove('open');
        });
      });
    }
    // Position dropdown below the button
    const rect = btn.getBoundingClientRect();
    const overlayRect = $('#editorOverlay').getBoundingClientRect();
    dropdown.style.top = (rect.bottom - overlayRect.top + 4) + 'px';
    dropdown.style.left = (rect.left - overlayRect.left) + 'px';
    dropdown.classList.add('open');
  }

  function insertPageLink(title, pageId) {
    const ta = $('#editorText');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.substring(start, end);
    const linkText = selected || title;
    const snippet = `[${linkText}](page://${pageId})`;
    ta.value = ta.value.substring(0, start) + snippet + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + snippet.length;
    ta.focus();
    updateEditorPreview();
  }

  // -------- Drag-and-drop file upload --------
  // Dropped files are stored in fileStore (in memory + IndexedDB).
  // The editor source gets a SHORT reference like ![name](file://abc123) — no base64 clutter.
  // At render time, resolveFileRefs() swaps file:// back to the data URL.
  async function handleFileDrop(files) {
    const ta = $('#editorText');
    const fileArr = Array.from(files);
    // Show progress overlay
    showFileProgress(fileArr.length);
    for (let i = 0; i < fileArr.length; i++) {
      const file = fileArr[i];
      updateFileProgress(i, fileArr.length, file.name, 0);
      try {
        const snippet = await fileToMarkdownSnippet(file, (pct) => updateFileProgress(i, fileArr.length, file.name, pct));
        if (snippet) {
          const start = ta.selectionStart;
          const end = ta.selectionEnd;
          ta.value = ta.value.substring(0, start) + '\n' + snippet + '\n' + ta.value.substring(end);
          ta.selectionStart = ta.selectionEnd = start + snippet.length + 2;
        }
      } catch (e) {
        toast('Failed to process ' + file.name + ': ' + e.message, '⚠');
      }
      updateFileProgress(i + 1, fileArr.length, file.name, 100);
    }
    hideFileProgress();
    ta.focus();
    updateEditorPreview();
    save(); // persist docs (files persist to IndexedDB via saveFileToStore)
    updateStorageStats();
  }

  // Downscale big raster images (screenshots, photos) so uploads stay small.
  // Returns a smaller JPEG data URL, or null if compression isn't wanted/won't help.
  async function compressImage(file) {
    if (state.settings.compressImages === false) return null;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return null;      // gif/svg keep animation/vectors
    if (file.size < 300 * 1024) return null;                              // already small
    const MAX_W = 1600;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, MAX_W / bmp.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);                    // flatten transparency for JPEG
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      if (bmp.close) bmp.close();
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      return dataUrl.length < file.size ? dataUrl : null;                 // keep original if no gain
    } catch (e) { return null; }
  }

  async function fileToMarkdownSnippet(file, onProgress) {
    const name = file.name;
    const ext = name.split('.').pop().toLowerCase();
    const baseName = name.replace(/\.[^.]+$/, '');
    const sizeKB = Math.round(file.size / 1024);

    // Warn for very large files — they now go to IndexedDB (large quota),
    // but exports and page loads will still feel their weight.
    if (file.size > 8 * 1024 * 1024) {
      toast('⚠ ' + name + ' is ' + Math.round(sizeKB / 1024) + 'MB — consider trimming large media', '⚠');
    }

    // Binary media files (image/audio/video/pdf) — store in fileStore, return short reference
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
    const audioExts = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];
    const videoExts = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogv'];

    if (imageExts.includes(ext) || audioExts.includes(ext) || videoExts.includes(ext) || ext === 'pdf') {
      let dataUrl = await fileToDataUrl(file, onProgress);
      // Try to shrink big images first (fixes the "too large uploads" problem at the source)
      const compressed = await compressImage(file);
      if (compressed && imageExts.includes(ext)) {
        const saved = Math.round((1 - compressed.length / dataUrl.length) * 100);
        if (saved > 10) {
          dataUrl = compressed;
          toast('Compressed ' + name + ' by ' + saved + '%', '🗜');
        }
      }
      const id = saveFileToStore(name, ext, dataUrl);
      const fileRef = 'file://' + id;
      if (imageExts.includes(ext)) {
        return `![${baseName}](${fileRef})`;
      } else if (audioExts.includes(ext)) {
        return `<audio controls src="${fileRef}"></audio>`;
      } else if (videoExts.includes(ext)) {
        return `<video controls src="${fileRef}"></video>`;
      } else if (ext === 'pdf') {
        return `<div class="pdf-embed"><embed src="${fileRef}" type="application/pdf" width="100%" height="600"></div>`;
      }
    }

    // CSV — render as a markdown table (text-based, no need for fileStore)
    if (ext === 'csv' || ext === 'tsv') {
      const text = await file.text();
      const delimiter = ext === 'tsv' ? '\t' : ',';
      const rows = text.trim().split('\n').map(r => r.split(delimiter));
      if (rows.length < 2) return '```csv\n' + text + '\n```';
      const header = rows[0];
      const separator = header.map(() => '---');
      let table = '| ' + header.join(' | ') + ' |\n';
      table += '| ' + separator.join(' | ') + ' |\n';
      rows.slice(1).forEach(row => {
        while (row.length < header.length) row.push('');
        table += '| ' + row.join(' | ') + ' |\n';
      });
      return table;
    }

    // LaTeX (.tex) — embed as display math, lazy-load KaTeX
    if (ext === 'tex' || ext === 'latex') {
      const text = await file.text();
      if (!katexLoaded) ensureKatexLoaded().then(updateEditorPreview);
      return `$$\n${text.trim()}\n$$`;
    }

    // Markdown / text — insert as content
    if (['md', 'markdown', 'txt'].includes(ext)) {
      const text = await file.text();
      return text;
    }

    // JSON — insert as code block
    if (ext === 'json') {
      const text = await file.text();
      return '```json\n' + text + '\n```';
    }

    // Code files — insert as code block with language hint
    const codeExts = { 'js': 'javascript', 'ts': 'typescript', 'py': 'python', 'rb': 'ruby', 'go': 'go', 'rs': 'rust', 'java': 'java', 'c': 'c', 'cpp': 'cpp', 'cs': 'csharp', 'php': 'php', 'sh': 'bash', 'yml': 'yaml', 'yaml': 'yaml', 'xml': 'xml', 'html': 'html', 'css': 'css', 'sql': 'sql' };
    if (codeExts[ext]) {
      const text = await file.text();
      return '```' + codeExts[ext] + '\n' + text + '\n```';
    }

    // Unknown — insert as plain text
    const text = await file.text();
    return '```\n' + text + '\n```';
  }

  // Read a file as a data URL with progress reporting
  function fileToDataUrl(file, onProgress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      reader.onload = () => {
        if (onProgress) onProgress(100);
        resolve(reader.result);
      };
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }

  // -------- File progress overlay --------
  function showFileProgress(fileCount) {
    let overlay = document.getElementById('fileProgressOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'fileProgressOverlay';
      overlay.className = 'file-progress-overlay';
      overlay.innerHTML = `
        <div class="file-progress-card">
          <div class="file-progress-icon">📎</div>
          <div class="file-progress-text" id="fileProgressText">Processing files…</div>
          <div class="file-progress-bar-bg"><div class="file-progress-bar" id="fileProgressBar"></div></div>
          <div class="file-progress-meta" id="fileProgressMeta"></div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    overlay.classList.add('open');
    overlay.querySelector('#fileProgressBar').style.width = '0%';
    overlay.querySelector('#fileProgressText').textContent = fileCount === 1 ? 'Processing file…' : `Processing ${fileCount} files…`;
    overlay.querySelector('#fileProgressMeta').textContent = '';
  }

  function updateFileProgress(current, total, fileName, pct) {
    const overlay = document.getElementById('fileProgressOverlay');
    if (!overlay) return;
    const overallPct = total === 1 ? pct : Math.round(((current + pct / 100) / total) * 100);
    overlay.querySelector('#fileProgressBar').style.width = overallPct + '%';
    overlay.querySelector('#fileProgressText').textContent = total === 1 ? 'Processing ' + fileName : `File ${current + 1} of ${total}: ${fileName}`;
    overlay.querySelector('#fileProgressMeta').textContent = overallPct + '%';
  }

  function hideFileProgress() {
    const overlay = document.getElementById('fileProgressOverlay');
    if (overlay) {
      overlay.querySelector('#fileProgressBar').style.width = '100%';
      setTimeout(() => overlay.classList.remove('open'), 400);
    }
  }

  // -------- Grid view (organized by sections, with delete + edit on each card) --------
  function openGrid() {
    const container = $('#gridContainer');
    // Group pages by section, preserving order
    const sections = {};
    const sectionOrder = [];
    state.pages.forEach(p => {
      const s = p.section || 'Documentation';
      if (!sections[s]) { sections[s] = []; sectionOrder.push(s); }
      sections[s].push(p);
    });

    const totalPages = state.pages.length;
    const totalWords = state.pages.reduce((sum, p) => sum + wordCount(p.content || ''), 0);
    const totalReading = state.pages.reduce((sum, p) => sum + readingTime(p.content || ''), 0);

    let html = '<div class="grid-header">' +
      '<div class="grid-header-title">⊞ All Pages</div>' +
      '<div class="grid-header-stats">' + totalPages + ' pages · ' + sectionOrder.length + ' sections · ' +
      totalWords.toLocaleString() + ' words · ' + totalReading + ' min read</div>' +
      '<button class="btn btn-primary" id="gridNewPageBtn">+ New page</button>' +
      '</div>';

    sectionOrder.forEach(section => {
      const pages = sections[section];
      html += '<div class="grid-section">' +
        '<div class="grid-section-title">' + escapeHtml(section) +
        '<span class="grid-section-count">' + pages.length + '</span></div>' +
        '<div class="grid-section-cards">';
      pages.forEach(p => {
        const num = String(state.pages.indexOf(p) + 1).padStart(2, '0');
        const desc = (p.content || '').replace(/[#*`>\-\[\]]/g, '').split('\n').find(l => l.trim()) || 'No preview';
        html += '<div class="grid-card" data-page="' + p.id + '">' +
          '<div class="grid-card-actions">' +
            '<button class="grid-card-btn" data-action="edit" data-page="' + p.id + '" title="Edit">✎</button>' +
            '<button class="grid-card-btn grid-card-delete" data-action="delete" data-page="' + p.id + '" title="Delete">✕</button>' +
          '</div>' +
          '<div class="grid-card-num">' + (p.icon || '📄') + ' · ' + num + '</div>' +
          '<div class="grid-card-title">' + escapeHtml(p.title) + '</div>' +
          '<div class="grid-card-desc">' + escapeHtml(desc.slice(0, 120)) + (desc.length > 120 ? '…' : '') + '</div>' +
        '</div>';
      });
      html += '</div></div>';
    });

    container.innerHTML = html;

    // Card click (navigate). Button clicks stop propagation.
    $$('.grid-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.grid-card-btn')) return; // button handled separately
        $('#gridView').classList.remove('open');
        go(card.dataset.page);
      });
    });
    // Edit buttons
    $$('.grid-card-btn[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        $('#gridView').classList.remove('open');
        openEditor(btn.dataset.page);
      });
    });
    // Delete buttons
    $$('.grid-card-btn[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (deletePage(btn.dataset.page)) {
          // Refresh grid view if still open
          if ($('#gridView').classList.contains('open')) openGrid();
        }
      });
    });
    // New page button
    const newBtn = $('#gridNewPageBtn');
    if (newBtn) newBtn.addEventListener('click', () => {
      $('#gridView').classList.remove('open');
      openEditor();
    });

    $('#gridView').classList.add('open');
  }

  // -------- Storage stats (shown in Settings → Data management) --------
  function fmtBytes(n) {
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n > 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }
  function updateStorageStats() {
    const el = $('#storageStats');
    if (!el) return;
    try {
      const docsSize = new Blob([localStorage.getItem(STORAGE_KEY) || '']).size;
      const files = Object.values(fileStore);
      const fileSize = files.reduce((s, f) => s + ((f && f.dataUrl) || '').length, 0);
      loadVersions();
      el.textContent = `Docs: ${fmtBytes(docsSize)} in localStorage · Media: ${files.length} files (${fmtBytes(fileSize)}) in IndexedDB · Snapshots: ${versions.length}/${MAX_VERSIONS}`;
    } catch (e) { /* non-fatal */ }
  }

  // -------- Online / offline indicator --------
  function updateNetStatus() {
    const el = $('#statusNet');
    if (!el) return;
    const online = navigator.onLine;
    el.textContent = online ? 'Online' : 'Offline · cached libs';
    el.classList.toggle('net-offline', !online);
    el.classList.toggle('net-online', online);
  }

  // -------- GitHub sync / update system --------
  // Pulls a newer documentation (lumen-data.json, an exported HTML, or a .md
  // file) from a GitHub repo — optionally with a token for private repos —
  // and saves it locally in the browser. This is the "update system".
  function syncSignature(data) {
    if (!data) return '';
    return JSON.stringify({
      n: (data.pages || []).length,
      v: (data.doc && data.doc.version) || '',
      at: data.exportedAt || '',
      ids: (data.pages || []).map(p => p.id + ':' + (p.content || '').length),
    });
  }

  async function fetchRemoteDoc(cfg) {
    const path = (cfg.path || 'lumen-data.json').replace(/^\/+/, '');
    const branch = cfg.branch || 'main';
    let text;
    if (cfg.token) {
      const api = `https://api.github.com/repos/${cfg.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}&t=${Date.now()}`;
      const r = await fetch(api, { headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('GitHub API responded ' + r.status);
      const j = await r.json();
      // GitHub returns base64 with newlines; decode for UTF-8 safety
      const bin = atob(j.content.replace(/\n/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      text = new TextDecoder().decode(bytes);
    } else {
      const raw = `https://raw.githubusercontent.com/${cfg.repo}/${branch}/${path}?t=${Date.now()}`;
      const r = await fetch(raw);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    }
    // Parse by file type
    if (/\.json$/i.test(path)) {
      const data = JSON.parse(text);
      if (!data.pages) throw new Error('JSON has no pages array (use a Lumen JSON export)');
      return data;
    }
    if (/\.html?$/i.test(path)) {
      const m = text.match(/window\.__LUMEN_DEFAULT_PAGES__\s*=\s*(\[[\s\S]*?\n\]);/);
      if (!m) throw new Error('No embedded pages found in that HTML (export it from Lumen first)');
      return { pages: JSON.parse(m[1]) };
    }
    if (/\.md$/i.test(path)) {
      const title = path.split('/').pop().replace(/\.md$/i, '');
      return { pages: [{ id: slugify(title), title, section: 'Synced', icon: '📄', tags: [], dir: state.settings.dir, content: text }] };
    }
    throw new Error('Unsupported file type — use .json, .html, or .md');
  }

  function applyRemoteDoc(data) {
    snapshot('Before applying remote update');
    state.pages = data.pages;
    if (data.doc) state.doc = { ...state.doc, ...data.doc };
    if (data.bookmarks) state.bookmarks = data.bookmarks;
    if (data.fileStore) {
      Object.keys(fileStore).forEach(k => delete fileStore[k]);
      Object.assign(fileStore, data.fileStore);
      persistFileStore();
    }
    applyDocSettings();
    buildSearchIndex();
    save();
    renderSidebar();
    go(state.pages[0] ? state.pages[0].id : null);
    updateStorageStats();
  }

  async function checkForUpdates(interactive = true) {
    const cfg = state.settings.sync || {};
    if (!cfg.repo) {
      if (interactive) { toast('Set up GitHub sync in Settings first', '⚙'); $('#settingsModal').classList.add('open'); }
      return;
    }
    const statusEl = $('#syncStatus');
    if (statusEl) statusEl.textContent = 'Checking ' + cfg.repo + '…';
    try {
      const data = await fetchRemoteDoc(cfg);
      const remoteSig = syncSignature(data);
      const localSig = syncSignature({ pages: state.pages, doc: state.doc });
      if (remoteSig === localSig) {
        if (statusEl) statusEl.textContent = '✓ Up to date (' + new Date().toLocaleTimeString() + ')';
        else if (interactive) toast('You are up to date', '✓');
        if (interactive && !statusEl) {} // status element always present in settings
      } else {
        if (statusEl) statusEl.textContent = 'Update available — ' + (data.pages || []).length + ' pages on ' + (cfg.branch || 'main');
        if (interactive) {
          if (confirm('An updated documentation is available on GitHub (' + ((data.pages || []).length) + ' pages).\n\nApply it now? Your current state is snapshotted first.')) {
            applyRemoteDoc(data);
            if (statusEl) statusEl.textContent = '✓ Updated ' + new Date().toLocaleTimeString();
            toast('Documentation updated from GitHub', '⬇');
          }
        } else {
          toast('Update available — Settings → Update & Sync to apply', '⬇');
        }
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = '⚠ ' + e.message;
      if (interactive) toast('Update check failed: ' + e.message, '⚠');
    }
  }

  // -------- AI assist (optional, bring-your-own-endpoint) --------
  // Works with any OpenAI-compatible chat completions API (OpenAI, OpenRouter,
  // Ollama, LM Studio…). The endpoint + key stay in this browser's localStorage.
  const AI_ACTIONS = [
    { id: 'improve', icon: '✨', label: 'Improve writing', prompt: 'Improve the clarity, flow, and professionalism of the following markdown. Keep the same meaning and all markdown syntax intact. Return ONLY the improved markdown, no commentary.' },
    { id: 'grammar', icon: '✎', label: 'Fix grammar & typos', prompt: 'Fix grammar, spelling, and punctuation in the following markdown. Do not change its meaning or structure. Return ONLY the corrected markdown.' },
    { id: 'summarize', icon: '≡', label: 'Summarize', prompt: 'Condense the following markdown to its essential points. Keep headings structure and markdown syntax. Return ONLY the summary.' },
    { id: 'expand', icon: '＋', label: 'Expand with detail', prompt: 'Expand the following markdown with more detail, context, and examples. Keep the original language (English or Persian) and markdown syntax. Return ONLY the expanded markdown.' },
    { id: 'to-fa', icon: '🇮🇷', label: 'Translate → Persian', prompt: 'Translate the following markdown to Persian (Farsi). Keep markdown syntax, code blocks, URLs, and technical terms intact. Write natural, fluent Persian. Return ONLY the translation.' },
    { id: 'to-en', icon: '🇬🇧', label: 'Translate → English', prompt: 'Translate the following markdown to English. Keep markdown syntax, code blocks, URLs, and technical terms intact. Return ONLY the translation.' },
  ];

  function toggleAiMenu() {
    const menu = $('#aiMenu');
    if (!menu) return;
    if (menu.classList.contains('open')) { menu.classList.remove('open'); return; }
    const cfg = state.settings.ai || {};
    menu.innerHTML = AI_ACTIONS.map(a =>
      `<div class="page-link-item ai-action" data-ai="${a.id}"><span class="pl-icon">${a.icon}</span><span>${a.label}</span></div>`
    ).join('') +
    (cfg.endpoint ? '' : '<div class="page-link-item" style="color: var(--text-muted);">⚙ Configure an endpoint in Settings…</div>');
    menu.querySelectorAll('.ai-action').forEach(item => {
      item.addEventListener('click', () => { menu.classList.remove('open'); runAiAction(item.dataset.ai); });
    });
    const btn = $('#tbAI');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      const overlayRect = $('#editorOverlay').getBoundingClientRect();
      menu.style.top = (rect.bottom - overlayRect.top + 4) + 'px';
      menu.style.left = (rect.left - overlayRect.left) + 'px';
    }
    menu.classList.add('open');
  }

  async function runAiAction(actionId) {
    const cfg = state.settings.ai || {};
    const action = AI_ACTIONS.find(a => a.id === actionId);
    if (!action) return;
    if (!cfg.endpoint) {
      toast('Set an AI endpoint in Settings → AI first', '⚙');
      $('#settingsModal').classList.add('open');
      return;
    }
    const ta = $('#editorText');
    const start = ta.selectionStart, end = ta.selectionEnd;
    const sel = ta.value.substring(start, end);
    if (!sel.trim()) { toast('Select some text in the editor first', '✎'); return; }

    const modal = $('#aiModal');
    const resultEl = $('#aiResult');
    $('#aiActionLabel').textContent = action.label;
    resultEl.value = '';
    modal.classList.add('open');

    try {
      const r = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}),
        },
        body: JSON.stringify({
          model: cfg.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a documentation writing assistant inside a markdown editor. Always return only the transformed markdown text with no explanations, no code fences around the whole answer, and no commentary.' },
            { role: 'user', content: action.prompt + '\n\n---\n\n' + sel },
          ],
          temperature: 0.4,
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
      if (!out) throw new Error('Empty response');
      resultEl.value = out.replace(/^```markdown\n?|```$/g, '');
      $('#aiApply').disabled = false;
    } catch (e) {
      resultEl.value = '⚠ ' + e.message + '\n\nCheck the endpoint URL, model name, and key in Settings → AI. Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, Ollama, LM Studio…).';
      $('#aiApply').disabled = true;
    }
  }

  function applyAiResult() {
    const ta = $('#editorText');
    const resultEl = $('#aiResult');
    if (!resultEl.value || resultEl.value.startsWith('⚠')) return;
    const start = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.substring(0, start) + resultEl.value + ta.value.substring(end);
    ta.focus();
    updateEditorPreview();
    $('#aiModal').classList.remove('open');
    toast('AI edit applied — Ctrl+S to save the page', '✨');
  }

  // -------- History navigation (back / forward) --------
  function goBack() {
    if (state.history.length > 1) {
      state.history.pop();                 // drop current
      const prev = state.history.pop();    // take previous
      go(prev);
    } else toast('No history yet');
  }

  // -------- Command palette --------
  const COMMANDS = [
    { id: 'toggle-theme', icon: '🎨', label: 'Cycle theme', hint: 'T', run: cycleTheme },
    { id: 'toggle-sidebar', icon: '☰', label: 'Toggle sidebar', hint: 'S', run: () => document.body.classList.toggle('sidebar-collapsed') },
    { id: 'toggle-toc', icon: '📋', label: 'Toggle on-page TOC', hint: 'O', run: () => document.body.classList.toggle('toc-collapsed') },
    { id: 'reading-mode', icon: '📖', label: 'Toggle reading mode', hint: 'R', run: () => document.body.classList.toggle('reading-mode') },
    { id: 'viewer-mode', icon: '🔒', label: 'Toggle viewer mode (hide editing)', hint: 'V', run: toggleViewMode },
    { id: 'history', icon: '⏱', label: 'Version history (snapshots)', hint: 'H', run: openVersions },
    { id: 'new-page', icon: '✏️', label: 'New page (editor)', hint: 'E', editOnly: true, run: () => openEditor() },
    { id: 'edit-page', icon: '📝', label: 'Edit current page', hint: '', editOnly: true, run: () => openEditor(state.currentPageId) },
    { id: 'delete-page', icon: '🗑️', label: 'Delete current page', hint: '', editOnly: true, run: () => deletePage(state.currentPageId) },
    { id: 'grid', icon: '⊞', label: 'Grid view (all pages)', hint: 'G', run: openGrid },
    { id: 'export-html', icon: '📦', label: 'Export as single HTML', hint: '', run: exportSingleHTML },
    { id: 'export-md', icon: '📄', label: 'Export as markdown zip', hint: '', run: exportMarkdown },
    { id: 'export-json', icon: '💾', label: 'Export JSON backup', hint: '', run: exportJSON },
    { id: 'new-doc', icon: '✨', label: 'New document from scratch', hint: '', editOnly: true, run: openNewDocModal },
    { id: 'sync', icon: '⬇', label: 'Check for updates (GitHub sync)', hint: '', run: () => checkForUpdates(true) },
    { id: 'back', icon: '←', label: 'Back (history)', hint: 'Alt+←', run: goBack },
    { id: 'settings', icon: '⚙️', label: 'Open settings', hint: '', run: () => $('#settingsModal').classList.add('open') },
    { id: 'prev', icon: '←', label: 'Previous page', hint: 'J', run: goPrev },
    { id: 'next', icon: '→', label: 'Next page', hint: 'K', run: goNext },
  ];

  let cmdActiveIndex = 0;
  function openCmd() {
    $('#cmdOverlay').classList.add('open');
    $('#cmdInput').value = '';
    cmdActiveIndex = 0;
    renderCmd('');
    setTimeout(() => $('#cmdInput').focus(), 50);
  }
  function closeCmd() { $('#cmdOverlay').classList.remove('open'); }
  function renderCmd(query) {
    const q = query.toLowerCase().trim();
    const results = $('#cmdResults');
    let items = [];
    // Pages
    const pages = state.pages.filter(p => !q || p.title.toLowerCase().includes(q) || (p.content || '').toLowerCase().includes(q)).slice(0, 6);
    if (pages.length) {
      items.push({ type: 'section', label: 'Pages' });
      pages.forEach(p => items.push({ type: 'page', icon: p.icon || '📄', label: p.title, meta: p.section, action: () => go(p.id) }));
    }
    // Commands (edit-only commands are hidden in viewer mode)
    const cmds = COMMANDS.filter(c => (!q || c.label.toLowerCase().includes(q)) && !(state.settings.viewMode && c.editOnly));
    if (cmds.length) {
      items.push({ type: 'section', label: 'Commands' });
      cmds.forEach(c => items.push({ type: 'cmd', icon: c.icon, label: c.label, meta: c.hint, action: c.run }));
    }
    cmdActiveIndex = Math.min(cmdActiveIndex, items.filter(i => i.type !== 'section').length - 1);
    let html = '';
    let count = 0;
    items.forEach(item => {
      if (item.type === 'section') {
        html += `<div class="cmd-section-label">${item.label}</div>`;
      } else {
        const active = count === cmdActiveIndex ? ' active' : '';
        html += `<div class="cmd-item${active}" data-idx="${count}"><span class="cmd-icon">${item.icon}</span><span>${item.label}</span><span class="cmd-meta">${item.meta || ''}</span></div>`;
        count++;
      }
    });
    if (!count) html = '<div class="cmd-empty">No results</div>';
    results.innerHTML = html;
    $$('.cmd-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        const item = items.filter(i => i.type !== 'section')[idx];
        if (item) { closeCmd(); item.action(); }
      });
      el.addEventListener('mouseenter', () => { cmdActiveIndex = parseInt(el.dataset.idx); $$('.cmd-item').forEach(e => e.classList.remove('active')); el.classList.add('active'); });
    });
  }

  // Bind the dynamically rendered close button (renderSearch rebuilds the container)
  function bindSearchClose() {
    const btn = $('#closeSearchBtn');
    if (btn) btn.addEventListener('click', () => {
      $('#searchResults').classList.remove('open');
      $('#searchInput').blur();
    });
  }

  // -------- Search UI --------
  let searchActiveIndex = 0;
  const SEARCH_CLOSE_BTN = '<button class="dropdown-close" id="closeSearchBtn" aria-label="Close search">✕</button>';
  function renderSearch(query) {
    const results = search(query);
    const container = $('#searchResults');
    if (!query.trim()) { container.classList.remove('open'); return; }
    if (!results.length) {
      container.innerHTML = SEARCH_CLOSE_BTN + '<div class="cmd-empty">No pages found</div>';
      bindSearchClose();
      container.classList.add('open');
      return;
    }
    searchActiveIndex = 0;
    container.innerHTML = SEARCH_CLOSE_BTN + results.map((r, i) => {
      const active = i === 0 ? ' active' : '';
      const snippet = r.snippet ? r.snippet.slice(0, 120) + (r.snippet.length > 120 ? '…' : '') : '';
      const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      const titleHi = escapeHtml(r.title).replace(re, '<mark>$1</mark>');
      const snipHi = escapeHtml(snippet).replace(re, '<mark>$1</mark>');
      return `<div class="search-result${active}" data-idx="${i}" data-page="${r.pageId}">
        <div class="search-result-title">${r.pageIcon} ${titleHi}</div>
        <div class="search-result-snippet">${snipHi}</div>
        <div class="search-result-path">${escapeHtml(r.pageTitle || '')} · ${r.type}</div>
      </div>`;
    }).join('');
    bindSearchClose();
    container.classList.add('open');
    $$('.search-result').forEach(el => {
      el.addEventListener('click', () => { go(el.dataset.page); $('#searchInput').value = ''; container.classList.remove('open'); });
      el.addEventListener('mouseenter', () => {
        searchActiveIndex = parseInt(el.dataset.idx);
        $$('.search-result').forEach(e => e.classList.remove('active'));
        el.classList.add('active');
      });
    });
  }

  // -------- Bookmarks --------
  function toggleBookmark(pageId) {
    const idx = state.bookmarks.indexOf(pageId);
    if (idx >= 0) { state.bookmarks.splice(idx, 1); toast('Removed bookmark'); }
    else { state.bookmarks.push(pageId); toast('Added bookmark'); }
    save();
    renderSidebar();
  }

  // -------- Toast --------
  function toast(msg, icon = '✓') {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span class="toast-icon">${icon}</span><span>${msg}</span>`;
    $('#toastContainer').appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // -------- Image zoom --------
  function zoomImage(src) {
    $('#zoomImg').src = src;
    $('#zoomOverlay').classList.add('open');
  }

  // -------- Keyboard shortcuts --------
  function handleKeydown(e) {
    // Cmd/Ctrl+K — command palette
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCmd();
      return;
    }
    // Cmd/Ctrl+S — save (prevent browser save)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if ($('#editorOverlay').classList.contains('open')) saveEditorPage();
      return;
    }
    // In input — only Esc
    const inInput = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
    if (inInput) {
      if (e.key === 'Escape') {
        e.target.blur();
        if ($('#cmdOverlay').classList.contains('open')) closeCmd();
        if ($('#searchResults').classList.contains('open')) $('#searchResults').classList.remove('open');
      }
      return;
    }
    // Escape closes overlays
    if (e.key === 'Escape') {
      $$('.modal-overlay, .cmd-overlay, .grid-view, .editor-overlay, .zoom-overlay').forEach(el => el.classList.remove('open'));
      return;
    }
    // Alt+← / Alt+→ — back / forward in local history
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); return; }
    // Use toLowerCase so Caps Lock and Shift don't break shortcuts
    const key = e.key.toLowerCase();
    // ? — help (shift+/ on most keyboards)
    if (e.key === '?') { e.preventDefault(); openCmd(); $('#cmdInput').value = ''; renderCmd(''); return; }
    // / — focus search
    if (key === '/') { e.preventDefault(); $('#searchInput').focus(); return; }
    // j/k — prev/next
    if (key === 'j') { e.preventDefault(); goPrev(); return; }
    if (key === 'k') { e.preventDefault(); goNext(); return; }
    // t — theme
    if (key === 't') { e.preventDefault(); cycleTheme(); return; }
    // s — sidebar
    if (key === 's') { e.preventDefault(); document.body.classList.toggle('sidebar-collapsed'); return; }
    // o — toc
    if (key === 'o') { e.preventDefault(); document.body.classList.toggle('toc-collapsed'); return; }
    // r — reading mode
    if (key === 'r') { e.preventDefault(); document.body.classList.toggle('reading-mode'); toast(document.body.classList.contains('reading-mode') ? 'Reading mode on' : 'Reading mode off'); return; }
    // v — viewer mode (hide editing for read-only audiences)
    if (key === 'v') { e.preventDefault(); toggleViewMode(); return; }
    // h — version history
    if (key === 'h') { e.preventDefault(); openVersions(); return; }
    // g — grid
    if (key === 'g') { e.preventDefault(); openGrid(); return; }
    // e — editor (blocked in viewer mode)
    if (key === 'e') { e.preventDefault(); openEditor(); return; }
    // b — bookmark
    if (key === 'b') { e.preventDefault(); toggleBookmark(state.currentPageId); return; }
    // p — print
    if (key === 'p') { e.preventDefault(); window.print(); return; }
    // ArrowUp/Down — scroll content
    if (e.key === 'ArrowDown') { e.preventDefault(); $('#content').scrollBy({ top: 80, behavior: 'smooth' }); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); $('#content').scrollBy({ top: -80, behavior: 'smooth' }); return; }
  }

  // -------- Init --------
  async function init() {
    load();
    // Bring IndexedDB-stored media into memory (needed for rendering file:// refs)
    try {
      const stored = await FileDB.all();
      Object.keys(fileStore).forEach(k => { if (!stored[k]) delete fileStore[k]; });
      Object.assign(fileStore, stored);
    } catch (e) { /* IndexedDB unavailable — pages still work, media refs degrade */ }
    // Guard: an empty/invalid pages array should not brick the app
    if (!state.pages.length) {
      state.pages = [{
        id: 'cover',
        title: state.doc.name || 'Lumen',
        section: 'Start',
        icon: state.doc.icon || '📄',
        dir: state.settings.dir,
        layout: 'cover',
        content: '# ' + (state.doc.name || 'Lumen') + '\n\nNo pages yet. Press E to create one.\n',
      }];
    }
    configureMarked();
    applySettings();
    applyDocSettings();
    buildSearchIndex();

    // Mermaid config (follows the current theme)
    if (window.mermaid) {
      const light = ['daylight', 'sepia'].includes(state.settings.theme);
      mermaid.initialize({ startOnLoad: false, theme: light ? 'default' : 'dark', securityLevel: 'loose' });
    }

    // Bind events
    $('#toggleSidebar').addEventListener('click', () => document.body.classList.toggle('sidebar-collapsed'));
    $('#toggleTheme').addEventListener('click', cycleTheme);
    $('#openSettings').addEventListener('click', () => { updateStorageStats(); $('#settingsModal').classList.add('open'); });
    $('#closeSettings').addEventListener('click', () => $('#settingsModal').classList.remove('open'));
    $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') $('#settingsModal').classList.remove('open'); });
    $('#openGrid').addEventListener('click', openGrid);
    $('#closeGrid').addEventListener('click', () => $('#gridView').classList.remove('open'));
    $('#gridView').addEventListener('click', (e) => { if (e.target.id === 'gridView') $('#gridView').classList.remove('open'); });
    $('#openEditor').addEventListener('click', () => openEditor());
    $('#closeEditor').addEventListener('click', closeEditor);
    $('#editorSave').addEventListener('click', saveEditorPage);
    $('#editorDelete').addEventListener('click', deleteEditorPage);
    // Formatting toolbar buttons
    $$('[data-fmt]').forEach(btn => {
      btn.addEventListener('click', () => applyFormat(btn.dataset.fmt));
    });
    // Page link dropdown
    $('#tbPageLink').addEventListener('click', (e) => { e.stopPropagation(); togglePageLinkDropdown(); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#pageLinkDropdown') && !e.target.closest('#tbPageLink')) {
        $('#pageLinkDropdown').classList.remove('open');
      }
    });
    // Hide toolbar toggle
    $('#tbHideToolbar').addEventListener('click', () => {
      $('#editorToolbar').classList.toggle('hidden');
    });
    // Upload button
    $('#tbUpload').addEventListener('click', () => {
      // Create a temporary file input
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.onchange = (e) => handleFileDrop(e.target.files);
      input.click();
    });
    // Drag-and-drop on editor
    const editorOverlay = $('#editorOverlay');
    const editorText = $('#editorText');
    ['dragenter', 'dragover'].forEach(ev => {
      editorOverlay.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) {
          editorOverlay.classList.add('dragging');
        }
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      editorOverlay.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Only remove dragging class if leaving the overlay entirely
        if (ev === 'dragleave' && e.relatedTarget && editorOverlay.contains(e.relatedTarget)) return;
        editorOverlay.classList.remove('dragging');
      });
    });
    editorOverlay.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      editorOverlay.classList.remove('dragging');
      if (e.dataTransfer.files.length) {
        handleFileDrop(e.dataTransfer.files);
      }
    });
    // Keyboard shortcuts in editor: Ctrl+B bold, Ctrl+I italic, Ctrl+K page link
    editorText.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === 'b') { e.preventDefault(); applyFormat('bold'); }
        else if (key === 'i') { e.preventDefault(); applyFormat('italic'); }
        else if (key === 'k') { e.preventDefault(); togglePageLinkDropdown(); }
      }
    });
    // AI menu (editor toolbar)
    const tbAI = $('#tbAI');
    if (tbAI) {
      tbAI.addEventListener('click', (e) => { e.stopPropagation(); toggleAiMenu(); });
      document.addEventListener('click', (e) => {
        const menu = $('#aiMenu');
        if (menu && !e.target.closest('#aiMenu') && !e.target.closest('#tbAI')) menu.classList.remove('open');
      });
    }
    const aiApply = $('#aiApply');
    if (aiApply) aiApply.addEventListener('click', applyAiResult);
    const aiClose = $('#closeAiModal');
    if (aiClose) aiClose.addEventListener('click', () => $('#aiModal').classList.remove('open'));
    const aiModalEl = $('#aiModal');
    if (aiModalEl) aiModalEl.addEventListener('click', (e) => { if (e.target.id === 'aiModal') aiModalEl.classList.remove('open'); });
    // Export menu + single HTML button
    $('#exportBtn').addEventListener('click', () => $('#exportModal').classList.add('open'));
    $('#exportHtmlBtn').addEventListener('click', exportSingleHTML);
    $('#closeExport').addEventListener('click', () => $('#exportModal').classList.remove('open'));
    $('#exportModal').addEventListener('click', (e) => { if (e.target.id === 'exportModal') $('#exportModal').classList.remove('open'); });
    $('#exportOptionHtml').addEventListener('click', () => { $('#exportModal').classList.remove('open'); exportSingleHTML(); });
    $('#exportOptionMd').addEventListener('click', () => { $('#exportModal').classList.remove('open'); exportMarkdown(); });
    $('#exportOptionJson').addEventListener('click', () => { $('#exportModal').classList.remove('open'); exportJSON(); });
    $('#exportOptionPrint').addEventListener('click', () => { $('#exportModal').classList.remove('open'); window.print(); });
    // New document modal
    $('#newDocBtn').addEventListener('click', () => { $('#settingsModal').classList.remove('open'); openNewDocModal(); });
    $('#closeNewDoc').addEventListener('click', () => $('#newDocModal').classList.remove('open'));
    $('#cancelNewDoc').addEventListener('click', () => $('#newDocModal').classList.remove('open'));
    $('#newDocModal').addEventListener('click', (e) => { if (e.target.id === 'newDocModal') $('#newDocModal').classList.remove('open'); });
    $('#confirmNewDoc').addEventListener('click', confirmNewDoc);
    $('#exportMenuBtn').addEventListener('click', () => { $('#settingsModal').classList.remove('open'); $('#exportModal').classList.add('open'); });
    // Doc metadata inputs (live update)
    $('#docName').addEventListener('input', (e) => setDocField('name', e.target.value));
    $('#docDesc').addEventListener('input', (e) => setDocField('description', e.target.value));
    $('#docVersion').addEventListener('input', (e) => setDocField('version', e.target.value));
    $('#docIcon').addEventListener('input', (e) => setDocField('icon', e.target.value));
    $('#docAuthor').addEventListener('input', (e) => setDocField('author', e.target.value));
    // Import
    $('#importBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => handleFileImport(e.target.files));
    $('#exportJsonBtn').addEventListener('click', exportJSON);
    $('#importJsonBtn').addEventListener('click', importJSON);
    $('#jsonInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        const data = JSON.parse(text);
        if (data.pages) {
          snapshot('Before JSON import');
          state.pages = data.pages;
          state.bookmarks = data.bookmarks || [];
          state.annotations = data.annotations || {};
          if (data.doc) Object.assign(state.doc, data.doc);
          // Restore file store
          if (data.fileStore) {
            Object.keys(fileStore).forEach(k => delete fileStore[k]);
            Object.assign(fileStore, data.fileStore);
            persistFileStore();
          }
          applyDocSettings();
          buildSearchIndex();
          save();
          renderSidebar();
          // Always land on the first page of the imported set (the old current
          // page id usually doesn't exist in the new data)
          go(state.pages[0] ? state.pages[0].id : null);
          updateStorageStats();
          toast('Imported JSON backup');
        }
      } catch (err) { toast('Invalid JSON file', '⚠'); }
    });
    $('#resetBtn').addEventListener('click', () => {
      if (!confirm('Reset to default documentation? This will erase your custom pages, bookmarks, and document metadata. A snapshot is taken first.')) return;
      snapshot('Before reset');
      localStorage.removeItem(STORAGE_KEY);
      state.pages = getDefaultDocs().slice();
      state.doc = { name: 'Lumen', description: 'A single-file static documentation engine', version: '1.1', author: '', icon: '✦' };
      state.bookmarks = [];
      state.annotations = {};
      state.currentPageId = null;
      applyDocSettings();
      buildSearchIndex();
      save();
      renderSidebar();
      go(state.pages[0].id);
      updateStorageStats();
      toast('Reset to defaults');
    });
    $('#fontSlider').addEventListener('input', (e) => setFont(e.target.value));
    $$('[data-dir]').forEach(b => b.addEventListener('click', () => setDir(b.dataset.dir)));
    $$('[data-density]').forEach(b => b.addEventListener('click', () => setDensity(b.dataset.density)));

    // Viewer mode toggle
    const tvm = $('#toggleViewMode');
    if (tvm) tvm.addEventListener('click', toggleViewMode);

    // Version history modal
    const closeVersions = $('#closeVersions');
    if (closeVersions) closeVersions.addEventListener('click', () => $('#versionsModal').classList.remove('open'));
    const versionsModalEl = $('#versionsModal');
    if (versionsModalEl) versionsModalEl.addEventListener('click', (e) => { if (e.target.id === 'versionsModal') versionsModalEl.classList.remove('open'); });
    const versionsOpenBtn = $('#versionsOpenBtn');
    if (versionsOpenBtn) versionsOpenBtn.addEventListener('click', () => { $('#settingsModal').classList.remove('open'); openVersions(); });
    const versionsSnapBtn = $('#versionsSnapBtn');
    if (versionsSnapBtn) versionsSnapBtn.addEventListener('click', () => { snapshot('Manual snapshot'); openVersions(); toast('Snapshot created', '⏱'); });
    const versionsHistoryBtn = $('#versionsHistoryBtn');
    if (versionsHistoryBtn) versionsHistoryBtn.addEventListener('click', openVersions);

    // Customization: accent color + custom CSS
    const accentColor = $('#accentColor');
    if (accentColor) accentColor.addEventListener('input', (e) => setAccent(e.target.value));
    const accentReset = $('#accentReset');
    if (accentReset) accentReset.addEventListener('click', () => setAccent(''));
    const customCss = $('#customCss');
    if (customCss) {
      customCss.value = state.settings.customCss || '';
      customCss.addEventListener('input', debounce((e) => setCustomCss(e.target.value), 400));
    }

    // Compress images toggle
    const compressToggle = $('#compressToggle');
    if (compressToggle) {
      compressToggle.checked = state.settings.compressImages !== false;
      compressToggle.addEventListener('change', (e) => { state.settings.compressImages = e.target.checked; save(); });
    }

    // Sync (update system)
    const syncRepo = $('#syncRepo');
    if (syncRepo) {
      syncRepo.value = state.settings.sync.repo || '';
      syncRepo.addEventListener('input', debounce((e) => { state.settings.sync.repo = e.target.value.trim(); save(); }, 300));
    }
    const syncBranch = $('#syncBranch');
    if (syncBranch) {
      syncBranch.value = state.settings.sync.branch || 'main';
      syncBranch.addEventListener('input', debounce((e) => { state.settings.sync.branch = e.target.value.trim() || 'main'; save(); }, 300));
    }
    const syncPath = $('#syncPath');
    if (syncPath) {
      syncPath.value = state.settings.sync.path || 'lumen-data.json';
      syncPath.addEventListener('input', debounce((e) => { state.settings.sync.path = e.target.value.trim() || 'lumen-data.json'; save(); }, 300));
    }
    const syncToken = $('#syncToken');
    if (syncToken) {
      syncToken.value = state.settings.sync.token || '';
      syncToken.addEventListener('input', debounce((e) => { state.settings.sync.token = e.target.value.trim(); save(); }, 300));
    }
    const syncAuto = $('#syncAuto');
    if (syncAuto) {
      syncAuto.checked = !!state.settings.sync.auto;
      syncAuto.addEventListener('change', (e) => { state.settings.sync.auto = e.target.checked; save(); });
    }
    const syncCheckBtn = $('#syncCheckBtn');
    if (syncCheckBtn) syncCheckBtn.addEventListener('click', () => checkForUpdates(true));

    // AI settings
    const aiEndpoint = $('#aiEndpoint');
    if (aiEndpoint) {
      aiEndpoint.value = state.settings.ai.endpoint || '';
      aiEndpoint.addEventListener('input', debounce((e) => { state.settings.ai.endpoint = e.target.value.trim(); save(); }, 300));
    }
    const aiModel = $('#aiModel');
    if (aiModel) {
      aiModel.value = state.settings.ai.model || '';
      aiModel.addEventListener('input', debounce((e) => { state.settings.ai.model = e.target.value.trim(); save(); }, 300));
    }
    const aiKey = $('#aiKey');
    if (aiKey) {
      aiKey.value = state.settings.ai.key || '';
      aiKey.addEventListener('input', debounce((e) => { state.settings.ai.key = e.target.value.trim(); save(); }, 300));
    }

    // Online / offline indicator
    updateNetStatus();
    window.addEventListener('online', updateNetStatus);
    window.addEventListener('offline', updateNetStatus);

    // Storage stats
    updateStorageStats();

    // Auto-check for updates (silent — just notifies)
    if (state.settings.sync && state.settings.sync.auto && state.settings.sync.repo && navigator.onLine) {
      setTimeout(() => checkForUpdates(false), 1500);
    }

    // Search
    $('#searchInput').addEventListener('input', debounce((e) => renderSearch(e.target.value), 150));
    $('#searchInput').addEventListener('focus', (e) => { if (e.target.value) renderSearch(e.target.value); });
    $('#searchInput').addEventListener('keydown', (e) => {
      const results = $$('.search-result');
      if (e.key === 'ArrowDown') { e.preventDefault(); searchActiveIndex = Math.min(searchActiveIndex + 1, results.length - 1); updateSearchActive(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); searchActiveIndex = Math.max(searchActiveIndex - 1, 0); updateSearchActive(); }
      if (e.key === 'Enter') { e.preventDefault(); if (results[searchActiveIndex]) { go(results[searchActiveIndex].dataset.page); $('#searchInput').value = ''; $('#searchResults').classList.remove('open'); } }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap') && !e.target.closest('.search-results')) $('#searchResults').classList.remove('open');
    });

    // Command palette
    $('#cmdInput').addEventListener('input', (e) => { cmdActiveIndex = 0; renderCmd(e.target.value); });
    $('#cmdInput').addEventListener('keydown', (e) => {
      const items = $$('.cmd-item');
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdActiveIndex = Math.min(cmdActiveIndex + 1, items.length - 1); updateCmdActive(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); cmdActiveIndex = Math.max(cmdActiveIndex - 1, 0); updateCmdActive(); }
      if (e.key === 'Enter') { e.preventDefault(); if (items[cmdActiveIndex]) items[cmdActiveIndex].click(); }
    });
    $('#cmdOverlay').addEventListener('click', (e) => { if (e.target.id === 'cmdOverlay') closeCmd(); });
    // Visible close buttons (Esc already worked — now there's a button too)
    const closeCmdBtn = $('#closeCmdBtn');
    if (closeCmdBtn) closeCmdBtn.addEventListener('click', closeCmd);

    // Image zoom close
    $('#zoomOverlay').addEventListener('click', () => $('#zoomOverlay').classList.remove('open'));
    const zoomCloseBtn = $('#zoomClose');
    if (zoomCloseBtn) zoomCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); $('#zoomOverlay').classList.remove('open'); });

    // Back to top
    $('#content').addEventListener('scroll', debounce(() => {
      const btn = $('#backToTop');
      if ($('#content').scrollTop > 400) btn.classList.add('visible');
      else btn.classList.remove('visible');
      updateActiveTOC();
    }, 100));
    $('#backToTop').addEventListener('click', () => $('#content').scrollTo({ top: 0, behavior: 'smooth' }));

    // Keyboard
    document.addEventListener('keydown', handleKeydown);

    // Hash routing
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.slice(1);
      const [pageId, anchor] = hash.split(',');
      if (pageId && state.pages.find(p => p.id === pageId)) {
        if (pageId !== state.currentPageId) go(pageId, anchor);
      }
    });

    // Drag & drop markdown files
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) handleFileImport(e.dataTransfer.files);
    });

    // Start
    const initialHash = window.location.hash.slice(1);
    const initialPageId = initialHash && state.pages.find(p => p.id === initialHash.split(',')[0]) ? initialHash.split(',')[0] : state.pages[0].id;
    go(initialPageId);

    // Hide loading
    setTimeout(() => $('#loading').classList.add('hidden'), 400);
  }

  function updateSearchActive() {
    const els = $$('.search-result');
    els.forEach((el, i) => el.classList.toggle('active', i === searchActiveIndex));
    // Keep the keyboard-selected result in view (fixes "arrow down scrolls out of sight")
    if (els[searchActiveIndex]) els[searchActiveIndex].scrollIntoView({ block: 'nearest' });
  }
  function updateCmdActive() {
    const els = $$('.cmd-item');
    els.forEach((el, i) => el.classList.toggle('active', i === cmdActiveIndex));
    // Keep the keyboard-selected command in view (fixes "arrow down scrolls out of sight")
    if (els[cmdActiveIndex]) els[cmdActiveIndex].scrollIntoView({ block: 'nearest' });
  }

  // Public API
  return {
    init,
    go,
    goNext,
    goPrev,
    goBack,
    setTheme,
    setDir,
    setFont,
    setAccent,
    setCustomCss,
    toggleViewMode,
    openEditor,
    openGrid,
    openNewDocModal,
    openVersions,
    exportMarkdown,
    exportSingleHTML,
    exportJSON,
    deletePage,
    toggleBookmark,
    checkForUpdates,
    scrollToAnchor,
    toast,
    sliderGo,
    applyFormat,
    getState: () => state,
  };
})();

// Expose globally for inline onclick handlers
window.Lumen = Lumen;
