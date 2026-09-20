// Headless smoke test for the pure logic in js/plugin.js (project root).
// Run: node tools/smoke-test.cjs  (no DOM or Eagle needed)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'plugin.js'), 'utf8');

/* ---------------------------------------------------------------- DOM stubs */
// One stub element per selector so the save path can read/write real values and
// so wireUI's event handlers can be fired from the tests below.
const els = new Map();
function makeEl() {
    return {
        hidden: false, disabled: false, checked: false, value: '', textContent: '', innerHTML: '', title: '',
        scrollTop: 0, scrollLeft: 0, src: '', onerror: null, dataset: {}, style: {},
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        _h: {},
        addEventListener(type, fn) { this._h[type] = fn; },
        removeEventListener() {}, focus() {}, select() {}, setSelectionRange() {}, appendChild() {},
    };
}
function el(sel) { if (!els.has(sel)) els.set(sel, makeEl()); return els.get(sel); }

/* ------------------------------------------------------- fs / Eagle doubles */
const DISK_PATH = 'C:/lib/a.svg';
const disk = { [DISK_PATH]: 'ORIGINAL' };
const writes = [];      // every fs.promises.writeFile({ path, data })
const reads = [];       // every fs.promises.readFile(path)
const unlinks = [];
let failBackupWrites = false;
let onTempWrite = null;

const fakeFs = {
    promises: {
        async readFile(p) {
            reads.push(p);
            if (!(p in disk)) throw new Error('ENOENT: no such file, open ' + p);
            return disk[p];
        },
        async writeFile(p, data) {
            if (failBackupWrites && /\.pre-save\.svg$/.test(p)) throw new Error('EACCES: permission denied');
            writes.push({ path: p, data });
            if (onTempWrite) { const fn = onTempWrite; onTempWrite = null; fn(); }
        },
        async unlink(p) { unlinks.push(p); },
    },
};
const fakeOs = { tmpdir: () => 'C:/tmp' };
const fakePath = { join: (...parts) => parts.join('/') };
const fakeRequire = (name) => (name === 'fs' ? fakeFs : name === 'os' ? fakeOs : name === 'path' ? fakePath : null);

const dialogCalls = [];       // every eagle.dialog.showMessageBox(opts)
let dialogAnswer = null;      // null = the dialog just returns its defaultId (plain Enter)
let dialogThrows = false;
const replaceCalls = [];      // every item.replaceFile(tmpPath)
const addFromPathCalls = [];

const fakeItem = {
    id: 'item1', ext: 'svg', name: 'a', filePath: DISK_PATH,
    async replaceFile(tmpPath) {
        const w = writes.find((x) => x.path === tmpPath);
        replaceCalls.push({ tmpPath, data: w ? w.data : null });
        return true;
    },
};

const eagleMock = {
    dialog: {
        async showMessageBox(opts) {
            dialogCalls.push(opts);
            if (dialogThrows) throw new Error('no dialog available');
            return { response: dialogAnswer === null ? opts.defaultId : dialogAnswer };
        },
    },
    item: {
        async getById(id) { return { id, ext: 'svg', name: 'a', filePath: DISK_PATH }; },
        async addFromPath(p, meta) {
            const w = writes[writes.length - 1];
            addFromPathCalls.push({ path: p, meta, data: w ? w.data : null });
            return 'item2';
        },
    },
};

const ctx = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    Promise,
    require: fakeRequire,
    eagle: eagleMock,
    document: {
        addEventListener() {},
        querySelector: el,
        querySelectorAll() { return []; },
        createElement: makeEl,
        body: { setAttribute() {}, dataset: {}, classList: { toggle() {} } },
        activeElement: null,
    },
    window: {},
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: {},
    DOMParser: undefined,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

const pluginState = vm.runInContext('state', ctx);
const quietConsole = { log() {}, warn() {}, error() {}, info() {} };

