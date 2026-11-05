/**
 * Extension Manager — Drawer access
 *
 * Read-only helpers over the SillyTavern extension drawers: locating them, deriving their
 * display titles and stable member keys, and opening or collapsing them.
 */

import { isBuiltinHidden } from './builtins.js';
import { normalize, settings, state } from './core.js';

function isTopLevelDrawer(drawer) {
    // Nested drawers live inside another drawer's content and must not be
    // listed as separate extensions.
    return !drawer.parentElement?.closest('.inline-drawer');
}

function getDrawers() {
    const drawers = [];
    for (const selector of ['#extensions_settings', '#extensions_settings2', '#emm-groups']) {
        const root = document.querySelector(selector);
        if (!root) continue;
        for (const drawer of root.querySelectorAll('.inline-drawer')) {
            if (!isTopLevelDrawer(drawer)) continue;
            if (!drawer.dataset.emmId) {
                drawer.dataset.emmId = `emm-${++state.idSeq}`;
            }
            drawers.push(drawer);
        }
    }
    return drawers;
}

function getHeader(drawer) {
    return drawer.querySelector(':scope > .inline-drawer-header');
}

function getTitle(drawer) {
    return getDrawerMeta(drawer).title;
}

function getSearchText(drawer) {
    return getDrawerMeta(drawer).haystack;
}

const drawerMetaCache = new WeakMap();

/**
 * Titles and i18n keys are stable for the lifetime of a header, but extensions
 * may update their header text. Cache the parsed values per header node and
 * only recompute when the header's text actually changes.
 */
function getDrawerMeta(drawer) {
    const header = getHeader(drawer);
    const text = header ? header.textContent : '';
    const cached = drawerMetaCache.get(drawer);
    if (cached && cached.header === header && cached.text === text) {
        return cached;
    }

    const title = computeTitle(header);
    const parts = [title];
    header?.querySelectorAll('[data-i18n]').forEach(el => {
        parts.push(String(el.getAttribute('data-i18n') ?? '').replace(/^\[[^\]]+\]/, ''));
    });

    const meta = { header, text, title, haystack: parts.join(' ').toLowerCase() };
    drawerMetaCache.set(drawer, meta);
    return meta;
}

function computeTitle(header) {
    if (!header) return '未命名扩展';

    const bold = header.querySelector('b');
    if (bold) {
        const clone = bold.cloneNode(true);
        for (const el of clone.querySelectorAll('span, small, sup')) {
            if (/^(new!?|新!?|hot!?|beta)$/i.test(normalize(el.textContent))) {
                el.remove();
            }
        }
        const text = normalize(clone.textContent);
        if (text) return text;
    }

    const headerClone = header.cloneNode(true);
    headerClone
        .querySelectorAll('.inline-drawer-icon, i, svg, button, input, select')
        .forEach(el => el.remove());
    return normalize(headerClone.textContent) || '未命名扩展';
}

/**
 * Membership key for a drawer. Titles are display text: they change with the
 * UI language and can be edited or duplicated by an extension, so grouping
 * stores this key instead. Order matters: a DOM id is the strongest anchor,
 * then the i18n key, then the title as a last resort.
 */
function drawerKey(drawer) {
    if (drawer.dataset.emmKey) return drawer.dataset.emmKey;
    let key = '';
    if (drawer.id) {
        key = `id:${drawer.id}`;
    } else {
        const node = getHeader(drawer)?.querySelector('[data-i18n]');
        const raw = String(node?.getAttribute('data-i18n') ?? '').replace(/^\[[^\]]+\]/, '').trim();
        if (raw) key = `i18n:${raw}`;
    }
    if (!key) key = `title:${getTitle(drawer)}`;
    drawer.dataset.emmKey = key;
    return key;
}

function keyTitle(key) {
    for (const drawer of getDrawers()) {
        if (drawerKey(drawer) === key) return getTitle(drawer);
    }
    return String(key ?? '').replace(/^(id|i18n|title):/, '');
}

/** Title -> key for every drawer currently in the DOM. */
function titleKeyMap() {
    const map = new Map();
    for (const drawer of getDrawers()) map.set(getTitle(drawer), drawerKey(drawer));
    return map;
}

function isDrawerOpen(drawer) {
    const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
    if (icon) return icon.classList.contains('up');
    const content = drawer.querySelector(':scope > .inline-drawer-content');
    return !!content && getComputedStyle(content).display !== 'none';
}

function getOpenDrawers() {
    return getDrawers().filter(drawer => !drawer.classList.contains('emm-filtered')
        && !isBuiltinHidden(drawer)
        && isDrawerOpen(drawer));
}

function openDrawer(drawer) {
    if (isDrawerOpen(drawer)) return;
    getHeader(drawer)?.click();
}

function collapseDrawer(drawer) {
    if (!isDrawerOpen(drawer)) return;
    getHeader(drawer)?.click();
}

function clampLabelMax(value) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return 5;
    return Math.min(10, Math.max(2, parsed));
}

function tabLabel(title) {
    if (settings.tabLabelClip === false) return title;
    const max = clampLabelMax(settings.tabLabelMax);
    const chars = Array.from(title);
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : title;
}

function setNativeRootsHidden(hidden) {
    for (const id of ['extensions_settings', 'extensions_settings2']) {
        const root = document.getElementById(id);
        if (root) root.style.display = hidden ? 'none' : '';
    }
}

export {
    clampLabelMax,
    collapseDrawer,
    computeTitle,
    drawerKey,
    drawerMetaCache,
    getDrawerMeta,
    getDrawers,
    getHeader,
    getOpenDrawers,
    getSearchText,
    getTitle,
    isDrawerOpen,
    isTopLevelDrawer,
    keyTitle,
    openDrawer,
    setNativeRootsHidden,
    tabLabel,
    titleKeyMap,
};
