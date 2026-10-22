# Lumen

**A complete documentation system in a single HTML file.** No build step for readers, no server, no framework — open `Lumen_documentation.html` in any modern browser and start writing. Fork it, theme it, ship it.

## Getting started

1. Download `Lumen_documentation.html` and open it (double-click — that's it).
2. Open **Settings → New document from scratch** to start your own docs.
3. Your work is saved automatically to the browser. Press **⌘/Ctrl+E** to edit pages, **⌘/Ctrl+K** for anything else.
4. Use **Export → Single HTML file** to share the finished documentation — the export is itself a fully working Lumen file with your pages embedded.

## What's inside

- **Markdown engine** — GFM, syntax highlighting, math (KaTeX), Mermaid diagrams
- **Custom blocks** — callouts, cards, badges, sliders, tabs, API explorer (`:::swagger`)
- **Flowcharts** — `:::flow` with 4 shapes (square / circle / diamond / hexagon), 4 directions (`> < ^ v`), edge labels, and auto-organizing layout
- **Clickable walkthroughs** — `:::tour` turns screenshots into an interactive demo: readers click hotspots to move between steps (show an app *in work* using only images)
- **Embeds** — `:::embed` for sandboxed external pages and videos
- **RTL & Persian** — full right-to-left UI with per-page direction detection
- **5 themes** + accent color picker + custom CSS (Settings → Customization)
- **Instant search & command palette** (⌘K)
- **Viewer mode** (V) — hide every editing control when you hand the file to readers
- **Version history** (H) — automatic snapshots before every destructive action; restore anything
- **Update & Sync** — pull updated docs from a GitHub repo (optional token for private repos), saved locally
- **Offline mode** — CDN libraries are cached on first visit; after that the file works with no network
- **Smart uploads** — media lives in IndexedDB (big!), large images auto-compress, old data migrates automatically
- **Optional AI assist** — bring your own OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama…) to improve, fix, summarize, or translate selected text

## Keyboard map

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| ⌘K | Command palette | G | Outline grid |
| / | Search | E | Edit / new page |
| J / K | Previous / next page | B | Bookmark |
| T | Cycle theme | V | Viewer mode |
| S / O | Sidebar / TOC | H | Version history |
| R | Reading mode | P | Print / PDF |
| Alt+← | Back | Esc | Close anything |

## Build from source

The single file is assembled from readable parts:

```
src/
  01-head.html     doctype, <head>, meta, font links
  02-styles.css    all CSS
  03-body.html     app markup, modals, editor
  04-libs.js       offline-capable CDN library loader
  05-engine.js     the Lumen engine (vanilla JS)
  06-content.js    default documentation pages
  07-tail.html     boot script
build.sh           glues the parts into Lumen_documentation.html
```

```bash
./build.sh    # → Lumen_documentation.html
```

Edit the parts, run the script, done. The engine has no dependencies of its own — just a browser.

## Data & privacy

Everything lives in your browser: pages, bookmarks, and settings in `localStorage`; uploaded media and cached libraries in `IndexedDB`; version snapshots in `localStorage` (last 15). Sync tokens and AI keys (if you set them) never leave the browser except to talk to the service you configured. Use fine-grained, read-only GitHub tokens.

## Contribution

Feel free to add anything or complete the ideas in the roadmap — but keep the two rules in mind:

1. **Don't bloat it with useless features.**
2. **It should NOT be yet another useless project nobody uses — USE IT.**

The sweet spot is 10–100 pages of rich documentation: API references, design systems, onboarding guides, internal wikis, research notes.

## Roadmap / open ideas

- [x] ~~Save in browser storage~~ (localStorage + IndexedDB, with migration)
- [x] ~~Automatically update system~~ (GitHub sync, manual + auto-check)
- [x] ~~Update via GitHub with token, saved locally~~
- [x] ~~Offline mode after first visit~~
- [x] ~~Version manager — treat documents like code~~ (snapshots + restore)
- [x] ~~Screenshot engine reacting on clicks~~ (`:::tour` walkthroughs)
- [x] ~~Flowchart with 4 directions / 4 shapes, auto-organized~~ (`:::flow`)
- [x] ~~HTML extension inside pages~~ (raw HTML + `:::embed`)
- [x] ~~Better customization~~ (accent color, custom CSS, themes)
- [x] ~~Separate the HTML into parts with a build script~~ (`src/` + `build.sh`)
- [x] ~~Quick AI feature~~ (optional, bring-your-own-endpoint)
- [ ] Multi-language UI + automatic translation of pages (partial: AI translate action exists; full i18n still open)

## Fixes in v1.1

- Uploads no longer break storage (IndexedDB + image compression — was the "too large" bug)
- ⌘K arrow keys keep the selection in view (was the "scroll doesn't move" bug)
- Every overlay has a visible ✕ close button
- Viewers get a clean read-only mode instead of annoying edit controls
- Mermaid diagrams follow light/dark themes
- Block syntax inside code examples renders as code, not as blocks
- Duplicate heading anchors, a TOC listener leak, density reset, quote-in-title escaping, `</script>`-safe exports, and a few more small ones

## License

See [LICENSE](LICENSE).