let failures = 0;
function check(name, cond, extra) {
    if (cond) console.log('  ok  ' + name + (extra ? '  [' + extra + ']' : ''));
    else { failures++; console.log(' FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

console.log('scanXml + highlighting:');
const xml = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="300"><!-- a comment -->'
    + '<path d="M0 0 L10 10 L0 10 Z" fill="#ff5a2a" stroke="#0f172a" stroke-width="2"/>'
    + '<g id="x" fill="#2f6fe4"><circle r="5"/></g></svg>';
const toks = ctx.scanXml(xml);
check('token kinds', toks.map(t => t.kind).join(',') === 'tag,comment,tag,tag,tag,tag,tag',
    toks.map(t => t.kind).join(','));
const opens = ctx.openingTagTokens(toks);
check('open tag count = 4 (svg,path,g,circle)', opens.length === 4, 'got ' + opens.length);
check('tag offsets cover whole input', toks[toks.length - 1].end === xml.length);
check('self-closing path kept intact', opens[1].value === '<path d="M0 0 L10 10 L0 10 Z" fill="#ff5a2a" stroke="#0f172a" stroke-width="2"/>');

const hl = ctx.highlightRaw(xml);
console.log('  hl head:', JSON.stringify(hl.slice(0, 200)));
check('code escaped (no raw <path/<svg leaks, name span present)', !hl.includes('<path') && !hl.includes('<svg') && hl.includes('t-name">path'), '');
check('attr/val/comment classes emitted', /t-attr/.test(hl) && /t-val/.test(hl) && /t-com/.test(hl), '');
check('no raw <svg> in highlight', !hl.includes('<svg'));

console.log('helpers:');
check('escapeHtml', ctx.escapeHtml('<a>&') === '&lt;a&gt;&amp;');
check('normalizeHex #f00 -> #ff0000', ctx.normalizeHex('#f00') === '#ff0000');
check('normalizeHex case', ctx.normalizeHex('#0F0F0F') === '#0f0f0f');
check('numOfLength 12pt', ctx.numOfLength('12pt') === 12);
check('numOfLength 50%', ctx.numOfLength('50%') === 50);
check('numOfLength null', ctx.numOfLength(null) === null);
check('fmtNum', ctx.fmtNum(42.004) === '42' && ctx.fmtNum(1.5) === '1.5' && ctx.fmtNum(Infinity) === '0');

console.log('global replace regex behaviour (url(#) must not match):');
const demo = 'fill="#ff5a2a" style="fill:#ff5a2a;color:#f00" fill="#FF5A2A" x="url(#ff5a2a)" stroke="#ff5a2a"';
const re = new RegExp('(?<![A-Za-z0-9#(-])(#(?:ff5a2a|ff5a2a))(?![0-9a-fA-F])', 'gi');
const hits = demo.match(re) || [];
check('matches paints but not url(#…) fragment (expect 4)', hits.length === 4, 'got ' + hits.length + ' [' + hits.join(' ') + ']');

console.log('channel-style regex sanity (fill via style):');
const styleRe = new RegExp('(?:^|;)\\s*' + 'fill' + '\\s*:\\s*([^;]+)', 'i');
check('styleChannel-like', /#ff5a2a/.test(styleRe.exec('fill:#ff5a2a;opacity:.5')[1].trim()));

// ---- string-level copies of the surgical edit regexes (mirrors plugin.js) ----
console.log('surgical edit regexes:');
function patchAttr(segment, attr, value) {
    const nameRe = new RegExp('(?<![\\w-])(' + attr + ')\\s*=\\s*([\'"])([^\\' + '"' + ']*)\\2', 'i');
    const m = nameRe.exec(segment);
    const valueStr = String(Math.round(value * 100) / 100);
    if (m) {
        const unit = m[3].replace(/^[-.\d]+/, '');
        return segment.slice(0, m.index) + m[1] + '=' + m[2] + valueStr + unit + m[2] + segment.slice(m.index + m[0].length);
    }
    const close = /(\s*\/?>)$/.exec(segment);
    if (!close) return null;
    const at = close.index;
    return segment.slice(0, at) + ' ' + attr + '="' + valueStr + '"' + segment.slice(at);
}
const segRoot = '<svg xmlns="http://www.w3.org/2000/svg" width="420px" height="300" viewBox="0 0 420 300">';
const resized = patchAttr(patchAttr(segRoot, 'width', 640), 'height', 480);
check('resize: existing attrs, px unit preserved', resized === '<svg xmlns="http://www.w3.org/2000/svg" width="640px" height="480" viewBox="0 0 420 300">', resized);
const seg2 = '<svg viewBox="0 0 10 10">';
const inserted = patchAttr(patchAttr(seg2, 'width', 100), 'height', 50);
check('resize: missing attrs inserted', inserted === '<svg viewBox="0 0 10 10" width="100" height="50">', inserted);
const seg3 = '<svg id="a"/>';
check('resize: self-closing insert', patchAttr(seg3, 'width', 8) === '<svg id="a" width="8"/>', patchAttr(seg3, 'width', 8));
const segStrokeWidth = '<svg stroke-width="9"/>'; // must NOT treat stroke-width as width
check('resize: stroke-width untouched', patchAttr(segStrokeWidth, 'width', 8) === '<svg stroke-width="9" width="8"/>', patchAttr(segStrokeWidth, 'width', 8));

function replAttr(seg, channel, val) {
    const re = new RegExp('(?<![\\w-])(' + channel + ')\\s*=\\s*([\'"])([^\\' + '"' + ']*)\\2', 'i');
    const m = re.exec(seg);
    if (!m) return seg;
    return seg.slice(0, m.index) + m[1] + '=' + m[2] + val + m[2] + seg.slice(m.index + m[0].length);
}
const segP = '<path id="p" fill="#ffffff" stroke-width="2" stroke="#0f172a"/>';
const rp = replAttr(segP, 'fill', '#ff0000');
check('element fill replaced', rp === '<path id="p" fill="#ff0000" stroke-width="2" stroke="#0f172a"/>', rp);

function replStyle(seg, channel, val) {
    const re = new RegExp('(' + channel + '\\s*:\\s*)[^;"\'\\/]*', 'i');
    const m = re.exec(seg);
    if (!m) return seg;
    return seg.slice(0, m.index) + m[1] + val + seg.slice(m.index + m[0].length);
}
const segS = '<rect style="fill:#abc;opacity:.5"/>';
check('style fill replaced, other props intact', replStyle(segS, 'fill', '#fedcba') === '<rect style="fill:#fedcba;opacity:.5"/>', replStyle(segS, 'fill', '#fedcba'));

/* ---------------------------------------------------------------------------
   Save guard: the plugin must never replace an original whose on-disk contents
   are not the version it loaded, and "Cancel" must be the default button of
   every confirmation — a plain Enter must never overwrite the original file.
   --------------------------------------------------------------------------- */

const tick = () => new Promise((r) => setTimeout(r, 0));
const save = () => vm.runInContext('doSave()', ctx);
const backupWrite = () => writes.find((w) => /\.pre-save\.svg$/.test(w.path));

/** put the plugin into "an item is loaded with unsaved edits" state */
function primeSave(opts) {
    opts = opts || {};
    disk[DISK_PATH] = opts.disk === undefined ? 'ORIGINAL' : opts.disk;
    writes.length = 0;
    reads.length = 0;
    unlinks.length = 0;
    dialogCalls.length = 0;
    replaceCalls.length = 0;
    addFromPathCalls.length = 0;
    dialogAnswer = opts.answer === undefined ? null : opts.answer;
    dialogThrows = false;
    failBackupWrites = false;
    onTempWrite = null;
    pluginState.item = fakeItem;
    pluginState.itemId = 'item1';
    pluginState.origPath = DISK_PATH;
    pluginState.fileName = 'a.svg';
    pluginState.origCode = 'ORIGINAL';
    pluginState.code = 'ORIGINAL';
    pluginState.dirty = opts.dirty === undefined ? false : opts.dirty;
    pluginState.pendingSel = null;
    el('#codeInput').value = opts.edited === undefined ? 'EDITED' : opts.edited;
}

(async () => {
    ctx.console = quietConsole; // doLoad's parse fallback logs; keep the report clean

    console.log('save guard — Cancel is the default action:');
    primeSave({ answer: null }); // Enter → dialog returns defaultId
    await save();
    const d0 = dialogCalls[0] || {};
    check('overwrite dialog defaultId/cancelId = 0 (Cancel)',
        dialogCalls.length === 1 && d0.defaultId === 0 && d0.cancelId === 0, 'defaultId=' + d0.defaultId);
    check('Cancel is the first button', Array.isArray(d0.buttons) && d0.buttons[0] === 'Cancel',
        (d0.buttons || []).join(' | '));
    check('plain Enter cancels — nothing written, nothing replaced',
        replaceCalls.length === 0 && writes.length === 0 && pluginState.origCode === 'ORIGINAL');

    primeSave({ answer: 2 });
    await save();
    check('"Save a copy" replaces nothing', replaceCalls.length === 0 && addFromPathCalls.length === 1);

    console.log('save guard — explicit overwrite of an unchanged file:');
    primeSave({ answer: 1 });
    await save();
    check('user-chosen overwrite replaces the item file',
        replaceCalls.length === 1 && replaceCalls[0].data === 'EDITED');
    check('backup holds the exact contents being replaced',
        !!backupWrite() && backupWrite().data === 'ORIGINAL', backupWrite() && backupWrite().path);
    check('temp file removed after the swap', unlinks.indexOf(replaceCalls[0].tmpPath) !== -1);
    check('baseline updated to the saved code', pluginState.origCode === 'EDITED');

    primeSave({ answer: 1 });
    await vm.runInContext('writePreSaveBackup("LIVE-MARKER")', ctx);
    check('backup writes the passed-in live contents (never the loaded copy)',
        !!backupWrite() && backupWrite().data === 'LIVE-MARKER' && backupWrite().data !== pluginState.origCode);

    console.log('save guard — the original changed on disk since it was loaded:');
    primeSave({ answer: null, disk: 'CHANGED BY ANOTHER TOOL' }); // Enter → Cancel
    await save();
    const d1 = dialogCalls[0] || {};
    check('external change detected before any overwrite',
        dialogCalls.length === 1 && /changed on disk/i.test(d1.title || '') && d1.defaultId === 0, d1.title);
    check('externally changed file is never replaced and never backed up',
        replaceCalls.length === 0 && writes.length === 0);
    check('Enter on the stale-original dialog cancels and keeps the baseline',
        d1.cancelId === 0 && pluginState.origCode === 'ORIGINAL');

    primeSave({ answer: 1, disk: 'CHANGED BY ANOTHER TOOL' });
    await save();
    check('"Reload from disk" re-reads instead of overwriting',
        replaceCalls.length === 0 && reads.indexOf(DISK_PATH) !== -1
        && pluginState.origCode === 'CHANGED BY ANOTHER TOOL');

    primeSave({ answer: 2, disk: 'CHANGED BY ANOTHER TOOL' });
    await save();
    check('"Save a copy" from the stale dialog leaves the original alone',
        replaceCalls.length === 0 && addFromPathCalls.length === 1
        && addFromPathCalls[0].data === 'EDITED');

    console.log('save guard — unreadable original / failed backup / late change:');
    primeSave({ answer: 1 });
    delete disk[DISK_PATH];
    await save();
    const d2 = dialogCalls[0] || {};
    check('unreadable original is not replaced', replaceCalls.length === 0 && writes.length === 0);
    check('unreadable original gets its own warning', /could not be re-read/i.test(d2.title || ''), d2.title);
    disk[DISK_PATH] = 'ORIGINAL';

    primeSave({ answer: 1 });
    failBackupWrites = true;
    await save();
    check('backup failure cancels the overwrite (no backup → no replace)',
        replaceCalls.length === 0 && !backupWrite());

    primeSave({ answer: 1 });
    onTempWrite = () => { disk[DISK_PATH] = 'CHANGED DURING SAVE'; }; // after the freshness check
    await save();
    check('a change between the check and the swap cancels the save',
        replaceCalls.length === 0 && unlinks.length === 1);

    console.log('save guard — every entry point uses the same protection:');
    vm.runInContext('wireUI()', ctx);

    primeSave({ answer: null });
    el('#codeInput').value = 'EDITED';
    el('#codeInput')._h.keydown({ ctrlKey: true, key: 's', preventDefault() {} });
    await tick(); await tick();
    check('Ctrl/Cmd+S goes through the same Cancel-default dialog',
        dialogCalls.length === 1 && dialogCalls[0].defaultId === 0 && replaceCalls.length === 0);

    primeSave({ answer: null });
    el('#codeInput').value = 'EDITED';
    el('#btnSave')._h.click();
    await tick(); await tick();
    check('"Save to Eagle" button cannot overwrite by default',
        dialogCalls.length === 1 && dialogCalls[0].defaultId === 0 && replaceCalls.length === 0);

    primeSave({ answer: null, disk: 'CHANGED BY ANOTHER TOOL', dirty: true });
    el('#codeInput').value = 'EDITED';
    pluginState.pendingSel = 'item2';
    await el('#btnSaveThenLoad')._h.click();
    check('"Save & load" cannot overwrite a changed original',
        replaceCalls.length === 0 && writes.length === 0 && pluginState.itemId === 'item1');

    console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
})();
