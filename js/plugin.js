/* ==========================================================================
   SVG Code Inspector — Eagle inspector plugin
   --------------------------------------------------------------------------
   An Eagle "inspector" plugin for .svg items:

   • Renders a live preview of the SVG.
   • Shows the raw SVG source with lightweight XML syntax highlighting.
   • The code view is a real editor (textarea + highlighted layer beneath).
   • Quick edits:
       - recolor a chosen element's fill / stroke
       - replace one hex color globally
       - resize the <svg> width / height
   • Save back to the Eagle item via the officially recommended
     item.replaceFile() flow (temp file first), export a copy to disk, or
     duplicate the edited SVG as a new library item.

   Requires Eagle 4.0 Beta 17+ (inspector plugins). Set "devTools": true in
   manifest.json to debug via DevTools while developing.
   ========================================================================== */

'use strict';

/* ---------------------------------------------------------------- globals */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const eagleAPI = typeof eagle !== 'undefined' ? eagle : (window.eagle || null);

const fs = (() => { try { return typeof require !== 'undefined' ? require('fs') : null; } catch (e) { return null; } })();
const os = (() => { try { return typeof require !== 'undefined' ? require('os') : null; } catch (e) { return null; } })();
const path = (() => { try { return typeof require !== 'undefined' ? require('path') : null; } catch (e) { return null; } })();

const STANDALONE = !eagleAPI; // opened in a browser instead of inside Eagle

const state = {
    theme: 'DARK',
    item: null,          // Eagle Item instance for the loaded file
    itemId: null,
    fileName: '',
    origPath: '',        // absolute path of the original file on disk
    origCode: '',        // pristine copy read from disk
    code: '',            // current code (source of truth = textarea value)
    dirty: false,
    busy: false,
    parsed: null,        // parseSvg() result for the current code
    elIndex: -1,         // selected element in the "recolor an element" list
    palette: [],         // [{hex, count}]
    collapsed: {},
    pendingSel: null,    // item id we want to load once dirty edits are resolved
    timers: { preview: null, parse: null },
};

const DEMO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="300" viewBox="0 0 420 300">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2f6fe4"/>
      <stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="420" height="300" fill="url(#bg)"/>
  <circle cx="140" cy="140" r="72" fill="#ff5a2a" opacity="0.92"/>
  <circle cx="140" cy="140" r="44" fill="#ffffff" opacity="0.9"/>
  <path d="M290 90 L360 150 L290 210 L220 150 Z" fill="#ffd166"/>
  <path d="M290 90 L360 150 L290 210 L220 150 Z" fill="none" stroke="#0f172a" stroke-width="4" stroke-linejoin="round"/>
  <text x="420" y="285" text-anchor="end" font-family="Arial, sans-serif" font-size="15" fill="#ffffff" opacity="0.85">edit me</text>
