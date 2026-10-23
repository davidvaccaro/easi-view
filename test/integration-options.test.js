import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, themeVariables } from '../src/integration/options.js';

test('embedding defaults preserve the standalone brand and request no external assets', () => {
    assert.deepEqual(normalizeOptions(), {
        branding: { name: 'EASI View', logoUrl: null, logoAlt: '', showReleaseTag: true },
        theme: {},
        ui: { header: true, library: true, inspector: true, statusBar: true, demos: true },
        initialDemo: null,
        styleNonce: null
    });
    assert.deepEqual(themeVariables(), {});
    const first = normalizeOptions();
    first.branding.name = 'Changed';
    first.ui.header = false;
    first.theme.accent = '#fff';
    const next = normalizeOptions();
    assert.equal(next.branding.name, 'EASI View');
    assert.equal(next.ui.header, true);
    assert.deepEqual(next.theme, {});
});

test('host branding, theme, and chrome choices are copied and normalized', () => {
    const raw = {
        branding: { name: '  Acme Imaging  ', logoUrl: '/assets/logo.svg', logoAlt: '  Acme  ', showReleaseTag: false },
        theme: { accent: '#A1B2C3', background: '#123', panel: '#ABC', text: '#ffffff', muted: '#789', border: '#456789' },
        ui: { header: false, library: false, inspector: false, statusBar: false, demos: false },
        initialDemo: 'mr'
    };
    const options = normalizeOptions(raw);
    assert.deepEqual(options.branding, { name: 'Acme Imaging', logoUrl: '/assets/logo.svg', logoAlt: 'Acme', showReleaseTag: false });
    assert.deepEqual(themeVariables(options.theme), {
        '--accent': '#a1b2c3', '--bg': '#123', '--panel': '#abc', '--text': '#ffffff', '--muted': '#789', '--border': '#456789'
    });
    assert.deepEqual(options.ui, raw.ui);
    assert.equal(options.initialDemo, 'mr');
    options.theme.accent = '#fff';
    options.ui.header = true;
    assert.equal(raw.theme.accent, '#A1B2C3');
    assert.equal(raw.ui.header, false);
});

test('partial configuration retains omitted defaults and permits plain text branding', () => {
    const options = normalizeOptions({ branding: { name: '<img src=x onerror=alert(1)>' }, ui: { inspector: false } });
    // Rendering uses textContent; preserving text here does not turn it into markup.
    assert.equal(options.branding.name, '<img src=x onerror=alert(1)>');
    assert.equal(options.branding.logoUrl, null);
    assert.equal(options.ui.header, true);
    assert.equal(options.ui.inspector, false);
    assert.deepEqual(normalizeOptions(Object.create(null)), normalizeOptions());
});

test('unknown options are rejected at every configuration level', () => {
    for (const raw of [
        { uploadUrl: 'https://example.com' },
        { branding: { html: '<script>' } },
        { ui: { toolbar: false } },
        { theme: { css: 'body { display: none }' } },
        JSON.parse('{"theme":{"__proto__":"#fff"}}'),
        { [Symbol('hidden')]: true }
    ]) {
        assert.throws(() => normalizeOptions(raw), /unknown option/);
    }
});

test('configuration requires plain objects and data properties', () => {
    for (const raw of [null, [], true, 'options', new Date(), Object.create({ branding: {} })]) {
        assert.throws(() => normalizeOptions(raw), /options must be a plain object/);
    }
    for (const key of ['branding', 'theme', 'ui']) {
        for (const value of [null, [], true, undefined]) {
            assert.throws(() => normalizeOptions({ [key]: value }), /must be a plain object/);
        }
    }
    const raw = {};
    Object.defineProperty(raw, 'branding', { get() { throw new Error('Getter executed'); } });
    assert.throws(() => normalizeOptions(raw), /must be a data property/);
});

test('brand text enforces bounded nonempty names and single-line labels', () => {
    for (const name of ['', '  ', 'x'.repeat(121), 'Brand\nName', 'Brand\u0000Name', 12, null]) {
        assert.throws(() => normalizeOptions({ branding: { name } }), /options.branding.name/);
    }
    assert.equal(normalizeOptions({ branding: { name: 'x'.repeat(120), logoAlt: '' } }).branding.name.length, 120);
    for (const logoAlt of ['x'.repeat(121), 'Brand\tName', false]) {
        assert.throws(() => normalizeOptions({ branding: { logoAlt } }), /options.branding.logoAlt/);
    }
});

