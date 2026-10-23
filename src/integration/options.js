import { SourceRegistry } from '../catalog/SourceRegistry.js';
import { normalizeAiConfiguration } from '../ai/AiClient.js';

const themeProperties = Object.freeze({
    accent: '--accent',
    background: '--bg',
    panel: '--panel',
    text: '--text',
    muted: '--muted',
    border: '--border'
});

const defaultUi = Object.freeze({
    header: true,
    library: true,
    inspector: true,
    statusBar: true,
    demos: true
});

function record(value, path, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new TypeError(`EASI View ${path} must be a plain object.`);
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !keys.includes(key)) {
            throw new TypeError(`EASI View ${path} contains an unknown option: ${String(key)}.`);
        }
        if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) {
            throw new TypeError(`EASI View ${path}.${key} must be a data property.`);
        }
    }
    return value;
}

function text(value, path, allowEmpty = false) {
    if (typeof value !== 'string' || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError(`EASI View ${path} must be text of at most 120 characters without control characters.`);
    }
    const trimmed = value.trim();
    if (!allowEmpty && !trimmed) {
        throw new TypeError(`EASI View ${path} must not be empty.`);
    }
    return trimmed;
}

function boolean(value, path) {
    if (typeof value !== 'boolean') throw new TypeError(`EASI View ${path} must be a boolean.`);
    return value;
}

function logoUrl(value) {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > 2048 || !value.trim()
        || /[\u0000-\u001f\u007f\\]/.test(value)) {
        throw new TypeError('EASI View options.branding.logoUrl must be a relative path or an HTTP(S) URL.');
    }
    const trimmed = value.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
        throw new TypeError('EASI View options.branding.logoUrl must not be a protocol-relative URL or a fragment.');
    }
    let parsed;
    try {
        parsed = new URL(trimmed, 'https://easi-view.invalid/');
    } catch {
        throw new TypeError('EASI View options.branding.logoUrl must be a relative path or an HTTP(S) URL.');
    }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new TypeError('EASI View options.branding.logoUrl must use HTTP(S) without URL credentials.');
    }
    // Relative logo paths keep the default integration on the host's origin.
    // An absolute URL is an explicit host choice to request that logo externally.
    return trimmed;
}

function normalizeTheme(value) {
    const source = record(value, 'options.theme', Object.keys(themeProperties));
    const theme = {};
    for (const [key, color] of Object.entries(source)) {
        if (typeof color !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) {
            throw new TypeError(`EASI View options.theme.${key} must be a three- or six-digit hexadecimal color.`);
        }
        theme[key] = color.toLowerCase();
    }
    return theme;
}

/** Validate host configuration without DOM mutations or network requests. */
export function normalizeOptions(raw = {}) {
    const source = record(raw, 'options', ['branding', 'theme', 'ui', 'initialDemo', 'styleNonce', 'sources', 'opening', 'ai']);
    const branding = { name: 'EASI View', logoUrl: null, logoAlt: '', showReleaseTag: true };
    if (Object.hasOwn(source, 'branding')) {
        const values = record(source.branding, 'options.branding', Object.keys(branding));
        if (Object.hasOwn(values, 'name')) branding.name = text(values.name, 'options.branding.name');
        if (Object.hasOwn(values, 'logoUrl')) branding.logoUrl = logoUrl(values.logoUrl);
        if (Object.hasOwn(values, 'logoAlt')) branding.logoAlt = text(values.logoAlt, 'options.branding.logoAlt', true);
        if (Object.hasOwn(values, 'showReleaseTag')) {
            branding.showReleaseTag = boolean(values.showReleaseTag, 'options.branding.showReleaseTag');
        }
    }
    const ui = { ...defaultUi };
    if (Object.hasOwn(source, 'ui')) {
        const values = record(source.ui, 'options.ui', Object.keys(defaultUi));
        for (const [key, value] of Object.entries(values)) ui[key] = boolean(value, `options.ui.${key}`);
    }
    const theme = Object.hasOwn(source, 'theme') ? normalizeTheme(source.theme) : {};
    const initialDemo = Object.hasOwn(source, 'initialDemo') ? source.initialDemo : null;
    if (initialDemo !== null && !['ct', 'mr', 'xr', 'us'].includes(initialDemo)) {
        throw new TypeError('EASI View options.initialDemo must be ct, mr, xr, us, or null.');
    }
    const styleNonce = Object.hasOwn(source, 'styleNonce') ? source.styleNonce : null;
    if (styleNonce !== null && (typeof styleNonce !== 'string' || !styleNonce.trim()
        || styleNonce.length > 256 || /[\u0000-\u001f\u007f]/.test(styleNonce))) {
        throw new TypeError('EASI View options.styleNonce must be nonempty text of at most 256 characters without control characters, or null.');
    }
    const result = { branding, theme, ui, initialDemo, styleNonce };
    if (Object.hasOwn(source, 'sources')) {
        const registry = new SourceRegistry(source.sources);
        registry.dispose();
        result.sources = source.sources.map(item => ({ ...item,
            ...(item.headers && typeof item.headers === 'object' ? { headers: { ...item.headers } } : {}),
            ...(item.searchFields ? { searchFields: [...item.searchFields] } : {}) }));
    }
    if (Object.hasOwn(source, 'opening')) {
        const values = record(source.opening, 'options.opening', ['localImages', 'localStudies', 'remoteStudies', 'tests', 'sourceEditing']);
        result.opening = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, boolean(value, `options.opening.${key}`)]));
        if (result.opening.tests === false && initialDemo !== null) throw new TypeError('Enable synthetic examples before choosing an initial demo.');
    }
    if (Object.hasOwn(source, 'ai')) result.ai = normalizeAiConfiguration(source.ai);
    return result;
}

/** Return the supported scoped CSS variables; arbitrary CSS is never accepted. */
export function themeVariables(theme = {}) {
    return Object.fromEntries(Object.entries(normalizeTheme(theme)).map(([key, value]) => [themeProperties[key], value]));
}