</svg>
`;

/* ------------------------------------------------------------ tiny helpers */

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function debounce(fn, ms) {
    let t = null;
    return function (...args) {
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; fn.apply(null, args); }, ms);
    };
}

function fmtNum(n) {
    if (!isFinite(n)) return '0';
    const r = Math.round(n * 100) / 100;
    return String(r);
}

function showToast(msg, isErr, ms) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.hidden = true; }, ms || 2600);
}

function setLoading(on) {
    document.body.classList.toggle('loading', !!on);
}

/* --------------------------------------------------------------- state box */

function showState(icon, title, desc) {
    $('#stateBox').hidden = false;
    $('#main').hidden = true;
    $('#actions').hidden = true;
    $('#stateIcon').textContent = icon;
    $('#stateTitle').textContent = title;
    $('#stateDesc').textContent = desc || '';
}

function showMain() {
    $('#stateBox').hidden = true;
    $('#main').hidden = false;
    $('#actions').hidden = false;
}

/* ---------------------------------------------------------------- themes */

function applyTheme(theme) {
    state.theme = theme || 'DARK';
    document.body.setAttribute('theme', state.theme);
}

/* ------------------------------------------------------------- XML scan */

/**
 * Split raw XML text into tokens so we can (a) colour it and (b) map DOM
 * elements back to their exact source span for surgical edits.
 * Token kinds: 'text' | 'tag' | 'comment' | 'pi' | 'decl' | 'cdata'
 * A single pass, quote-aware so '>' inside an attribute value does not end a tag.
 */
function scanXml(raw) {
    const tokens = [];
    const n = raw.length;
    let i = 0;

    while (i < n) {
        const lt = raw.indexOf('<', i);
        if (lt === -1) {
            if (i < n) tokens.push({ kind: 'text', value: raw.slice(i), start: i, end: n });
            break;
        }
        if (lt > i) tokens.push({ kind: 'text', value: raw.slice(i, lt), start: i, end: lt });

        // comment?
        if (raw.startsWith('<!--', lt)) {
            const end = raw.indexOf('-->', lt + 4);
            const stop = end === -1 ? n : end + 3;
            tokens.push({ kind: 'comment', value: raw.slice(lt, stop), start: lt, end: stop });
            i = stop;
            continue;
        }
        // processing instruction  <? ... ?>
        if (raw[lt + 1] === '?') {
            const end = raw.indexOf('?>', lt + 2);
            const stop = end === -1 ? n : end + 2;
            tokens.push({ kind: 'pi', value: raw.slice(lt, stop), start: lt, end: stop });
            i = stop;
            continue;
        }
        // CDATA
        if (raw.startsWith('<![CDATA[', lt)) {
            const end = raw.indexOf(']]>', lt + 9);
            const stop = end === -1 ? n : end + 3;
            tokens.push({ kind: 'cdata', value: raw.slice(lt, stop), start: lt, end: stop });
            i = stop;
            continue;
        }
        // declaration / doctype  <! ... >
        if (raw[lt + 1] === '!') {
            const end = raw.indexOf('>', lt);
            const stop = end === -1 ? n : end + 1;
            tokens.push({ kind: 'decl', value: raw.slice(lt, stop), start: lt, end: stop });
            i = stop;
            continue;
        }
        // tag — scan to the closing '>' that is not inside quotes
        let j = lt + 1;
        let quote = null;
        while (j < n) {
            const ch = raw[j];
            if (quote) {
                if (ch === quote) quote = null;
            } else if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === '>') {
                break;
            }
            j++;
        }
        const stop = j >= n ? n : j + 1;
        tokens.push({ kind: 'tag', value: raw.slice(lt, stop), start: lt, end: stop });
        i = stop;
    }
    return tokens;
}

const OPEN_TAG_RE = /^<(?!\/)/;

/** opening/self-closing tags in source order — should mirror DOM pre-order */
function openingTagTokens(tokens) {
    return tokens.filter((t) => t.kind === 'tag' && OPEN_TAG_RE.test(t.value));
}

/* -------------------------------------------------------- syntax coloring */

function highlightTagHtml(esc) {
    // esc is an already-escaped tag body, e.g. '&lt;path id="a" fill="#f00" /&gt;'
    const m = /^(&lt;\/?)([^\s=&/>]*)/.exec(esc);
    if (!m) return '<span class="t-text">' + esc + '</span>';
    let out = '<span class="t-tag">' + m[1] + '</span>';
    if (m[2]) out += '<span class="t-name">' + m[2] + '</span>';

    let rest = esc.slice(m[0].length);
    // attr names may not contain '&' — excluding it stops escaped entities such
    // as '&gt;' from being tokenised as attribute names
    const attrRe = /^(\s*)([^\s=&/>]+)(?:\s*=\s*("[^"]*"|'[^']*'))?/;
    while (rest.length) {
        const a = attrRe.exec(rest);
        if (!a || a[0].length === 0) { out += '<span class="t-text">' + rest + '</span>'; break; }
        out += a[1];
        if (a[2]) {
            if (a[3] !== undefined) {
                out += '<span class="t-attr">' + a[2] + '</span>=<span class="t-val">' + a[3] + '</span>';
            } else {
                out += '<span class="t-attr">' + a[2] + '</span>';
            }
        } else {
            out += a[1]; // shouldn't happen
        }
        rest = rest.slice(a[0].length);
    }
    return out;
}

function highlightRaw(raw) {
    const tokens = scanXml(raw);
    let html = '';
    for (const t of tokens) {
        if (t.kind === 'tag') {
            html += highlightTagHtml(escapeHtml(t.value));
        } else if (t.kind === 'comment') {
            html += '<span class="t-com">' + escapeHtml(t.value) + '</span>';
        } else if (t.kind === 'pi' || t.kind === 'decl' || t.kind === 'cdata') {
            html += '<span class="t-com">' + escapeHtml(t.value) + '</span>';
        } else {
            html += '<span class="t-text">' + escapeHtml(t.value) + '</span>';
        }
    }
    // keep the <pre> one trailing newline taller than the textarea content so
    // the bottom lines never ride the textarea's horizontal scrollbar zone
    return html + '\n';
}

/* ------------------------------------------------------------ SVG parsing */

const HEX_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?![0-9a-fA-F])/g;

function normalizeHex(hex) {
    let h = hex.toLowerCase().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return '#' + h;
}

/** best-effort numeric part of a CSS/SVG length ("420", "12pt", "50%") */
function numOfLength(v) {
    if (v == null) return null;
    const m = /^\s*(-?[\d.]+)/.exec(String(v));
    return m ? parseFloat(m[1]) : null;
}

function styleChannel(styleAttr, name) {
    if (!styleAttr) return null;
    const re = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)', 'i');
    const m = re.exec(styleAttr);
    if (!m) return null;
    const v = m[1].trim();
    return v || null;
}

function channelIsHex(v) {
    return !!v && typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

/** returns { ok, error } or null when the DOM couldn't be walked */
function parseSvg(raw) {
    const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
    const pe = doc.querySelector('parsererror');
    if (pe) {
        return { ok: false, error: (pe.textContent || 'XML parse error').replace(/\s+/g, ' ').slice(0, 300) };
    }

    const root = doc.documentElement;
    if (!root || (root.tagName || '').toLowerCase() !== 'svg') {
        return { ok: false, error: 'The file does not contain an <svg> root element.' };
    }

    const widthRaw = root.getAttribute('width');
    const heightRaw = root.getAttribute('height');
    const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const vbOk = vb.length === 4 && vb.every((x) => isFinite(x)) && vb[2] > 0 && vb[3] > 0;

    let w = numOfLength(widthRaw);
    let h = numOfLength(heightRaw);
    let sizeNote = '';
    if (!w && !h && vbOk) {
        w = vb[2]; h = vb[3];
        sizeNote = 'sizes inferred from viewBox';
    } else if (w && !h && vbOk) {
        h = (w * vb[3]) / vb[2];
        sizeNote = 'height inferred from viewBox';
    } else if (!w && h && vbOk) {
        w = (h * vb[2]) / vb[3];
        sizeNote = 'width inferred from viewBox';
    }

    const tokens = scanXml(raw);
    const openTokens = openingTagTokens(tokens);

    // walk the DOM in pre-order and pair each element with its opening tag token
    const elements = [];
    let openIdx = 0;
    const walk = (node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node;
            const name = el.tagName.toLowerCase();
            const token = openIdx < openTokens.length ? openTokens[openIdx] : null;
            openIdx++;

            if (name !== 'svg') {
                const fillAttr = el.getAttribute('fill');
                const strokeAttr = el.getAttribute('stroke');
                const styleAttr = el.getAttribute('style');
                const sFill = styleChannel(styleAttr, 'fill');
                const sStroke = styleChannel(styleAttr, 'stroke');

                const channels = {
                    fill: { kind: fillAttr != null ? 'attr' : (sFill != null ? 'style' : null), value: fillAttr != null ? fillAttr : sFill },
                    stroke: { kind: strokeAttr != null ? 'attr' : (sStroke != null ? 'style' : null), value: strokeAttr != null ? strokeAttr : sStroke },
                };

                if (token && (channels.fill.kind || channels.stroke.kind)) {
                    elements.push({
                        node: el,
                        name,
                        token,
                        openSeg: token.value,
                        label: labelFor(el, name),
                        channels,
                    });
                }
            }

            for (const child of Array.from(node.childNodes)) walk(child);
        }
    };
    walk(root);

    // palette — distinct hex colours used anywhere in the file
    const counts = new Map();
    let mm;
    HEX_RE.lastIndex = 0;
    while ((mm = HEX_RE.exec(raw))) {
        const key = normalizeHex(mm[0]);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    const palette = Array.from(counts.entries()).map(([hex, count]) => ({ hex, count }));

    const ratio = w && h && w > 0 && h > 0 ? w / h : null;

    return {
        ok: true,
        root,
        rootToken: tokens.find((t) => t.kind === 'tag'),
        widthRaw,
        heightRaw,
        hasViewBox: vbOk,
        w: w != null ? w : null,
        h: h != null ? h : null,
        ratio,
        sizeNote,
        elements,
        palette,
        tokens,
    };
}

function labelFor(el, name) {
    const id = el.getAttribute('id');
    const cls = el.getAttribute('class');
    let l = name;
    if (id) l += '#' + id;
    else if (cls) l += '.' + cls.split(/\s+/)[0];
    return l;
}

/* ------------------------------------------------------ code layer sync */

function setEditorText(raw, keepCursor) {
    const ta = $('#codeInput');
    if (keepCursor && document.activeElement === ta) {
        const s = ta.selectionStart, e = ta.selectionEnd;
        ta.value = raw;
        ta.setSelectionRange(Math.min(s, raw.length), Math.min(e, raw.length));
    } else {
        ta.value = raw;
    }
    state.code = raw;
    renderHighlightDebounced();
    scheduleDerived();
    updateDirtyUI();
}

function renderHighlightImmediate() {
    $('#codeHl').innerHTML = highlightRaw(state.code);
    syncScroll();
}

const renderHighlightDebounced = debounce(renderHighlightImmediate, 90);

function syncScroll() {
    const ta = $('#codeInput');
    const pre = $('.code-hl');
    if (pre) {
        pre.scrollTop = ta.scrollTop;
        pre.scrollLeft = ta.scrollLeft;
    }
}

/* ------------------------------------------------------ derived refreshers */

function scheduleDerived() {
    if (state.timers.preview) clearTimeout(state.timers.preview);
    if (state.timers.parse) clearTimeout(state.timers.parse);
    state.timers.preview = setTimeout(refreshPreview, 220);
    state.timers.parse = setTimeout(refreshParseUI, 340);
}

function refreshPreview() {
    const img = $('#previewImg');
    const empty = $('#previewEmpty');
    const hint = $('#previewHint');
    const code = state.code;
    if (!code.trim()) {
        img.hidden = true; empty.hidden = false; return;
    }
    let uri;
    try {
        uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(code);
    } catch (e) {
        img.hidden = true; empty.hidden = false; return;
    }
    img.hidden = false;
    empty.hidden = true;
    hint.hidden = true;
    img.onerror = () => { img.hidden = true; empty.hidden = false; };
    img.src = uri;
}

function refreshParseUI() {
    const res = parseSvg(state.code);
    state.parsed = res.ok ? res : null;
    updateCodeMeta();

    const elHint = $('#elHint');
    const sizeHint = $('#sizeHint');

    if (!res.ok) {
        elHint.hidden = false;
        elHint.textContent = '⚠ ' + (res.error || 'Could not parse this SVG.');
        disableEditTools(true);
        sizeHint.hidden = true;
        $('#docDims').textContent = '';
        // clear stale pickers so the error state is not confusing
        $('#elSelect').innerHTML = '';
        $('#paletteSelect').innerHTML = '';
        $('#elChannels').hidden = true;
        return;
    }

    disableEditTools(false);
    refreshPaletteUI();
    refreshElementUI();
    refreshSizeUI(res);
    elHint.hidden = true;

    const d = $('#docDims');
    if (res.w && res.h) {
        d.textContent = fmtNum(res.w) + ' × ' + fmtNum(res.h) + (res.sizeNote ? ' (' + res.sizeNote + ')' : '');
    } else if (res.hasViewBox) {
        d.textContent = 'viewBox present';
    } else {
        d.textContent = '';
    }
}

function disableEditTools(disabled) {
    $('#elSelect').disabled = disabled || !state.parsed;
    $('#paletteSelect').disabled = disabled || !state.parsed;
    $('#paletteToInput').disabled = disabled || !state.parsed;
    $('#btnReplace').disabled = disabled || !state.parsed || !$('#paletteSelect').value;
    $('#sizeW').disabled = disabled;
    $('#sizeH').disabled = disabled;
    $('#sizeLock').disabled = disabled;
}

/* ------------------------------------------------------------- elements UI */

function refreshElementUI() {
    const sel = $('#elSelect');
    if (!state.parsed) return;
    const els = state.parsed.elements;
    const previous = state.elIndex;
    const options = [];
    els.forEach((el, i) => {
        const f = el.channels.fill.value;
        const s = el.channels.stroke.value;
        const parts = ['#' + (i + 1), '<' + el.name + '>'];
        if (el.node.getAttribute('id')) parts.push('#' + el.node.getAttribute('id'));
        const paints = [];
        if (f && f !== 'none') paints.push('fill ' + f);
        if (s && s !== 'none') paints.push('stroke ' + s);
        if (paints.length) parts.push('— ' + paints.join(', '));
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = parts.join(' ');
        options.push(opt);
    });

    const changed = sel.options.length !== options.length ||
        (options.length && (!sel.options[0] || sel.options[0].textContent !== options[0].textContent));
    if (changed) {
        sel.innerHTML = '';
        options.forEach((o) => sel.appendChild(o));
    }
    sel.disabled = options.length === 0;

    if (previous >= 0 && previous < els.length) sel.value = String(previous);
    else if (options.length) sel.value = '0';
    state.elIndex = sel.value !== '' ? parseInt(sel.value, 10) : -1;

    const noEls = $('#elHint');
    if (options.length === 0) {
        noEls.hidden = false;
        noEls.textContent = 'No elements carry a fill / stroke attribute.';
    } else {
        noEls.hidden = true;
    }
    renderElementChannels();
}

function renderElementChannels() {
    const box = $('#elChannels');
    if (!state.parsed || state.elIndex < 0 || state.elIndex >= state.parsed.elements.length) {
        box.hidden = true;
        return;
    }
    box.hidden = false;
    const el = state.parsed.elements[state.elIndex];
    bindChannel('fill', el);
    bindChannel('stroke', el);
}

function bindChannel(name, el) {
    const ch = el.channels[name];
    const input = $('#el' + name[0].toUpperCase() + name.slice(1) + 'Input'); // color swatch
    const text = $('#el' + name[0].toUpperCase() + name.slice(1) + 'Text');   // raw value field
    const value = ch.value;

    text.value = value == null ? '' : value;
    const hex = channelIsHex(value);
    input.disabled = !hex;
    if (hex) input.value = normalizeHex(value);
    text.title = ch.kind
        ? (ch.kind === 'style' ? 'set via style="' + name + ': …"' : name + '="' + value + '"')
        : 'no ' + name + ' on this element';

    text.dataset.channel = name;
    text.dataset.idx = String(state.elIndex);
}

/* ---------------------------------------------------------------- palette */

function refreshPaletteUI() {
    const sel = $('#paletteSelect');
    if (!state.parsed) { sel.disabled = true; return; }
    state.palette = state.parsed.palette;

    const prev = sel.value;
    sel.innerHTML = '';
    state.palette.forEach((p) => {
        const o = document.createElement('option');
        o.value = p.hex;
        o.textContent = p.hex.toUpperCase() + (p.count > 1 ? '  (×' + p.count + ')' : '');
        sel.appendChild(o);
    });
    sel.disabled = state.palette.length === 0;
    if (state.palette.some((p) => p.hex === prev)) sel.value = prev;
    $('#btnReplace').disabled = sel.disabled || !sel.value;
}

/* ------------------------------------------------------------- size tools */

function refreshSizeUI(res) {
    const wEl = $('#sizeW'), hEl = $('#sizeH');
    if (document.activeElement !== wEl && document.activeElement !== hEl) {
        wEl.value = res.w != null ? fmtNum(res.w) : '';
        hEl.value = res.h != null ? fmtNum(res.h) : '';
    }
    const hint = $('#sizeHint');
    if (!res.w && !res.h) {
        hint.hidden = false;
        hint.textContent = 'This SVG has no width / height — type values below to add them.';
    } else {
        hint.hidden = res.sizeNote ? false : true;
        if (res.sizeNote) hint.textContent = res.sizeNote + ' — editing width / height writes both attributes.';
    }
}

/**
 * Set width/height (px numbers) on the root <svg> open tag, in place.
 * If the attribute exists its unit suffix is preserved; if it is missing it is
 * inserted before the tag's closing '>'.
 */
function writeRootSize(w, h) {
    if (!state.parsed || !state.parsed.rootToken) return state.code;
    const rootTok = state.parsed.rootToken;
    let seg = rootTok.value;

    const patchAttr = (segment, attr, value) => {
        const nameRe = new RegExp('(?<![\\w-])(' + attr + ')\\s*=\\s*([\'"])([^\\' + '"' + ']*)\\2', 'i');
        const m = nameRe.exec(segment);
        const valueStr = fmtNum(value);
        if (m) {
            const unit = m[3].replace(/^[-.\d]+/, '');
            return segment.slice(0, m.index) + m[1] + '=' + m[2] + valueStr + unit + m[2] + segment.slice(m.index + m[0].length);
        }
        const close = /(\s*\/?>)$/.exec(segment);
        if (!close) return null;
        const at = close.index;
        return segment.slice(0, at) + ' ' + attr + '="' + valueStr + '"' + segment.slice(at);
    };

    seg = patchAttr(seg, 'width', w);
    if (seg == null) return state.code;
    seg = patchAttr(seg, 'height', h);
    if (seg == null) return state.code;

    const raw = state.code;
    return raw.slice(0, rootTok.start) + seg + raw.slice(rootTok.end);
}

/* --------------------------------------------------- surgical code edits */

/** apply an element paint edit by rewriting only that element's open tag */
function applyChannelToElement(idx, channel, newValue) {
    // always re-parse from the *current* code first, so element→source offsets
    // are fresh even when several edits land within the debounce window
    const fresh = parseSvg(state.code);
    if (!fresh.ok) return { ok: false, why: fresh.error || 'SVG not parsed' };
    state.parsed = fresh;

    const el = state.parsed.elements[idx];
    if (!el) return { ok: false, why: 'element not found' };

    const clean = String(newValue == null ? '' : newValue).trim();
    if (!clean) return { ok: false, why: 'empty paint value' };
    if (/[<>"'&]/.test(clean)) return { ok: false, why: 'invalid paint value' };

    const ch = el.channels[channel];
    if (!ch.kind) return { ok: false, why: 'this element has no ' + channel + ' yet' };

    const seg = el.openSeg;
    let out = null;

    if (ch.kind === 'attr') {
        const re = new RegExp('(?<![\\w-])(' + channel + ')\\s*=\\s*([\'"])([^\\' + '"' + ']*)\\2', 'i');
        const m = re.exec(seg);
        if (m) {
            out = seg.slice(0, m.index) + m[1] + '=' + m[2] + clean + m[2] + seg.slice(m.index + m[0].length);
        }
    }
    if (out == null && ch.kind === 'style') {
        // rewrite inside style="...: value ..."
        const re = new RegExp('(' + channel + '\\s*:\\s*)[^;"\'\\/]*', 'i');
        const m = re.exec(seg);
        if (m) {
            out = seg.slice(0, m.index) + m[1] + clean + seg.slice(m.index + m[0].length);
        }
    }
    if (out == null) return { ok: false, why: 'could not locate the ' + channel + ' paint on this element' };

    const raw = state.code;
    const next = raw.slice(0, el.token.start) + out + raw.slice(el.token.end);
    setEditorText(next, true);
    refreshParseUI(); // make the pickers track the edit without waiting for the debounce
    return { ok: true };
}

/** replace every occurrence of one hex colour with another, file-wide */
function globalReplaceColor(fromHex, toHex) {
    const from = normalizeHex(fromHex).toLowerCase().replace(/^#/, '');
    if (from.length !== 6) return 0;
    const short = from[0] + from[2] + from[4];
    const target = normalizeHex(toHex);

    // skip url(#...) fragment references: do not match right after '('
    const re = new RegExp('(?<![A-Za-z0-9#(-])(#(?:' + short + '|' + from + '))(?![0-9a-fA-F])', 'gi');

    const code = state.code;
    let count = 0;
    const next = code.replace(re, (tok) => { count++; return target; });
    if (count === 0) return 0;
    setEditorText(next, true);
    return count;
}

/* ------------------------------------------------------------ load / save */

function tmpSvgPath(suffix) {
    const id = (state.itemId || 'demo').replace(/[^\w-]/g, '');
    const base = (os && os.tmpdir) ? os.tmpdir() : '.';
    const name = (state.fileName || 'item').replace(/\.svg$/i, '');
    const fname = 'svg-inspector-' + id + '-' + suffix + '.svg';
    return (path && path.join) ? path.join(base, fname) : base + '/' + fname;
}

async function readFileText(filePath) {
    if (fs) {
        return await fs.promises.readFile(filePath, 'utf8');
    }
    throw new Error('Node fs is not available in this runtime.');
}

async function loadCurrentItem(force) {
    if (state.busy) return;
    if (!eagleAPI) {
        await loadDemo();
        return;
    }
    let items;
    try {
        items = await eagleAPI.item.getSelected();
    } catch (e) {
        console.warn('eagle.item.getSelected failed', e);
        return;
    }
    const item = Array.isArray(items) ? items.find((it) => it && String(it.ext || '').toLowerCase() === 'svg') : null;
    if (!item) {
        state.pendingSel = null;
        if (!state.itemId) {
            showState('&#9888;', 'Select an SVG', 'Select an SVG file in your library to inspect its code here.');
        } else {
            // nothing selected anymore — keep last view but show it is stale
            $('#fileTitle').textContent = '(no SVG selected)';
        }
        return;
    }
    if (state.dirty && state.itemId && state.itemId !== item.id) {
        state.pendingSel = item.id;
        $('#pendingBar').hidden = false;
        return;
    }
    state.pendingSel = null;
    $('#pendingBar').hidden = true;
    // Don't re-read the file for the SAME unedited item on every poll — that
    // used to re-render the preview + code and flash the bottom loading bar
    // roughly once a second (the item keeps its own edits anyway). Reloads
    // still run when the selection changes or an explicit refresh is requested.
    if (!force && state.itemId === item.id && state.item) return;
    await doLoad(item);
}

async function doLoad(item) {
    if (state.busy) return;
    state.busy = true;
    setLoading(true);
    try {
        const code = await readFileText(item.filePath);
        state.item = item;
        state.itemId = item.id;
        state.origPath = item.filePath;
        state.fileName = item.name && item.name.indexOf('.') === -1 ? item.name + '.' + item.ext : (item.name || 'file.' + item.ext);
        state.origCode = code;
        state.code = code;
        state.dirty = false;
        state.elIndex = -1;

        $('#fileTitle').textContent = state.fileName;
        $('#fileSub').hidden = false;
        $('#fileSub').textContent = item.ext.toUpperCase() + ' · ' + fmtNum((item.size || code.length) / 1024) + ' KB';

        showMain();
        $('#codeInput').value = code;
        renderHighlightImmediate();
        refreshPreview();
        refreshParseUI();
        updateDirtyUI();
        syncScroll();
    } catch (err) {
        console.error(err);
        showState('&#9888;', 'Could not read the SVG file',
            (err && err.message ? err.message : String(err)) + '\n\nIt may have been moved, renamed or deleted.');
    } finally {
        state.busy = false;
        setLoading(false);
    }
}

async function loadDemo() {
    if (state.busy) return;
    state.busy = true;
    try {
        state.item = null;
        state.itemId = 'demo';
        state.origPath = '';
        state.fileName = 'demo.svg';
        state.origCode = DEMO_SVG;
        state.code = DEMO_SVG;
        state.dirty = false;
        state.elIndex = -1;
        $('#fileTitle').textContent = 'demo.svg';
        $('#fileSub').hidden = false;
        $('#fileSub').textContent = 'DEMO · ' + fmtNum(DEMO_SVG.length / 1024) + ' KB';
        showMain();
        $('#codeInput').value = DEMO_SVG;
        renderHighlightImmediate();
        refreshPreview();
        refreshParseUI();
        updateDirtyUI();
        syncScroll();
    } finally {
        state.busy = false;
    }
}

function currentCode() {
    return $('#codeInput').value;
}

function updateCodeMeta() {
    const el = $('#codeMeta');
    if (!el) return;
    const kb = state.code.length / 1024;
    const lines = state.code.split('\n').length;
    el.textContent = fmtNum(kb) + ' KB · ' + lines + ' lines';
}

function updateDirtyUI() {
    const dirty = state.code !== state.origCode;
    state.dirty = dirty;
    $('#dirtyBadge').hidden = !dirty;
    const saveBtn = $('#btnSave');
    saveBtn.disabled = !dirty || STANDALONE;
    $('#btnExport').disabled = STANDALONE;
    $('#btnDuplicate').disabled = STANDALONE;
    if (dirty) {
        const delta = (state.code.length - state.origCode.length);
        $('#saveNote').textContent = delta >= 0 ? '+' + delta + ' chars' : delta + ' chars';
    } else {
        $('#saveNote').textContent = '';
    }
    if (state.item) {
        $('#btnSave').title = dirty
            ? 'Replace the file in Eagle (asks you to confirm first, and backs up the original)'
            : 'No changes yet';
    }
}

/**
 * Show an explicit confirmation before the original file is overwritten.
 * Returns one of:
 *   'overwrite' — the user confirmed replacing the original item file in place.
 *   'copy'      — the user chose to save a copy instead (original stays untouched).
 *   'cancel'    — the user cancelled (or the dialog could not be shown), so the
 *                 original must not be changed.
 */
async function confirmSaveDestination() {
    const buttons = ['Cancel', 'Overwrite original', 'Save a copy…'];
    const opts = {
        title: 'Replace the original SVG?',
        message: 'Overwrite “' + state.fileName + '” in Eagle with the code in this panel?',
        detail: 'Saving in place replaces the item’s current file in your library — the original is overwritten '
            + 'and the previous version is no longer the item’s file. Before replacing it, SVG Code Inspector '
            + 'writes a backup of the current SVG to a temporary file (the path is shown after saving) so you '
            + 'can recover the previous version from there. If you would rather leave the original untouched, '
            + 'choose “Save a copy…” to add the edited SVG as a new library item instead.',
        buttons,
        type: 'warning',
        defaultId: 1,
        cancelId: 0,
        noLink: true,
    };
    let res;
    try {
        res = await eagleAPI.dialog.showMessageBox(opts);
    } catch (e) {
        console.error(e);
        showToast('Save cancelled — the original file is unchanged.', true);
        return 'cancel';
    }
    const idx = res && typeof res.response === 'number' ? res.response : 0;
    if (idx === 1) return 'overwrite';
    if (idx === 2) return 'copy';
    return 'cancel';
}

/**
 * Write the current (pre-replace) original file content to a dedicated backup
 * file so the user can recover the version that is about to be overwritten.
 * Returns the backup path, or null when the backup could not be written.
 */
async function writePreSaveBackup() {
    const keyId = (state.itemId || 'item').replace(/[^\w-]/g, '');
    const base = (os && os.tmpdir) ? os.tmpdir() : '.';
    const baseName = (state.fileName || 'item').replace(/\.svg$/i, '');
    const fname = 'svg-inspector-' + baseName + '-' + keyId + '-' + Date.now().toString(36) + '.pre-save.svg';
    const bp = (path && path.join) ? path.join(base, fname) : base + '/' + fname;
    try {
        await fs.promises.writeFile(bp, state.origCode, 'utf8');
        return bp;
    } catch (e) {
        console.warn('Could not write pre-save backup:', e);
        return null;
    }
}

async function doSave() {
    const code = currentCode();
    if (STANDALONE) { showToast('Save is available when running inside Eagle.', true); return; }
    if (!state.item) { showToast('Nothing to save.', true); return; }
    if (code === state.origCode) { showToast('No changes to save.'); return; }
    if (!fs) { showToast('Node fs unavailable.', true); return; }

    // Explicit confirm before anything is overwritten. Applies to every save
    // entry point: the "Save to Eagle" button, Ctrl/Cmd+S and "Save & load".
    const choice = await confirmSaveDestination();
    if (choice === 'cancel') { showToast('Save cancelled — the original file is unchanged.'); return; }
    if (choice === 'copy') { await doDuplicate(); return; }

    // Back up the current original so the version being replaced stays recoverable.
    const backup = await writePreSaveBackup();
    if (!backup) {
        showToast('Could not create a backup — save cancelled so the original file stays intact.', true);
        return;
    }

    const tmp = tmpSvgPath(Date.now().toString(36));
    try {
        await fs.promises.writeFile(tmp, code, 'utf8');
    } catch (e) {
        console.error(e);
        showToast('Could not write temp file: ' + e.message, true);
        return;
    }
    try {
        const ok = await state.item.replaceFile(tmp);
        if (ok === false) throw new Error('replaceFile returned false');
        state.origCode = code;
        state.code = code;
        updateDirtyUI();
        try { await fs.promises.unlink(tmp); } catch (e2) { /* best effort */ }
        showToast('Saved to Eagle ✓ (backup: ' + backup + ')');
    } catch (e) {
        console.error(e);
        showToast('Eagle rejected the save: ' + (e && e.message ? e.message : e), true);
    }
}

async function doDuplicate() {
    if (STANDALONE) { showToast('Duplicate is available when running inside Eagle.', true); return; }
    if (!state.item || !fs) return;
    const tmp = tmpSvgPath('copy-' + Date.now().toString(36));
    try {
        await fs.promises.writeFile(tmp, currentCode(), 'utf8');
        const base = (state.fileName || 'item.svg').replace(/\.svg$/i, '') + '-edited.svg';
        const newId = await eagleAPI.item.addFromPath(tmp, { name: base });
        try { await fs.promises.unlink(tmp); } catch (e2) { /* best effort */ }
        showToast(newId ? 'Added “' + base + '” to your library ✓' : 'Added a copy to your library ✓');
    } catch (e) {
        console.error(e);
        showToast('Duplicate failed: ' + (e && e.message ? e.message : e), true);
    }
}

async function doExport() {
    if (STANDALONE) { showToast('Export is available when running inside Eagle.', true); return; }
    if (!eagleAPI || !fs) return;
    let res;
    try {
        res = await eagleAPI.dialog.showSaveDialog({
            title: 'Export SVG',
            defaultPath: (state.fileName || 'item.svg').replace(/\.svg$/i, '') + '-edited.svg',
            filters: [{ name: 'SVG', extensions: ['svg'] }],
        });
    } catch (e) {
        console.error(e);
        showToast('Export dialog failed.', true);
        return;
    }
    const filePath = res && typeof res === 'object' ? res.filePath : null;
    if (!filePath || (res.canceled)) return;
    try {
        await fs.promises.writeFile(filePath, currentCode(), 'utf8');
        showToast('Exported to ' + filePath);
    } catch (e) {
        console.error(e);
        showToast('Export failed: ' + e.message, true);
    }
}

async function copyCode() {
    const text = currentCode();
    try {
        await navigator.clipboard.writeText(text);
        showToast('SVG code copied ✓');
    } catch (e) {
        try {
            const ta = $('#codeInput');
            ta.focus();
            ta.select();
            const ok = document.execCommand && document.execCommand('copy');
            if (ok) showToast('SVG code copied ✓');
            else showToast('Copy failed — select the code and press Ctrl/Cmd+C', true);
        } catch (e2) {
            showToast('Copy failed — select the code and press Ctrl/Cmd+C', true);
        }
    }
}

/* ------------------------------------------------------------- UI wiring */

function wireUI() {
    // section collapsing
    $$('.card-head[data-collapse]').forEach((head) => {
        head.addEventListener('click', () => {
            const card = head.closest('.card');
            const wasCollapsed = card.classList.toggle('collapsed');
            try { localStorage.setItem('svgci:' + head.dataset.collapse, wasCollapsed ? '1' : '0'); } catch (e) { /* ignore */ }
        });
    });
    // restore collapse prefs
    $$('.card-head[data-collapse]').forEach((head) => {
        try {
            if (localStorage.getItem('svgci:' + head.dataset.collapse) === '1') {
                head.closest('.card').classList.add('collapsed');
            }
        } catch (e) { /* ignore */ }
    });

    // code editor
    const ta = $('#codeInput');
    ta.addEventListener('input', () => {
        state.code = ta.value;
        renderHighlightDebounced();
        scheduleDerived();
        updateDirtyUI();
    });
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            doSave();
        }
        // Tab = insert two spaces at cursor
        if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            const s = ta.selectionStart, en = ta.selectionEnd;
            const v = ta.value;
            ta.value = v.slice(0, s) + '  ' + v.slice(en);
            ta.setSelectionRange(s + 2, s + 2);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    // refresh
    $('#btnRefresh').addEventListener('click', async () => {
        if (state.dirty) {
            let res = { response: 1 };
            try {
                res = await eagleAPI.dialog.showMessageBox({
                    title: 'Discard changes?',
                    message: 'Reloading discards your unsaved edits.',
                    detail: state.fileName,
                    buttons: ['Cancel', 'Discard & reload'],
                    type: 'warning',
                });
            } catch (e) { /* standalone: fall through to reload */ res = { response: 0 }; }
            if (res && res.response === 0) return;
        }
        if (eagleAPI) await loadCurrentItem(true);
        else await loadDemo();
    });

    // actions
    $('#btnSave').addEventListener('click', doSave);
    $('#btnCopy').addEventListener('click', copyCode);
    $('#btnDuplicate').addEventListener('click', doDuplicate);
    $('#btnExport').addEventListener('click', doExport);

    // element channel edits
    $('#elSelect').addEventListener('change', () => {
        state.elIndex = $('#elSelect').value !== '' ? parseInt($('#elSelect').value, 10) : -1;
        renderElementChannels();
    });
    ['elFillText', 'elStrokeText'].forEach((id) => {
        const text = $('#' + id);
        text.addEventListener('change', () => {
            const idx = parseInt(text.dataset.idx || '-1', 10);
            const channel = text.dataset.channel;
            if (idx < 0 || !channel) return;
            const res = applyChannelToElement(idx, channel, text.value);
            if (!res.ok) showToast(res.why || 'Could not apply', true);
        });
    });

    // colour swatches mirror into the text field and commit on picker close
    [['elFillInput', 'elFillText'], ['elStrokeInput', 'elStrokeText']].forEach(([inputId, textId]) => {
        const swatch = $('#' + inputId);
        const text = $('#' + textId);
        swatch.addEventListener('input', () => { text.value = swatch.value; });
        swatch.addEventListener('change', () => {
            text.value = swatch.value;
            text.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    // global replace
    $('#paletteSelect').addEventListener('change', () => {
        $('#btnReplace').disabled = !$('#paletteSelect').value;
    });
    $('#btnReplace').addEventListener('click', () => {
        const from = $('#paletteSelect').value;
        const to = $('#paletteToInput').value;
        if (!from) return;
        const n = globalReplaceColor(from, to);
        if (n === 0) showToast('No occurrences of ' + from + ' found.', true);
        else showToast('Replaced ' + n + ' occurrence' + (n > 1 ? 's' : '') + ' of ' + from.toUpperCase() + ' ✓');
    });

    // size
    const applySize = () => {
        const fresh = parseSvg(state.code);
        if (!fresh.ok) { showToast('Fix the SVG before resizing.', true); return; }
        state.parsed = fresh;
        const cur = state.parsed;
        const wV = parseFloat($('#sizeW').value);
        const hV = parseFloat($('#sizeH').value);
        const lock = $('#sizeLock').checked;
        let w = isFinite(wV) ? wV : cur.w;
        let h = isFinite(hV) ? hV : cur.h;
        if (lock && cur.ratio && isFinite(wV)) h = w / cur.ratio;
        if (lock && cur.ratio && isFinite(hV)) w = h * cur.ratio;
        if (!isFinite(w) || !isFinite(h)) { showToast('Enter numeric width and height.', true); return; }
        const next = writeRootSize(Math.max(0, w), Math.max(0, h));
        if (next !== state.code) setEditorText(next, true);
    };
    $('#sizeW').addEventListener('change', applySize);
    $('#sizeH').addEventListener('change', applySize);

    // pending bar
    $('#btnDiscard').addEventListener('click', async () => {
        state.dirty = false;
        $('#pendingBar').hidden = true;
        const id = state.pendingSel;
        state.pendingSel = null;
        if (id && eagleAPI) {
            try {
                const item = (await eagleAPI.item.getById(id));
                if (item) await doLoad(item);
            } catch (e) { await loadCurrentItem(); }
        } else if (eagleAPI) {
            await loadCurrentItem();
        }
    });
    $('#btnSaveThenLoad').addEventListener('click', async () => {
        await doSave();
        if (!state.dirty) {
            const id = state.pendingSel;
            state.pendingSel = null;
            $('#pendingBar').hidden = true;
            if (id && eagleAPI) {
                try {
                    const item = await eagleAPI.item.getById(id);
                    if (item) await doLoad(item);
                    return;
                } catch (e) { /* fall through */ }
            }
            await loadCurrentItem();
        }
    });
}

/* -------------------------------------------------------------- lifecycle */

function bootStandalone() {
    document.body.dataset.standalone = 'true';
    $('#standaloneBanner').hidden = false;
    applyTheme('DARK');
    wireUI();
    loadDemo();
}

function bootEagle() {
    applyTheme('LIGHT');
    try {
        eagleAPI.app.theme.then(applyTheme).catch(() => applyTheme('LIGHT'));
    } catch (e) {
        if (eagleAPI.app && typeof eagleAPI.app.theme === 'string') applyTheme(eagleAPI.app.theme);
    }
    try {
        eagleAPI.onThemeChanged(applyTheme);
    } catch (e) { /* older API */ }
    wireUI();
    loadCurrentItem();
    setInterval(loadCurrentItem, 900); // panel may stay alive across selection changes
}

document.addEventListener('DOMContentLoaded', () => {
    if (STANDALONE) bootStandalone();
    else {
        const go = () => bootEagle();
        if (eagleAPI.onPluginCreate) {
            let started = false;
            try {
                eagleAPI.onPluginCreate(() => {
                    if (!started) { started = true; go(); }
                });
            } catch (e) { go(); }
            // onPluginCreate should always fire; a timeout is a belt & braces for
            // older hosts where inspector panels skip the event.
            setTimeout(() => { if (!started) { started = true; go(); } }, 250);
        } else {
            go();
        }
    }
});
