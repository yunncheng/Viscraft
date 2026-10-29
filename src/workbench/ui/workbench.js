/* ============================================================
   Viscraft image workbench

   Loads one registered image document from the local Runtime,
   mounts the author source in a same-origin iframe, injects the
   vendored layer editor, and owns everything the upstream editor
   did not have: real local saves, a conflict protocol, render
   states and the output hand-off.

   The saved source is the author document, never this page and
   never the editor. Editor tags are injected at runtime, so the
   serialized source cannot contain them.

   Contract (implemented by the Runtime):
     GET  /api/document?document=<id>   read source + resources + target + last result
     PUT  /api/document                 baseRevision + baseContentHash + html
     POST /api/render                   { target } -> immutable artifact, published when bound
     GET  /api/status?document=<id>     revision/contentHash of the saved source
     GET  /api/output?target=<id>       the delivered product when bound, else the artifact

   `delivery` (present only when the Runtime was started with a verified
   delivery binding) describes the stable product file the user actually has:
   `{ entry, path, build, artifact, format, width, height, sha256, bytes, simulated, stale, verified, blocked }`.
   A render updates that same file; a failed publication is reported as itself
   while the previously delivered file is reported as unchanged. `verified:false`
   means the Runtime re-inspected the bundle and cannot trust its bytes.
   ============================================================ */
