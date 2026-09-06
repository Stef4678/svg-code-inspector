// Headless smoke test for the pure logic in js/plugin.js (project root).
// Run: node tools/smoke-test.cjs  (no DOM or Eagle needed)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'plugin.js'), 'utf8');

const ctx = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    Promise,
    document: {
        addEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return { appendChild() {}, addEventListener() {}, set value(v) {}, get value() { return ''; } }; },
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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
