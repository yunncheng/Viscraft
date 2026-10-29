/* ============================================================
   Shared edit-record semantics for editable image documents

   The author source is NEVER rewritten by the workbench. The
   workbench saves the document it loaded, byte for byte, plus one
   small JSON record describing only what the user actually
   changed: layer offsets, sizes, width/height locks, text slots,
   slot fonts and deleted layers.

   Keeping the source as authored matters because an author script
   may build part of the page on every load. Saving the executed DOM
   would embed the generated nodes next to the script that creates
   them, so every save/reopen cycle would multiply that content.
   A record of edits cannot do that: the script still owns its
   nodes, and the record only moves/renames/removes them.

   The record is also not a second layout authority. It is applied
   only when its `sourceHash` matches the rest of the source byte
   for byte. Any author edit changes that hash, so the source wins
   and the stale record is ignored.

   The SAME rules must hold in both places that consume a saved
   document:
     - the workbench preview (this file is loaded as a page script);
     - the formal still capture (`capture.ts` injects this file).

   Geometry is stored as an offset from wherever the author layout
   puts the layer (`dx`/`dy`), not as a baked absolute position:
   the preview bakes absolute coordinates for dragging, the formal
   capture renders the document as authored. An offset means the
   same thing in both, and it survives an author script that lays
   the page out again on load.
   ============================================================ */
(() => {
  'use strict';

  const TAG = /<script\b[^>]*\bdata-viscraft-layout\b[^>]*>[\s\S]*?<\/script>[ \t]*\r?\n?/gi;
  const ONE = /<script\b[^>]*\bdata-viscraft-layout\b[^>]*>([\s\S]*?)<\/script>/i;

  // FNV-1a over the exact saved text. The same function writes and checks
  // `sourceHash`, so the two consumers cannot drift.
  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(16).padStart(8, '0');
  }

  function strip(html) {
    return String(html).replace(TAG, '');
  }

  function read(html) {
    const match = String(html).match(ONE);
    if (!match) return null;
    try {
      const record = JSON.parse(match[1]);
      if (!record || record.version !== 1) return null;
      // A record written by an older editor carried baked geometry instead of
      // edits. It has no edit lists, so it is simply not this format: the
      // source renders as authored and the next save writes the current one.
      for (const key of ['layers', 'texts', 'fonts', 'removed']) {
        if (!Array.isArray(record[key])) return null;
      }
      return record;
    } catch {
      return null;
    }
  }

  // The record that is valid for THIS source text, or null when the source
  // changed after the record was written.
  function active(html) {
    const record = read(html);
    if (!record || typeof record.sourceHash !== 'string') return null;
    return record.sourceHash === hash(strip(html)) ? record : null;
  }

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function layerOf(doc, id) {
    return doc.querySelector(`[data-layer-id="${cssEscape(id)}"]`);
  }

  // A text slot is addressed by its child-index path from its layer. The
  // record stores no selector and no markup copy of the slot's surroundings,
  // so a document whose script rebuilds the same structure still resolves.
  function atPath(root, path) {
    let node = root;
    for (const index of path) {
      if (!node || !Number.isInteger(index) || index < 0) return null;
      node = node.children[index] || null;
    }
    return node;
  }

  // Apply the valid record to a live document. Returns what was applied; all
  // zeroes mean no record, an unusable one, or an inactive one.
  function apply(html, doc) {
    const done = { layers: 0, texts: 0, fonts: 0, removed: 0 };
    const record = active(html);
    if (!record || !doc) return done;

    for (const id of record.removed) {
      if (typeof id !== 'string' || !id) continue;
      const element = layerOf(doc, id);
      if (!element) continue;
      element.remove();
      done.removed += 1;
    }

    for (const edit of record.texts) {
      if (!edit || typeof edit.layer !== 'string' || !Array.isArray(edit.path)) continue;
      if (typeof edit.html !== 'string') continue;
      const slot = atPath(layerOf(doc, edit.layer), edit.path);
      if (!slot) continue;
      if (slot.innerHTML === edit.html) continue;
      slot.innerHTML = edit.html;
      done.texts += 1;
    }

    for (const edit of record.fonts) {
      if (!edit || typeof edit.layer !== 'string' || !Array.isArray(edit.path)) continue;
      const slot = atPath(layerOf(doc, edit.layer), edit.path);
      if (!slot || !edit.to) continue;
      if (typeof edit.to.size === 'string') slot.style.fontSize = edit.to.size;
      if (typeof edit.to.family === 'string') slot.style.fontFamily = edit.to.family;
      done.fonts += 1;
    }

    for (const layer of record.layers) {
      if (!layer || typeof layer.id !== 'string') continue;
      const element = layerOf(doc, layer.id);
      if (!element) continue;
      // Size is an author-level declaration: it means the same thing before
      // and after the editor bakes absolute coordinates.
      if (Number.isFinite(layer.width) && layer.width > 0) element.style.width = `${layer.width}px`;
      if (Number.isFinite(layer.height) && layer.height > 0) element.style.height = `${layer.height}px`;
      // Offset, never an absolute position. `translate` moves the element from
      // wherever the author layout put it, so it needs no promotion out of its
      // container and no measured ancestor geometry.
      const dx = Number.isFinite(layer.dx) ? layer.dx : 0;
      const dy = Number.isFinite(layer.dy) ? layer.dy : 0;
      if (dx || dy) {
        element.style.translate = `${dx}px ${dy}px`;
        element.dataset.viscraftOffset = '1';
      }
      if (layer.lockWidth) element.dataset.hfWidthLocked = '1';
      if (layer.lockHeight) element.dataset.hfHeightLocked = '1';
      done.layers += 1;
    }

    return done;
  }

  globalThis.__viscraftLayoutRecord = { hash, strip, read, active, apply };
})();