(() => {
  'use strict';

  const ENDPOINTS = {
    document: '/api/document',
    render: '/api/render',
    status: '/api/status',
    output: '/api/output',
  };

  const TIMING = {
    saveDebounce: 800,    // idle delay before an automatic save
    saveMaxWait: 3000,    // a continuous edit burst still lands at least this often
    saveRequest: 30000,
    statusPoll: 3000,
    editPoll: 400,
    editorReady: 20000,
    recoveryThrottle: 2000,
  };

  const params = new URLSearchParams(location.search);
  const documentId = params.get('document');
  const requestedTarget = params.get('target');
  const token = params.get('token');

  // The layout record's read/gate/apply rules live in one script shared with
  // the formal still capture, so the preview and the produced PNG cannot drift.
  const Layout = globalThis.__viscraftLayoutRecord;

  const ui = {
    app: document.getElementById('wb-app'),
    title: document.getElementById('wb-title'),
    path: document.getElementById('wb-path'),
    target: document.getElementById('wb-target'),
    saveState: document.getElementById('wb-save-state'),
    saveLabel: document.getElementById('wb-save-label'),
    save: document.getElementById('wb-save'),
    explode: document.getElementById('wb-explode'),
    export: document.getElementById('wb-export'),
    render: document.getElementById('wb-render'),
    banners: document.getElementById('wb-banners'),
    frame: document.getElementById('wb-frame'),
    overlay: document.getElementById('wb-overlay'),
    overlayTitle: document.getElementById('wb-overlay-title'),
    overlayText: document.getElementById('wb-overlay-text'),
    overlayAction: document.getElementById('wb-overlay-action'),
    outState: document.getElementById('wb-out-state'),
    outDetail: document.getElementById('wb-out-detail'),
    download: document.getElementById('wb-download'),
  };

  const session = {
    document: null,          // { id, path, revision, contentHash }
    target: null,
    resources: [],
    servedBody: '',          // author source with the layout record removed
    editable: false,
    ready: false,

    baseRevision: 0,
    baseContentHash: '',
    lastHtml: null,          // last document confirmed by the server (source + record)
    openingHtml: null,       // saved design at this page's latest source load; never advanced by save/export
    openingLayout: null,     // measured layer boxes for that same editing session
    savedAt: null,

    editSeq: 0,
    savedSeq: 0,
    lastSignature: '',
    saveState: 'clean',
    saving: false,
    savePromise: null,
    flushPromise: null,
    debounceTimer: null,
    maxWaitTimer: null,
    recoveryTimer: null,
    conflict: null,

    result: null,
    delivery: null,          // verified delivered product, when this server is bound
    deliveryNote: '',        // last blocked reason shown (avoid recreating the banner)
    renderState: 'not-rendered',
    exporting: false,
    renderFrom: null,
    // A render that succeeded while publishing into the delivered bundle failed.
    // Kept until a later publication succeeds (or the page reloads): status
    // polling must not replace this real error with a generic "stale".
    publishError: null,
    // Bumped whenever a newer result/delivery view is applied (load, render).
    // A status request that started earlier must not overwrite that view.
    stateSeq: 0,

    reloading: false,
    noticeTimer: null,
  };

  const banners = new Map();
  const recoveryKey = documentId ? `viscraft.workbench.recovery:${documentId}` : '';

  /* ---------------------------------------------------------------
   * Small helpers
   * ------------------------------------------------------------- */

  const editorCssUrl = assetUrl('vendor/layer-editor.css');
  const editorJsUrl = assetUrl('vendor/layer-editor.js');

  function assetUrl(relative) {
    const link = document.querySelector('link[rel="stylesheet"]');
    const base = link ? link.href : location.href;
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  }

  function editor() {
    const win = ui.frame.contentWindow;
    return win && win.__layerEditor ? win.__layerEditor : null;
  }

  function frameDoc() {
    try {
      return ui.frame.contentDocument || null;
    } catch {
      return null;
    }
  }

  function nowLabel(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return new Date().toLocaleTimeString();
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function basename(path) {
    return String(path || '').split(/[\\/]/).pop() || '';
  }

  function describe(res) {
    const payload = res && res.payload;
    if (payload && typeof payload === 'object') {
      // The server's `message` carries the actionable detail (e.g. a busy
      // author lock names the holder); `error` is the machine code.
      if (typeof payload.message === 'string' && payload.message.trim())
        return `HTTP ${res.status}: ${payload.message}`;
      if (typeof payload.error === 'string') return `HTTP ${res.status} (${payload.error})`;
      if (typeof payload.raw === 'string' && payload.raw.trim()) return `HTTP ${res.status}: ${payload.raw.trim().slice(0, 240)}`;
    }
    return `HTTP ${res ? res.status : '—'}`;
  }

  async function api(method, url, body, options = {}) {
    const controller = new AbortController();
    const timeout = options.timeout || 15000;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { 'X-Viscraft-Token': token } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text };
        }
      }
      return { status: response.status, ok: response.ok, payload };
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error(`The Runtime did not answer within ${Math.round(timeout / 1000)}s.`);
      throw new Error('The local Runtime is not reachable (is it still running?).');
    } finally {
      clearTimeout(timer);
    }
  }

  function setPhase(phase) {
    ui.app.dataset.phase = phase;
  }

  /* ---------------------------------------------------------------
   * Overlay, banners, save state, render state
   * ------------------------------------------------------------- */

  function showOverlay(title, text, kind = 'info', action = null) {
    setPhase(kind === 'error' ? 'error' : 'loading');
    ui.overlay.hidden = false;
    ui.overlayTitle.textContent = title;
    ui.overlayText.textContent = text;
    if (action) {
      ui.overlayAction.hidden = false;
      ui.overlayAction.textContent = action.label;
      ui.overlayAction.onclick = action.run;
    } else {
      ui.overlayAction.hidden = true;
      ui.overlayAction.onclick = null;
    }
  }

  function hideOverlay() {
    ui.overlay.hidden = true;
  }

  function setBanner(id, kind, strong, rest, actions = []) {
    const previous = banners.get(id);
    if (previous) previous.remove();
    const element = document.createElement('div');
    element.className = 'wb-banner';
    element.dataset.kind = kind;
    const text = document.createElement('span');
    text.className = 'wb-banner-text';
    const lead = document.createElement('b');
    lead.textContent = strong;
    text.append(lead);
    if (rest) text.append(document.createTextNode(` ${rest}`));
    element.append(text);
    if (actions.length) {
      const group = document.createElement('span');
      group.className = 'wb-banner-actions';
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `wb-btn small${action.primary ? ' primary' : ''}`;
        button.textContent = action.label;
        button.addEventListener('click', action.run);
        group.append(button);
      }
      element.append(group);
    }
    ui.banners.append(element);
    banners.set(id, element);
  }

  function clearBanner(id) {
    const element = banners.get(id);
    if (element) element.remove();
    banners.delete(id);
  }

  function notice(message) {
    setBanner('notice', 'notice', message, '');
    clearTimeout(session.noticeTimer);
    session.noticeTimer = setTimeout(() => clearBanner('notice'), 6000);
  }

  const SAVE_LABELS = {
    clean: 'No changes',
    pending: 'Unsaved changes',
    saving: 'Saving…',
    saved: 'Saved',
    failed: 'Save failed',
    conflict: 'Source changed',
  };

  function setSaveState(state, detail = '') {
    session.saveState = state;
    ui.saveState.dataset.state = state;
    if (state === 'saved') {
      const at = detail || session.savedAt;
      ui.saveLabel.textContent = at ? `Saved ${nowLabel(at)}` : 'Saved';
    } else {
      ui.saveLabel.textContent = SAVE_LABELS[state] || state;
    }
    refreshButtons();
  }

  /** Read the editor's own view state. This page keeps no second copy: the
   *  iframe editor remains the authority for exploded/transitioning. */
  function viewState() {
    const ed = editor();
    if (!ed) return { ed: null, exploded: false, transitioning: false, layers: 0 };
    return {
      ed,
      exploded: Boolean(ed.state && ed.state.exploded),
      transitioning: Boolean(ed.state && ed.state.transitioning),
      layers: ed.layers().length,
    };
  }

  function syncView() {
    const view = viewState();
    ui.explode.textContent = view.exploded ? 'Back to editing' : 'View layers';
    ui.explode.setAttribute('aria-pressed', view.exploded ? 'true' : 'false');
    ui.explode.disabled = !session.ready || !view.ed || view.layers === 0 || view.transitioning;
    ui.explode.title = view.exploded
      ? 'Return to the editing canvas'
      : 'Show each layer as a read-only card';
  }

  function refreshButtons() {
    const canSave = session.editable && Boolean(token);
    const conflict = session.saveState === 'conflict';
    const blocked = Boolean(session.delivery && session.delivery.verified === false);
    ui.save.disabled = !canSave || !session.ready || conflict || session.saving;
    const view = viewState();
    const reset = ui.frame.contentDocument?.getElementById('hf-reset-all');
    if (reset) reset.disabled = !canSave || !session.ready || conflict || session.saving
      || session.renderState === 'rendering' || session.exporting || view.exploded || view.transitioning
      || !session.openingHtml || signature() === session.openingHtml;
    // A blocked delivered bundle still permits authoring, but publishing into it
    // is known to fail: do not offer an action that cannot touch the product.
    ui.render.disabled = !token || !session.ready || !session.target || blocked
      || session.renderState === 'rendering' || session.exporting || conflict;
    ui.export.disabled = !token || !session.ready || !session.target || blocked
      || session.renderState === 'rendering' || session.exporting || conflict;
    ui.export.textContent = session.exporting ? 'Exporting…' : 'Export image ↗';
    ui.export.setAttribute('aria-busy', String(session.exporting));
    ui.render.title = blocked
      ? 'The delivered bundle could not be verified; run delivery again before updating it.'
      : '';
    ui.render.textContent = session.renderState === 'rendering' ? 'Rendering…' : 'Render preview';
    // Viewing the layer structure is not publishing and never waits on save,
    // so neither a conflict nor a blocked delivery disables it.
    syncView();
  }

  async function toggleView() {
    const view = viewState();
    if (!session.ready || !view.ed || view.transitioning || view.layers === 0) return;
    try {
      await view.ed.setExploded(!view.exploded);
      clearBanner('view');
    } catch (error) {
      setBanner('view', 'failed', 'The layer view did not change.', error.message);
    } finally {
      syncView();
    }
  }

  /** Track the delivered product reported by the Runtime (or its blocked state). */
  function applyDelivery(delivery) {
    const wasBlocked = session.deliveryNote !== '';
    session.delivery = delivery || null;
    const blocked = Boolean(delivery && delivery.verified === false);
    const note = blocked ? String(delivery.blocked || 'The delivered bundle cannot be verified.') : '';
    if (blocked) {
      if (note !== session.deliveryNote)
        setBanner(
          'delivery',
          'failed',
          'Delivered file not verified.',
          `${note} Saving the author source still works; the delivered file is not overwritten until it is repaired or delivered again.`,
        );
      // The bytes are not trustworthy: never offer them for download, even
      // before the next state change redraws the footer.
      ui.download.hidden = true;
    } else {
      clearBanner('delivery');
      // A later successful verification can clear a block without a new render;
      // restore the product line and download the blocked state hid.
      if (wasBlocked && session.result) showResult();
    }
    session.deliveryNote = note;
    refreshButtons();
  }

  function setRenderState(state, detail = '') {
    session.renderState = state;
    ui.outState.dataset.state = state;
    refreshButtons();
    switch (state) {
      case 'not-rendered':
        ui.outState.textContent = 'Not rendered';
        ui.outDetail.textContent = detail || 'No output for this target yet.';
        ui.download.hidden = true;
        break;
      case 'rendering':
        ui.outState.textContent = 'Rendering';
        ui.outDetail.textContent = detail || 'Saving the source, then rendering the target…';
        break;
      case 'success':
        ui.outState.textContent = 'Rendered';
        showResult(detail);
        break;
      case 'stale':
        ui.outState.textContent = 'Stale';
        showResult(detail || 'The saved source is newer than this output — render again to update it.');
        break;
      case 'publish-failed':
        ui.outState.textContent = 'Delivered file not updated';
        showResult(detail);
        break;
      case 'failed':
        ui.outState.textContent = 'Render failed';
        ui.outDetail.textContent = detail || 'The render did not produce an output.';
        ui.download.hidden = !session.result || !session.result.path ? true : false;
        break;
      default:
        ui.outState.textContent = state;
        ui.outDetail.textContent = detail;
    }
  }

  function authorizedUrl(href) {
    if (!token || !href) return href;
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return href;
      if (!url.searchParams.has('token')) url.searchParams.set('token', token);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return href;
    }
  }

  function showResult(note) {
    const result = session.result;
    const delivery = session.delivery;
    if (!result) {
      setRenderState('not-rendered', note);
      return;
    }
    const width = Number(result.width) || 0;
    const height = Number(result.height) || 0;
    const format = String((delivery && delivery.format) || (session.target && session.target.format) || 'png').toUpperCase();
    // When bound, the stable delivered product is what the user has and what a
    // render updates — show it instead of the internal immutable Artifact path.
    const shownPath = delivery && delivery.path ? delivery.path : (result.path || result.artifact || 'output');
    const parts = [];
    if (!session.target) {
      if (width && height) parts.push(`${width}×${height}`);
      parts.push(format);
    }
    parts.push(delivery && delivery.path ? `delivered → ${delivery.path}` : 'Image ready to export');
    ui.outDetail.textContent = note ? `${parts.join(' · ')} — ${note}` : parts.join(' · ');
    ui.outDetail.title = shownPath;
    if (result.simulated) {
      const badge = document.createElement('span');
      badge.className = 'wb-simulated';
      badge.textContent = 'simulated';
      badge.title = 'This output came from a test/simulated backend, not a real generated service.';
      ui.outDetail.append(badge);
    }
    const href = result.url || (session.target && token
      ? `${ENDPOINTS.output}?target=${encodeURIComponent(session.target.id)}&token=${encodeURIComponent(token)}`
      : '');
    if (href) {
      // A download is a navigation, not a fetch: it cannot carry the token
      // header, so the same-origin fallback URL must carry it in the query.
      ui.download.hidden = false;
      ui.download.href = authorizedUrl(href);
      const name = basename(shownPath) || `${session.target ? session.target.id : 'output'}.${String((session.target && session.target.format) || 'png').toLowerCase()}`;
      ui.download.setAttribute('download', name);
      ui.download.title = shownPath || href;
    } else {
      ui.download.hidden = true;
    }
    if (delivery && delivery.blocked) {
      // The Runtime re-inspected the bundle and cannot trust its bytes (edited
      // product, replaced/removed record). Do not offer the download, and say
      // why in the same line the product would otherwise be claimed.
      ui.download.hidden = true;
      ui.outDetail.textContent = `${parts.join(' · ')} — the delivered file cannot be verified: ${delivery.blocked}`;
    }
  }

  /* ---------------------------------------------------------------
   * Resource URLs: rewrite for preview, restore for the saved source
   *
   * The server hands back resources as { path, url } because the
   * document is served as text, not from its own directory. The
   * preview needs absolute URLs; the saved source must keep the
   * author's portable relative references.
   * ------------------------------------------------------------- */

  function rewriteResources(html, resources) {
    const map = new Map();
    for (const resource of resources || []) {
      if (!resource || typeof resource.path !== 'string' || typeof resource.url !== 'string') continue;
      map.set(resource.path, authorizedUrl(resource.url));
    }
    // Resource declarations are Project-relative; author URLs are relative to
    // the document, just as in formal capture. A nested author/poster.html may
    // legitimately use ../assets/font.woff2 without escaping the Project.
    const documentUrl = new URL(
      '/' + session.document.path.split('/').map(encodeURIComponent).join('/'),
      location.origin,
    );
    const reverse = new Map();
    const unresolved = new Map();   // original ref -> occurrence count

    const localRef = (value) => {
      const raw = String(value || '').trim();
      if (!raw || raw.startsWith('#') || raw.startsWith('//')) return false;
      if (/^(data|blob|mailto|tel|javascript):/i.test(raw)) return false;
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false;
      return true;
    };
    const resolveRef = (value) => {
      const raw = String(value || '').trim();
      if (!localRef(raw)) return null;
      try {
        const reference = new URL(raw, documentUrl);
        if (reference.origin !== location.origin) return null;
        const mapped = map.get(decodeURIComponent(reference.pathname.slice(1)));
        if (!mapped) return null;
        const url = new URL(mapped, location.href);
        for (const [key, value] of reference.searchParams) {
          if (key !== 'token') url.searchParams.append(key, value);
        }
        url.hash = reference.hash;
        return `${url.pathname}${url.search}${url.hash}`;
      } catch {
        return null;
      }
    };
    // A reference the document loads but the Runtime did not declare as a
    // resource. It is never rewritten; it is reported instead of being allowed
    // to fail silently (or to point outside the Project unnoticed).
    const noteUnresolved = (value) => {
      const raw = String(value || '').trim();
      if (!localRef(raw)) return;
      unresolved.set(raw, (unresolved.get(raw) || 0) + 1);
    };

    const rewriteCss = (css) => String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, ref) => {
      const url = resolveRef(ref);
      if (!url) {
        noteUnresolved(ref);
        return match;
      }
      // A stylesheet/image request is made by the frame itself, so it cannot
      // send the token header; the same-origin URL must carry the token.
      const authorized = authorizedUrl(url);
      if (!reverse.has(authorized)) reverse.set(authorized, ref);
      return `url(${quote || ''}${authorized}${quote || ''})`;
    });

    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const element of doc.querySelectorAll('*')) {
      const tag = element.tagName.toLowerCase();
      for (const attribute of ['src', 'href', 'poster', 'xlink:href']) {
        if (!element.hasAttribute(attribute)) continue;
        // href on an anchor is navigation, not a resource this page loads.
        if (attribute === 'href') {
          if (tag === 'link') {
            const rel = (element.getAttribute('rel') || '').toLowerCase();
            // A favicon/manifest/canonical is not part of the design surface.
            if (rel && !/(^|\s)(stylesheet|preload|modulepreload)(\s|$)/.test(rel)) continue;
          } else if (element.namespaceURI !== 'http://www.w3.org/2000/svg' || (tag !== 'image' && tag !== 'use')) {
            continue;
          }
        }
        if (attribute === 'xlink:href' && tag !== 'image' && tag !== 'use') continue;
        const original = element.getAttribute(attribute);
        const url = resolveRef(original);
        if (!url) {
          noteUnresolved(original);
          continue;
        }
        const authorized = authorizedUrl(url);
        if (!reverse.has(authorized)) reverse.set(authorized, original);
        element.setAttribute(attribute, authorized);
      }
      if (element.hasAttribute('srcset')) {
        const rewritten = element.getAttribute('srcset').split(',').map((candidate) => {
          const parts = candidate.trim().split(/\s+/);
          if (!parts[0]) return candidate;
          const url = resolveRef(parts[0]);
          if (!url) {
            noteUnresolved(parts[0]);
            return candidate;
          }
          const authorized = authorizedUrl(url);
          if (!reverse.has(authorized)) reverse.set(authorized, parts[0]);
          return [authorized, ...parts.slice(1)].join(' ');
        }).join(', ');
        element.setAttribute('srcset', rewritten);
      }
      if (element.hasAttribute('style')) element.setAttribute('style', rewriteCss(element.getAttribute('style')));
    }
    for (const style of doc.querySelectorAll('style')) style.textContent = rewriteCss(style.textContent);

    const doctype = /^\s*<!doctype/i.test(html) ? '<!doctype html>\n' : '';
    return { html: doctype + doc.documentElement.outerHTML, reverse, unresolved: [...unresolved.keys()] };
  }

  /* ---------------------------------------------------------------
   * Layout record
   *
   * The saved document is the author's own source plus one small
   * JSON record of what the user changed. The source is never
   * re-serialized from the executed page: an author script may
   * build part of the design on every load, and writing those
   * generated nodes back next to their own script would duplicate
   * them on the next open.
   *
   * Read/gate/apply live in `layout-record.js`, loaded by this page
   * and injected by the formal still capture. The record is applied
   * only when the rest of the source is byte-identical to what was
   * saved. If someone edited the source in the meantime, the source
   * wins — a browser-side record must never overwrite an author
   * change.
   * ------------------------------------------------------------- */

  function emptyRecord(record) {
    return !record || (!record.layers.length && !record.texts.length
      && !record.fonts.length && !record.removed.length);
  }

  function embedLayoutRecord(body, record) {
    if (emptyRecord(record)) return body;
    const payload = JSON.stringify({ ...record, sourceHash: Layout.hash(body) }).replace(/</g, '\\u003c');
    const tag = `<script type="application/json" data-viscraft-layout>${payload}</script>\n`;
    if (/<\/head>/i.test(body)) return body.replace(/<\/head>/i, `${tag}</head>`);
    return tag + body;
  }

  /* ---------------------------------------------------------------
   * Mount the author document and the editor
   * ------------------------------------------------------------- */

  function waitFor(predicate, timeout, message) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        let value = false;
        try {
          value = predicate();
        } catch {
          value = false;
        }
        if (value) return resolve(value);
        if (Date.now() - started > timeout) return reject(new Error(message));
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  function reportUnresolved(references) {
    const list = (items) => items.slice(0, 3).map((ref) => `“${ref}”`).join(', ')
      + (items.length > 3 ? ` and ${items.length - 3} more` : '');
    setBanner(
      'references',
      'notice',
      'Some references stay unresolved.',
      `${references.length} local reference${references.length === 1 ? '' : 's'} do not resolve to declared document resources (${list(references)}). They are kept unchanged in the source and will not load in this preview. Check paths relative to the document and declare real inputs as Project-relative document resources.`,
    );
  }

  async function mount(sourceHtml, { editable }) {
    session.ready = false;
    refreshButtons();
    session.servedBody = Layout.strip(sourceHtml);
    session.lastHtml = sourceHtml;

    const { html, unresolved } = rewriteResources(sourceHtml, session.resources);
    if (unresolved && unresolved.length) reportUnresolved(unresolved);

    const frame = ui.frame;
    frame.hidden = false;
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The design did not finish loading within 30s.')), 30000);
      frame.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    frame.srcdoc = html;
    await loaded;

    const doc = frameDoc();
    if (!doc) throw new Error('The design loaded in a frame this page cannot inspect.');

    Layout.apply(sourceHtml, doc);

    if (!editable) {
      session.editable = false;
      session.ready = true;
      refreshButtons();
      return;
    }

    if (!doc.querySelector('[data-canvas-width]')) {
      const error = new Error('This document has no editable canvas: it needs a fixed frame declaring data-canvas-width and data-canvas-height.');
      error.code = 'no-canvas';
      throw error;
    }

    await injectEditor(doc, Layout.active(sourceHtml));
    // Reset/Undo reset and recovery remount the iframe, not the editing session.
    // Keep Reset layout anchored to the same opening geometry across those mounts.
    if (session.openingLayout) editor().state.resetLayout = new Map(session.openingLayout);

    session.editable = true;
    session.ready = true;
    const ed = editor();
    session.lastSignature = signature();
    session.lastHtml = session.lastSignature || sourceHtml;
    if (ed && ed.layers().length === 0) {
      setBanner('notice', 'notice', 'No editable layers.', 'This document declares a canvas but no data-layer-id units, so only rendering is available.');
    }
    refreshButtons();
  }

  async function injectEditor(doc, record) {
    if (!doc.head) throw new Error('The design document has no <head>, so the editor cannot be attached.');
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = editorCssUrl;
    let cssLoaded = false;
    const cssReady = new Promise((resolve) => {
      link.addEventListener('load', () => { cssLoaded = true; resolve(); }, { once: true });
      link.addEventListener('error', () => resolve(), { once: true });
      setTimeout(resolve, 5000);
    });
    doc.head.append(link);
    await cssReady;
    if (!cssLoaded) throw new Error('The layer editor stylesheet did not load, so the canvas geometry would be measured without it.');

    // The editor diffs against the author source, not against the DOM it is
    // handed: the page a reopened save shows already contains the recorded
    // edits, so the editor needs to know they are not the user's new work.
    ui.frame.contentWindow.__viscraftInitEdits = record || null;
    const script = doc.createElement('script');
    script.src = editorJsUrl;
    doc.head.append(script);

    await waitFor(
      () => {
        const win = ui.frame.contentWindow;
        return Boolean(win && win.__layerEditor && doc.documentElement.dataset.hfReady === '1');
      },
      TIMING.editorReady,
      'The layer editor did not start. The document may be blocked from running scripts, or its fonts/images never settled.',
    );

    const win = ui.frame.contentWindow;
    win.__viscraftWorkbench = {
      changed: () => noteEdit(),
      save: () => { void manualSave(); },
      viewChanged: () => refreshButtons(),
      resetAll: () => { void resetAllEdits(); },
      undoReset: () => banners.get('reset')?.querySelector('button')?.click(),
    };
  }

  /* ---------------------------------------------------------------
   * Editing and the save queue
   * ------------------------------------------------------------- */

  // The exact document a save would write: the author source as loaded, plus
  // the edit record for what the user changed. This is also the change
  // signature the page polls, so what marks the page dirty and what reaches
  // disk are the same thing.
  function serializeDocument({ commit = false } = {}) {
    const ed = editor();
    if (!ed) throw new Error('The editor is not ready, so this page cannot serialize the design.');
    return embedLayoutRecord(session.servedBody, ed.editState({ commit }));
  }

  function signature() {
    try {
      return serializeDocument({ commit: false });
    } catch {
      return '';
    }
  }

  function noteEdit() {
    if (!session.ready || !session.editable || session.reloading) return;
    const next = signature();
    if (!next || next === session.lastSignature) return;
    session.lastSignature = next;
    session.editSeq += 1;
    clearBanner('reset');
    if (session.saveState === 'conflict') {
      scheduleRecovery();
      updateConflictBanner();
      return;
    }
    if (session.saveState === 'saving') return;
    if (next === session.lastHtml) {
      session.savedSeq = session.editSeq;
      clearAutoSaveTimers();
      clearRecovery();
      clearBanner('failed');
      setSaveState(session.savedAt ? 'saved' : 'clean', session.savedAt);
      return;
    }
    scheduleRecovery();
    setSaveState('pending');
    scheduleAutoSave();
  }

  // Remount an edit state without moving the opening-session or disk-confirmed
  // baselines. Reloading the saved source is the explicit boundary for a new one.
  async function replaceEdits(html) {
    clearAutoSaveTimers();
    if (session.savePromise) await session.savePromise;
    if (session.saveState === 'conflict') return false;
    if (Layout.strip(html) !== session.servedBody)
      throw new Error('The author source changed. Reload it before resetting workbench edits.');
    const confirmed = session.lastHtml;
    const previous = session.lastSignature;
    await mount(html, { editable: Boolean(token) });
    session.lastHtml = confirmed;
    session.lastSignature = previous;
    noteEdit();
    return true;
  }

  async function resetAllEdits() {
    const reset = ui.frame.contentDocument?.getElementById('hf-reset-all');
    if (!reset || reset.disabled) return;
    if (!window.confirm('Reset all edits made since this design was opened, including edits already saved or exported? Changes saved before this editing session will be kept.')) return;
    const before = serializeDocument({ commit: true });
    try {
      if (!await replaceEdits(session.openingHtml)) return;
      setBanner('reset', 'notice', 'This session’s edits reset.', 'The design is back to how it was when opened. Export image to update and download the output.', [
        { label: 'Undo reset', run: async () => {
          try {
            await replaceEdits(before);
            clearBanner('reset');
          } catch (error) { showFailureBanner(error.message); }
        } },
      ]);
    } catch (error) {
      showFailureBanner(error.message);
    }
  }

  function scheduleAutoSave() {
    clearTimeout(session.debounceTimer);
    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = null;
      void autoSave();
    }, TIMING.saveDebounce);
    if (!session.maxWaitTimer) {
      session.maxWaitTimer = setTimeout(() => {
        session.maxWaitTimer = null;
        void autoSave();
      }, TIMING.saveMaxWait);
    }
  }

  function clearAutoSaveTimers() {
    clearTimeout(session.debounceTimer);
    clearTimeout(session.maxWaitTimer);
    session.debounceTimer = null;
    session.maxWaitTimer = null;
  }

  async function autoSave() {
    if (!session.ready || !session.editable || !token || session.reloading) return;
    if (session.saving || session.saveState === 'conflict') return;
    if (session.editSeq === session.savedSeq) return;
    // An in-progress text edit is reported as it is on screen (see
    // serializeDocument) so typing really reaches disk while the caret keeps
    // its place. A manual save/render, Enter and in-frame Ctrl/Cmd+S commit it.
    await runSave({ commit: false });
  }

  function runSave({ commit = true } = {}) {
    if (session.savePromise) return session.savePromise;
    if (!token) return Promise.resolve('failed');
    if (session.saveState === 'conflict') return Promise.resolve('conflict');

    session.savePromise = (async () => {
      let html;
      try {
        html = serializeDocument({ commit });
      } catch (error) {
        setSaveState('failed');
        showFailureBanner(error.message);
        return 'failed';
      }

      if (session.lastHtml !== null && html === session.lastHtml) {
        session.savedSeq = session.editSeq;
        session.lastSignature = html;
        clearRecovery();
        // Nothing was written: never claim a save that did not happen.
        setSaveState(session.savedAt ? 'saved' : 'clean', session.savedAt);
        return 'saved';
      }

      const seq = session.editSeq;

      session.saving = true;
      clearAutoSaveTimers();
      setSaveState('saving');
      try {
        const res = await api('PUT', ENDPOINTS.document, {
          document: session.document.id,
          baseRevision: session.baseRevision,
          baseContentHash: session.baseContentHash,
          html,
        }, { timeout: TIMING.saveRequest });

        if (res.status === 409 && res.payload && res.payload.error === 'conflict') {
          openConflict(res.payload.current || null, html);
          return 'conflict';
        }
        if (!res.ok) throw new Error(`Saving the source failed. ${describe(res)}`);

        const payload = res.payload || {};
        if (typeof payload.revision !== 'number' || typeof payload.contentHash !== 'string')
          throw new Error('The Runtime accepted the save but returned no revision/contentHash, so this page cannot safely continue.');

        session.baseRevision = payload.revision;
        session.baseContentHash = payload.contentHash;
        session.savedAt = payload.savedAt || Date.now();
        session.lastHtml = html;
        session.savedSeq = seq;
        clearBanner('failed');
        clearBanner('conflict');
        session.conflict = null;

        const current = signature();
        session.lastSignature = current;
        if (current !== html) {
          // A caret edit can arrive before the next edit poll announces it.
          // The current content still needs a save even if its counter has
          // not advanced yet.
          if (session.editSeq === seq) session.editSeq += 1;
          setSaveState('pending');
          scheduleRecovery();
          scheduleAutoSave();
        } else {
          session.savedSeq = session.editSeq;
          setSaveState('saved', session.savedAt);
          clearRecovery();
        }
        refreshStale();
        return 'saved';
      } catch (error) {
        setSaveState('failed');
        showFailureBanner(error.message);
        return 'failed';
      }
    })().finally(() => {
      session.saving = false;
      session.savePromise = null;
      refreshButtons();
    });

    return session.savePromise;
  }

  function flush() {
    if (session.flushPromise) return session.flushPromise;
    session.flushPromise = (async () => {
      clearAutoSaveTimers();
      while (session.saving && session.savePromise) await session.savePromise;
      let guard = 0;
      for (;;) {
        guard += 1;
        if (session.saveState === 'conflict') return 'conflict';
        const ed = editor();
        const editing = Boolean(ed && typeof ed.isEditing === 'function' && ed.isEditing());
        // A snapshot autosave can leave the text session open with the edit
        // counter already settled. Clicking the outer Save/Render button must
        // still commit it (endEdit + refit), not report "no changes".
        if (!editing && session.editSeq === session.savedSeq) break;
        if (guard > 40) break;
        const outcome = await runSave();
        if (outcome === 'failed' || outcome === 'conflict') return outcome;
        if (session.saving && session.savePromise) await session.savePromise;
      }
      if (session.saveState === 'conflict') return 'conflict';
      if (session.saveState === 'failed') return 'failed';
      return session.editSeq === session.savedSeq ? 'saved' : 'pending';
    })().finally(() => {
      session.flushPromise = null;
    });
    return session.flushPromise;
  }

  async function manualSave() {
    if (!session.ready || !session.editable) return;
    if (!token) {
      notice('This page has no session token, so it cannot write to the design.');
      return;
    }
    if (session.saveState === 'conflict') {
      updateConflictBanner();
      return;
    }
    const hadEdits = session.editSeq !== session.savedSeq;
    const outcome = await flush();
    if (outcome === 'saved' && !hadEdits) notice('No changes to save.');
    else if (outcome === 'saved' && session.editSeq === session.savedSeq)
      notice(`Saved to ${session.document ? session.document.path : 'the author source'}.`);
    else if (outcome === 'pending') setSaveState('pending');
  }

  function showFailureBanner(message) {
    setBanner('failed', 'failed', 'Not saved.', message, [
      { label: 'Retry save', run: () => { void manualSave(); } },
    ]);
  }

  /* ---------------------------------------------------------------
   * Conflict
   * ------------------------------------------------------------- */

  function openConflict(current, body) {
    session.conflict = current || { revision: null, contentHash: null };
    setSaveState('conflict');
    clearBanner('notice');
    clearBanner('reset');
    clearTimeout(session.noticeTimer);
    // The source on disk is now different from the one this output was rendered
    // from, so the output is real but no longer current.
    if (session.result && session.renderFrom && session.conflict.contentHash
      && session.conflict.contentHash !== session.renderFrom && session.renderState === 'success') {
      setRenderState('stale', 'The saved source changed after this output was rendered — render again to update it.');
    }
    updateConflictBanner();
    try {
      if (body && recoveryKey) localStorage.setItem(recoveryKey, JSON.stringify({
        document: documentId,
        baseRevision: session.baseRevision,
        savedAt: Date.now(),
        body,
      }));
    } catch {
      // recovery is best effort
    }
    refreshButtons();
  }

  function updateConflictBanner() {
    const current = session.conflict || {};
    const revision = current.revision === undefined || current.revision === null ? 'unknown' : `revision ${current.revision}`;
    const pending = Math.max(0, session.editSeq - session.savedSeq);
    setBanner(
      'conflict',
      'conflict',
      'The source changed outside this page.',
      `Your ${pending === 1 ? 'edit is' : `${pending} edits are`} kept here and were not written (disk is at ${revision}). Reload the source, or overwrite it with what you see.`,
      [
        { label: 'Reload source', run: () => { void reloadFromDisk(); } },
        { label: 'Overwrite source', run: () => { void overwriteSource(); } },
      ],
    );
  }

  async function overwriteSource() {
    if (!session.conflict) return;
    let current = session.conflict;
    if (typeof current.revision !== 'number' || typeof current.contentHash !== 'string') {
      try {
        const res = await api('GET', `${ENDPOINTS.status}?document=${encodeURIComponent(documentId)}`, undefined, { timeout: 8000 });
        if (res.ok && res.payload && res.payload.document) current = res.payload.document;
      } catch {
        // fall through to the confirmation below
      }
    }
    const known = typeof current.revision === 'number' && typeof current.contentHash === 'string';
    const revision = known ? `revision ${current.revision}` : 'an unknown revision';
    if (!window.confirm(`Overwrite ${session.document ? session.document.path : 'the author source'} at ${revision} with the edits from this page? The other session's changes will be replaced.`)) return;
    if (!known) {
      notice('The Runtime did not report the current revision, so the overwrite cannot be based on it. Reload the source and try again.');
      return;
    }

    session.baseRevision = current.revision;
    session.baseContentHash = current.contentHash;
    session.conflict = null;
    clearBanner('conflict');
    setSaveState('pending');
    const outcome = await flush();
    if (outcome === 'conflict') updateConflictBanner();
    else if (outcome === 'saved') notice('Overwrote the source with this page’s edits.');
  }

  async function reloadFromDisk() {
    if (session.editSeq !== session.savedSeq && !window.confirm('Discard the edits in this page and load the saved source from disk?')) return;
    clearRecovery();
    await loadDocument({ reason: 'reload' });
  }

  /* ---------------------------------------------------------------
   * External-change detection
   * ------------------------------------------------------------- */

  // Consume the result the server reports FOR THIS POLL. Its identity
  // (`build`/`artifact`) and `stale` flag are authoritative: a declared
  // resource (e.g. a stylesheet) can change with the document revision and
  // contentHash untouched, and only the server's render key can see that.
  function applyServerResult(reported, delivery) {
    if (session.renderState === 'rendering') return;
    // After a failed publication the page shows the render the user made and
    // the real publication error. The Runtime's status view still describes the
    // delivered (old) Build, so letting it through would erase that error and
    // claim the older output is what the page shows.
    if (session.publishError) return;
    // The delivered product is reported independently of the Artifact result:
    // keep it in step so the footer always names the file the user actually has.
    applyDelivery(delivery);
    if (!reported || typeof reported.path !== 'string') {
      // The Runtime no longer reports a usable output (e.g. the artifact file
      // was removed). Do not keep claiming the old one is current.
      if (!session.result) return;
      session.result = null;
      session.renderFrom = null;
      setRenderState('not-rendered', 'The Runtime no longer reports an output for this target.');
      return;
    }
    const previous = session.result;
    const changed = !previous || previous.build !== reported.build || previous.artifact !== reported.artifact;
    session.result = reported;
    session.renderFrom = reported.stale ? null : session.baseContentHash;
    if (reported.stale) {
      if (session.renderState === 'success' || session.renderState === 'stale' || changed) {
        setRenderState('stale', changed
          ? 'The Runtime has a different output than the one this page last showed.'
          : 'A declared resource changed since this output was rendered — render again to update it.');
      }
      return;
    }
    if (session.renderState !== 'failed' && (session.renderState === 'stale' || changed)) setRenderState('success');
  }

  async function pollStatus() {
    if (!session.ready || !session.editable || session.saving || session.renderState === 'rendering') return;
    if (session.saveState === 'conflict' || session.reloading || document.hidden) return;
    const baseRevision = session.baseRevision;
    const baseContentHash = session.baseContentHash;
    const stateSeq = session.stateSeq;
    let res;
    try {
      res = await api('GET', `${ENDPOINTS.status}?document=${encodeURIComponent(documentId)}`, undefined, { timeout: 8000 });
    } catch {
      return; // transient; the next poll retries
    }
    // A save/render that landed while this request was in flight makes the
    // answer describe an older state. Never let an old response overwrite the
    // dirty/conflict state of the newer save; the next poll observes it.
    if (session.saving || session.reloading || session.renderState === 'rendering') return;
    if (stateSeq !== session.stateSeq) return;
    if (session.baseRevision !== baseRevision || session.baseContentHash !== baseContentHash) return;
    if (!res.ok || !res.payload || !res.payload.document) return;
    const current = res.payload.document;
    if (typeof current.revision !== 'number' || typeof current.contentHash !== 'string') return;
    if (current.revision === session.baseRevision && current.contentHash === session.baseContentHash) {
      // The source this page is based on is still current. The recorded result
      // may nevertheless be stale (a resource changed); take the server's view.
      applyServerResult(res.payload.result, res.payload.delivery);
      return;
    }
    const dirty = session.editSeq !== session.savedSeq || session.saveState === 'failed';
    if (dirty) {
      openConflict({ revision: current.revision, contentHash: current.contentHash }, null);
      return;
    }
    const ed = editor();
    if (ed && typeof ed.isEditing === 'function' && ed.isEditing()) return;
    notice('The source changed outside this page; reloading the saved version.');
    await loadDocument({ reason: 'external' });
  }

  /* ---------------------------------------------------------------
   * Load / reload
   * ------------------------------------------------------------- */

  async function loadDocument({ reason = 'initial' } = {}) {
    if (!documentId || session.reloading) return;
    session.reloading = true;
    session.ready = false;
    clearAutoSaveTimers();
    setPhase('loading');
    if (reason !== 'reload') showOverlay('Loading design…', 'Reading the author source from the Runtime.');
    try {
      const res = await api('GET', `${ENDPOINTS.document}?document=${encodeURIComponent(documentId)}`, undefined, { timeout: 20000 });
      if (!res.ok) throw new Error(`Could not read the design. ${describe(res)}`);
      const payload = res.payload;
      if (!payload || typeof payload.html !== 'string' || !payload.document || !payload.document.id)
        throw new Error('The Runtime returned no document. Is that document registered in this Project?');

      applyDocument(payload);
      await mount(payload.html, { editable: Boolean(token) });
      session.openingHtml = session.lastSignature;
      session.openingLayout = [...editor().state.resetLayout.entries()];
      hideOverlay();
      setPhase('mounted');

      if (reason === 'external') notice('Reloaded the version saved on disk.');
      else if (reason === 'reload') notice('Loaded the saved source from disk.');
      refreshButtons();
      refreshStale();
      offerRecovery();
    } catch (error) {
      if (error.code === 'no-canvas') {
        setPhase('preview');
        hideOverlay();
        session.ready = true;
        session.editable = false;
        setBanner('notice', 'notice', 'Preview only.', `${error.message} The source is shown as saved; saving is unavailable here, rendering still uses the registered target.`);
        hideOverlay();
        refreshButtons();
        return;
      }
      fatal('Could not open the design', error.message, () => { void loadDocument({ reason }); });
    } finally {
      session.reloading = false;
    }
  }

  function applyDocument(payload) {
    session.stateSeq += 1;
    session.document = payload.document;
    session.resources = Array.isArray(payload.resources) ? payload.resources : [];
    session.target = payload.target && payload.target.id ? payload.target : null;
    session.servedBody = Layout.strip(payload.html);
    session.openingHtml = null;
    session.openingLayout = null;
    session.lastHtml = payload.html;
    session.baseRevision = Number(payload.document.revision) || 0;
    session.baseContentHash = String(payload.document.contentHash || '');
    session.savedAt = null;
    session.editSeq = 0;
    session.savedSeq = 0;
    session.conflict = null;
    setSaveState('clean');
    session.result = payload.result || null;
    session.renderFrom = null;
    session.publishError = null;
    clearBanner('conflict');
    clearBanner('failed');
    clearBanner('recovery');
    clearBanner('notice');
    clearBanner('references');
    clearBanner('reset');
    applyDelivery(payload.delivery);

    document.title = `Viscraft · ${basename(payload.document.path) || payload.document.id}`;
    ui.title.textContent = basename(payload.document.path) || payload.document.id;
    ui.title.title = payload.document.path || payload.document.id;
    ui.path.textContent = payload.document.path || '';
    ui.path.title = payload.document.path || '';

    if (session.target) {
      const scale = Number(session.target.scale) || 1;
      const width = Number(session.target.logicalWidth || session.target.width) || 0;
      const height = Number(session.target.logicalHeight || session.target.height) || 0;
      const outW = Number(session.target.width) || 0;
      const outH = Number(session.target.height) || 0;
      const logical = width && height ? `${width}×${height}` : '';
      const output = outW && outH ? `${outW}×${outH}` : '';
      const format = String(session.target.format || '').toUpperCase();
      const head = [logical, scale !== 1 ? `@${scale}×` : ''].filter(Boolean).join(' ');
      ui.target.hidden = false;
      ui.target.textContent = [head, output, format].filter(Boolean).join(' → ');
      ui.target.title = `${session.target.id}${session.target.background ? ` · ${session.target.background}` : ''}`;
    } else {
      ui.target.hidden = true;
    }

    if (!session.target) {
      setRenderState('not-rendered', 'No image target is registered for this document, so there is nothing to render.');
    } else if (!session.result) {
      setRenderState('not-rendered');
    } else {
      session.renderFrom = session.result.stale ? null : session.baseContentHash;
      setRenderState(session.result.stale ? 'stale' : 'success');
    }

    if (requestedTarget && session.target && requestedTarget !== session.target.id)
      notice(`This page asked for target “${requestedTarget}”, but the Runtime served “${session.target.id}”. Rendering uses the served target.`);
  }

  function refreshStale() {
    if (!session.result) return;
    if (!session.renderFrom) {
      if (session.renderState === 'success') setRenderState('stale');
      return;
    }
    if (session.baseContentHash && session.baseContentHash !== session.renderFrom) {
      if (session.renderState === 'success') setRenderState('stale');
    } else if (session.renderState === 'stale' && !session.result.stale) {
      setRenderState('success');
    }
  }

  /* ---------------------------------------------------------------
   * Render + output
   * ------------------------------------------------------------- */

  async function renderTarget() {
    if (!token || !session.ready || !session.target) return;
    if (session.renderState === 'rendering') return;
    if (session.saveState === 'conflict') {
      updateConflictBanner();
      return;
    }
    if (session.editable) {
      setRenderState('rendering', 'Saving the current source, then rendering the target…');
      const outcome = await flush();
      if (outcome === 'conflict') {
        setRenderState('failed', 'Not rendered: the source is in conflict. Resolve the save first.');
        return;
      }
      if (outcome !== 'saved') {
        setRenderState('failed', 'Not rendered: the current edits are not saved yet. Fix the save first.');
        return;
      }
    }

    const from = session.baseContentHash;
    const fromHtml = session.lastHtml;
    session.publishError = null;
    setRenderState('rendering', `Rendering ${session.target.id} from the saved source…`);
    try {
      const res = await api('POST', ENDPOINTS.render, { target: session.target.id }, { timeout: 300000 });
      if (res.status === 409) {
        if (res.payload && res.payload.error === 'conflict') {
          openConflict(null, null);
          setRenderState('failed', 'Not rendered: the source changed during the render.');
        } else {
          setRenderState('failed', 'Not rendered: the Runtime says the source is not saved (it may have changed after the save).');
        }
        return;
      }
      if (res.status === 500 && res.payload && res.payload.error === 'publish-failed') {
        // The render itself succeeded; only publishing it into the delivered
        // bundle failed. Show the real error and report that the previously
        // delivered file is unchanged (the download still serves THAT file).
        session.result = res.payload.result || null;
        applyDelivery(res.payload.delivery || session.delivery);
        session.stateSeq += 1;
        session.renderFrom = from;
        const detail = String(res.payload.message || 'unknown publication error');
        session.publishError = detail;
        setRenderState('publish-failed', `The delivered file was not updated: ${detail} The delivered file still holds the previous image; render again to retry.`);
        return;
      }
      if (!res.ok) throw new Error(`Rendering failed. ${describe(res)}`);
      const payload = res.payload || {};
      if (typeof payload.path !== 'string' || !payload.path)
        throw new Error('The Runtime reported success but returned no output path, so this page cannot show the result.');

      session.result = payload;
      applyDelivery(payload.delivery || session.delivery);
      session.stateSeq += 1;
      session.renderFrom = from;
      const newerSaved = session.baseContentHash && session.baseContentHash !== from;
      const newerEdits = signature() !== fromHtml;
      if (payload.stale || newerSaved || newerEdits) {
        setRenderState('stale', newerSaved || newerEdits
          ? 'The output was produced from the version saved before your latest edit; render again for the newest source.'
          : 'The Runtime marks this output as stale for the saved source.');
      } else {
        setRenderState('success');
        return { payload, contentHash: from, html: fromHtml };
      }
    } catch (error) {
      setRenderState('failed', error.message);
    }
  }

  async function exportImage() {
    if (ui.export.disabled || session.exporting) return;
    session.exporting = true;
    refreshButtons();
    try {
      // A current Build is reused by the Runtime. Going through the render
      // entry also checks changed resources rather than trusting a UI badge.
      const rendered = await renderTarget();
      if (!rendered) return;
      const response = await fetch(authorizedUrl(rendered.payload.url), {
        headers: { 'X-Viscraft-Token': token }, cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`The rendered image could not be downloaded (HTTP ${response.status}).`);
      const bytes = await response.blob();
      if (session.baseContentHash !== rendered.contentHash || signature() !== rendered.html) {
        setRenderState('stale', 'The design changed during export. Export again to download the current image.');
        return;
      }
      const url = URL.createObjectURL(bytes);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${session.target.id}.${session.target.format}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      notice('Image exported. Your editable design is saved.');
    } catch (error) {
      setBanner('export', 'failed', 'Image not exported.', error.message);
    } finally {
      session.exporting = false;
      refreshButtons();
    }
  }

  /* ---------------------------------------------------------------
   * Recovery aid (never authority, never shown as saved)
   * ------------------------------------------------------------- */

  function scheduleRecovery() {
    if (!recoveryKey || session.recoveryTimer || !session.editable) return;
    session.recoveryTimer = setTimeout(() => {
      session.recoveryTimer = null;
      writeRecovery();
      if (session.editSeq !== session.savedSeq) scheduleRecovery();
    }, TIMING.recoveryThrottle);
  }

  function writeRecovery() {
    if (!recoveryKey || !session.editable || session.editSeq === session.savedSeq) return;
    try {
      const body = serializeDocument({ commit: false });
      localStorage.setItem(recoveryKey, JSON.stringify({
        document: documentId,
        baseRevision: session.baseRevision,
        savedAt: Date.now(),
        body,
      }));
    } catch {
      // storage can be full or disabled; recovery is optional
    }
  }

  function clearRecovery() {
    if (!recoveryKey) return;
    clearTimeout(session.recoveryTimer);
    session.recoveryTimer = null;
    try {
      localStorage.removeItem(recoveryKey);
    } catch {
      // ignore
    }
    clearBanner('recovery');
  }

  function readRecovery() {
    if (!recoveryKey) return null;
    try {
      const raw = localStorage.getItem(recoveryKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.document !== documentId || typeof parsed.body !== 'string' || !parsed.body) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function offerRecovery() {
    if (!token) return;   // no session token: this page cannot save anything
    const recovery = readRecovery();
    if (!recovery) return;
    if (recovery.body === session.lastHtml) {
      clearRecovery();
      return;
    }
    setBanner(
      'recovery',
      'recovery',
      'Unsaved edits found in this browser.',
      `They were kept after a failed or interrupted save (${nowLabel(recovery.savedAt)}) and are not on disk.`,
      [
        {
          label: 'Restore edits',
          run: async () => {
            clearBanner('recovery');
            try {
              clearAutoSaveTimers();
              if (session.savePromise) await session.savePromise;
              if (session.saveState === 'conflict')
                throw new Error('Resolve the save conflict before restoring browser edits.');
              const confirmed = session.lastHtml;
              await mount(recovery.body, { editable: Boolean(token) });
              // Remounting edits does not confirm a disk save. Keep the last
              // acknowledged HTML until the normal save queue receives a reply.
              session.lastHtml = confirmed;
              session.editSeq = 1;
              session.savedSeq = 0;
              session.lastSignature = signature();
              setSaveState('pending');
              scheduleAutoSave();
              notice('Restored the browser copy. It is not saved until the Runtime confirms it.');
            } catch (error) {
              setBanner('failed', 'failed', 'Could not restore the browser copy.', error.message);
            }
          },
        },
        { label: 'Discard', run: () => { clearRecovery(); clearBanner('recovery'); } },
      ],
    );
  }

  /* ---------------------------------------------------------------
   * Init
   * ------------------------------------------------------------- */

  function fatal(title, text, retry) {
    showOverlay(title, text, 'error', retry ? { label: 'Try again', run: retry } : null);
    ui.save.disabled = true;
    ui.explode.disabled = true;
    const reset = ui.frame.contentDocument?.getElementById('hf-reset-all');
    if (reset) reset.disabled = true;
    ui.export.disabled = true;
    ui.render.disabled = true;
  }

  function bind() {
    ui.save.addEventListener('click', () => { void manualSave(); });
    ui.explode.addEventListener('click', () => { void toggleView(); });
    ui.export.addEventListener('click', () => { clearBanner('export'); void exportImage(); });
    ui.render.addEventListener('click', () => { void renderTarget(); });
    document.addEventListener('keydown', (event) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'z' && !event.shiftKey && session.ready && session.editable) {
        event.preventDefault();
        editor()?.undo();
        return;
      }
      if (event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void manualSave();
    });
    window.addEventListener('pagehide', () => {
      if (session.editSeq !== session.savedSeq) writeRecovery();
    });
    // The editor fits its canvas to the iframe viewport; the parent resizing
    // does not fire a resize inside the frame, so forward it.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          const win = ui.frame.contentWindow;
          if (win && win.__layerEditor) win.dispatchEvent(new Event('resize'));
        } catch {
          // the frame may be navigating
        }
      }, 120);
    });
    window.addEventListener('beforeunload', (event) => {
      if (session.editSeq === session.savedSeq) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  function pollEdits() {
    setInterval(() => {
      if (!session.ready || !session.editable) return;
      const next = signature();
      if (next === session.lastSignature) return;
      noteEdit();
    }, TIMING.editPoll);
  }

  async function boot() {
    bind();
    setSaveState('clean');

    if (!Layout) {
      fatal(
        'The workbench did not load completely.',
        'layout-record.js is missing, so this page cannot read or apply the saved edits. Reinstall the Viscraft Runtime package.',
      );
      return;
    }
    if (!documentId) {
      fatal('No design selected.', 'Open this page from the Viscraft Runtime (for example, after the image-edit command prints the workbench URL).');
      return;
    }
    if (!token) {
      fatal(
        'This workbench URL is incomplete.',
        'The session token is missing. Open the URL printed by the Runtime — it includes the token needed to read and write this design.',
      );
      return;
    }

    pollEdits();
    setInterval(() => { void pollStatus(); }, TIMING.statusPoll);

    await loadDocument({ reason: 'initial' });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void boot(); }, { once: true });
  else void boot();
})();