test('logos accept host-relative assets and explicitly selected HTTP(S) assets', () => {
    for (const logoUrl of [null, '/assets/logo.svg', './logo.png', '../logo.svg', 'logo.webp', 'https://example.com/logo.svg', 'http://localhost:5174/logo.svg']) {
        assert.equal(normalizeOptions({ branding: { logoUrl } }).branding.logoUrl, logoUrl);
    }
    assert.equal(normalizeOptions({ branding: { logoUrl: ' /logo.svg ' } }).branding.logoUrl, '/logo.svg');
});

test('logos reject executable schemes, implicit external origins, and URL credentials', () => {
    for (const logoUrl of [
        'javascript:alert(1)', 'data:image/svg+xml,<svg></svg>', 'blob:https://example.com/id',
        'ftp://example.com/logo.svg', '//example.com/logo.svg', '\\example.com\\logo.svg', '#logo',
        'https://user:secret@example.com/logo.svg', 'https://user@example.com/logo.svg',
        'https://example.com/\nlogo.svg', 'https://', '', ' '.repeat(5), 'a'.repeat(2049), 12, undefined
    ]) {
        assert.throws(() => normalizeOptions({ branding: { logoUrl } }), /options.branding.logoUrl/);
    }
});

test('theme tokens reject CSS injection and unsupported color syntax', () => {
    for (const accent of ['red', '#1234', '#12345678', ' #fff', '#fffffg', 'var(--host)', 'url(https://example.com)', '#fff; background:url(x)', null, 123]) {
        assert.throws(() => normalizeOptions({ theme: { accent } }), /three- or six-digit hexadecimal color/);
        assert.throws(() => themeVariables({ accent }), /three- or six-digit hexadecimal color/);
    }
    assert.throws(() => themeVariables({ unknown: '#fff' }), /unknown option/);
});

test('chrome flags require actual booleans instead of truthy values', () => {
    for (const value of [0, 1, 'false', null, undefined]) {
        assert.throws(() => normalizeOptions({ ui: { demos: value } }), /options.ui.demos must be a boolean/);
        assert.throws(() => normalizeOptions({ branding: { showReleaseTag: value } }), /showReleaseTag must be a boolean/);
    }
});

test('initial demo selection accepts only the four generated profiles or no demo', () => {
    for (const initialDemo of ['ct', 'mr', 'xr', 'us', null]) {
        assert.equal(normalizeOptions({ initialDemo }).initialDemo, initialDemo);
    }
    for (const initialDemo of ['CT', 'unknown', false, undefined, {}, []]) {
        assert.throws(() => normalizeOptions({ initialDemo }), /options.initialDemo must be/);
    }
});

test('optional host CSP nonce is bounded and preserved without normalization', () => {
    for (const styleNonce of [null, 'rAnd0m/Base64+nonce==', 'x'.repeat(256)]) {
        assert.equal(normalizeOptions({ styleNonce }).styleNonce, styleNonce);
    }
    for (const styleNonce of ['', '  ', 'x'.repeat(257), 'nonce\nother', 'nonce\u0000other', false, undefined]) {
        assert.throws(() => normalizeOptions({ styleNonce }), /options.styleNonce must be/);
    }
});


test('the initial release rejects AI configuration instead of accepting a disabled hidden feature', () => {
    for (const ai of [false, true, {}, {enabled: true}, {baseUrl: 'https://gateway.example/api/ai'}]) {
        assert.throws(() => normalizeOptions({ai}), /unknown option: ai/);
    }
    let getterCalled = false;
    const options = Object.defineProperty({}, 'ai', {enumerable: true, get() {getterCalled = true; return {};}});
    assert.throws(() => normalizeOptions(options), /unknown option: ai/);
    assert.equal(getterCalled, false);
    assert.equal(Object.hasOwn(normalizeOptions(), 'ai'), false);
});
