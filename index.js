/**
 * Extension Manager — a UI-only SillyTavern extension.
 *
 * It enhances the built-in "Extensions" drawer:
 *  - sticky top toolbar (header + search + open-extension tabs)
 *  - search / filter the extension settings drawers
 *  - tab strip for currently expanded extensions, with horizontal scrolling
 *  - one-click collapse all
 *  - optionally fold "Manage extensions" / "Install extension" into a ⋯ menu
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'extension_manager';
const LEGACY_MODULE_NAME = 'extension_manager_plus';
const VERSION = '1.0.1';

const DEFAULTS = {
    compactActions: true, // fold Manage/Install into the ⋯ menu
    showSearch: true,
    showTabs: true,
    sticky: true,
    theme: 'auto', // auto | day | night
};

const settings = Object.assign(
    {},
    DEFAULTS,
    extension_settings[MODULE_NAME] ?? extension_settings[LEGACY_MODULE_NAME] ?? {},
);
extension_settings[MODULE_NAME] = settings;

const state = {
    filter: '',
    tabsSignature: null,
    activeKey: null,
    idSeq: 0,
    scrollRaf: 0,
    refreshTimer: 0,
    observer: null,
    spyLocked: false,
};

const ui = {};

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function normalize(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function isTopLevelDrawer(drawer) {
    // Nested drawers live inside another drawer's content and must not be
    // listed as separate extensions.
    return !drawer.parentElement?.closest('.inline-drawer');
}

function getDrawers() {
    const drawers = [];
    for (const selector of ['#extensions_settings', '#extensions_settings2']) {
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

function isDrawerOpen(drawer) {
    const icon = drawer.querySelector(':scope > .inline-drawer-header .inline-drawer-icon');
    if (icon) return icon.classList.contains('up');
    const content = drawer.querySelector(':scope > .inline-drawer-content');
    return !!content && getComputedStyle(content).display !== 'none';
}

function getOpenDrawers() {
    return getDrawers().filter(drawer => !drawer.classList.contains('emm-filtered') && isDrawerOpen(drawer));
}

function openDrawer(drawer) {
    if (isDrawerOpen(drawer)) return;
    getHeader(drawer)?.click();
}

function collapseDrawer(drawer) {
    if (!isDrawerOpen(drawer)) return;
    getHeader(drawer)?.click();
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

function buildToolbar() {
    const block = document.querySelector('#rm_extensions_block .extensions_block');
    const headerRow = block?.querySelector(':scope > .alignitemscenter');
    if (!block || !headerRow || document.getElementById('emm-sticky')) return false;

    const rm = document.querySelector('#rm_extensions_block');
    if (rm) rm.style.paddingTop = '0px';

    const sticky = document.createElement('div');
    sticky.id = 'emm-sticky';
    sticky.className = 'emm-sticky';

    // Move the native header row into the sticky wrapper so it can never be
    // scrolled out of view. Event handlers bound by SillyTavern stay intact.
    block.insertBefore(sticky, headerRow);
    sticky.appendChild(headerRow);

    const toolbar = document.createElement('div');
    toolbar.id = 'emm-toolbar';
    toolbar.className = 'emm-toolbar';
    toolbar.innerHTML = `
        <div class="emm-search-row" id="emm-search-row">
            <i class="fa-solid fa-magnifying-glass emm-search-icon" aria-hidden="true"></i>
            <input id="emm-search" class="text_pole emm-search-input" type="text"
                   placeholder="搜索扩展（中/英文名）" autocomplete="off" spellcheck="false"
                   aria-label="搜索扩展">
            <span id="emm-count" class="emm-count" hidden></span>
            <div id="emm-search-clear" class="menu_button emm-icon-btn" title="清除搜索" hidden>
                <i class="fa-solid fa-xmark"></i>
            </div>
        </div>
        <div class="emm-tabs-row" id="emm-tabs-row">
            <div id="emm-tabs-left" class="menu_button emm-icon-btn emm-tab-arrow" title="向左滚动" hidden>
                <i class="fa-solid fa-chevron-left"></i>
            </div>
            <div id="emm-tabs" class="emm-tabs" role="tablist" aria-label="已展开的扩展"></div>
            <div id="emm-tabs-empty" class="emm-tabs-empty">展开扩展后可在标签间切换</div>
            <div id="emm-tabs-right" class="menu_button emm-icon-btn emm-tab-arrow" title="向右滚动" hidden>
                <i class="fa-solid fa-chevron-right"></i>
            </div>
            <div id="emm-collapse-all" class="menu_button emm-icon-btn" title="折叠全部已展开的扩展">
                <i class="fa-solid fa-compress"></i>
            </div>
            <div id="emm-settings-btn" class="menu_button emm-icon-btn" title="扩展管理器设置">
                <i class="fa-solid fa-gear"></i>
            </div>
        </div>
        <div id="emm-no-results" class="emm-no-results" hidden>没有匹配的扩展</div>
    `;
    sticky.appendChild(toolbar);

    const menuWrap = document.createElement('div');
    menuWrap.className = 'emm-menu-wrap';
    menuWrap.innerHTML = `
        <div id="emm-kebab" class="menu_button emm-kebab" title="扩展操作">
            <i class="fa-solid fa-ellipsis"></i>
        </div>
        <div id="emm-dropdown" class="emm-dropdown" hidden>
            <button type="button" class="emm-menu-item" data-action="manage">
                <i class="fa-solid fa-cubes"></i><span>管理扩展</span>
            </button>
            <button type="button" class="emm-menu-item" data-action="install">
                <i class="fa-solid fa-cloud-arrow-down"></i><span>安装扩展</span>
            </button>
            <div class="emm-menu-sep"></div>
            <button type="button" class="emm-menu-item" data-action="show-native">
                <i class="fa-solid fa-table-columns"></i><span>显示顶部按钮</span>
            </button>
            <button type="button" class="emm-menu-item" data-action="hide-native">
                <i class="fa-solid fa-compress"></i><span>收起顶部按钮</span>
            </button>
        </div>
    `;
    headerRow.appendChild(menuWrap);

    ui.sticky = sticky;
    ui.toolbar = toolbar;
    ui.searchRow = document.getElementById('emm-search-row');
    ui.search = /** @type {HTMLInputElement} */ (document.getElementById('emm-search'));
    ui.searchClear = document.getElementById('emm-search-clear');
    ui.count = document.getElementById('emm-count');
    ui.tabsRow = document.getElementById('emm-tabs-row');
    ui.tabs = document.getElementById('emm-tabs');
    ui.tabsEmpty = document.getElementById('emm-tabs-empty');
    ui.tabsLeft = document.getElementById('emm-tabs-left');
    ui.tabsRight = document.getElementById('emm-tabs-right');
    ui.collapseAll = document.getElementById('emm-collapse-all');
    ui.settingsBtn = document.getElementById('emm-settings-btn');
    ui.noResults = document.getElementById('emm-no-results');
    ui.kebab = document.getElementById('emm-kebab');
    ui.dropdown = document.getElementById('emm-dropdown');

    return true;
}

function appendSettingsDrawer() {
    const root = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!root || document.getElementById('emm-settings-drawer')) return;

    const drawer = document.createElement('div');
    drawer.className = 'inline-drawer';
    drawer.id = 'emm-settings-drawer';
    drawer.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>扩展管理器</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
            <div class="emm-select-row">
                <i class="fa-solid fa-palette emm-opt-icon" aria-hidden="true"></i>
                <label for="emm-opt-theme">界面主题</label>
                <select id="emm-opt-theme" class="text_pole emm-theme-select">
                    <option value="auto">跟随酒馆</option>
                    <option value="day">日间</option>
                    <option value="night">夜间</option>
                </select>
            </div>
            <label class="checkbox_label" for="emm-opt-sticky" title="滚动扩展列表时固定顶栏">
                <input id="emm-opt-sticky" type="checkbox">
                <i class="fa-solid fa-thumbtack emm-opt-icon" aria-hidden="true"></i>
                <span>顶栏吸顶</span>
            </label>
            <label class="checkbox_label" for="emm-opt-search" title="在顶栏显示搜索框">
                <input id="emm-opt-search" type="checkbox">
                <i class="fa-solid fa-magnifying-glass emm-opt-icon" aria-hidden="true"></i>
                <span>显示搜索框</span>
            </label>
            <label class="checkbox_label" for="emm-opt-compact" title="把管理扩展和安装扩展收进右上角 ⋯ 菜单">
                <input id="emm-opt-compact" type="checkbox">
                <i class="fa-solid fa-ellipsis emm-opt-icon" aria-hidden="true"></i>
                <span>收纳顶部按钮</span>
            </label>
            <label class="checkbox_label" for="emm-opt-tabs" title="用标签页列出已展开的扩展">
                <input id="emm-opt-tabs" type="checkbox">
                <i class="fa-solid fa-table-columns emm-opt-icon" aria-hidden="true"></i>
                <span>显示已展开标签页</span>
            </label>
            <div class="emm-hint">
                点击标签跳转；✕ 单独折叠，右上角一键全部折叠。收纳后管理与安装进入 ⋯ 菜单。<br>
                版本 ${VERSION}
            </div>
        </div>
    `;
    root.appendChild(drawer);

    const themeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('emm-opt-theme'));
    if (themeSelect) {
        themeSelect.value = normalizeTheme(settings.theme);
        themeSelect.addEventListener('change', () => {
            settings.theme = normalizeTheme(themeSelect.value);
            extension_settings[MODULE_NAME] = settings;
            saveSettingsDebounced();
            updateLayout();
        });
    }

    const options = [
        ['emm-opt-compact', 'compactActions'],
        ['emm-opt-search', 'showSearch'],
        ['emm-opt-tabs', 'showTabs'],
        ['emm-opt-sticky', 'sticky'],
    ];
    for (const [id, key] of options) {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
        input.checked = !!settings[key];
        input.addEventListener('change', () => {
            settings[key] = input.checked;
            extension_settings[MODULE_NAME] = settings;
            saveSettingsDebounced();
            updateLayout();
            refresh();
        });
    }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function normalizeTheme(value) {
    return ['auto', 'day', 'night'].includes(value) ? value : 'auto';
}

function updateLayout() {
    const rm = document.querySelector('#rm_extensions_block');
    rm?.classList.toggle('emm-compact', !!settings.compactActions);

    if (ui.searchRow) ui.searchRow.hidden = !settings.showSearch;
    if (ui.tabsRow) ui.tabsRow.hidden = !settings.showTabs;
    if (ui.sticky) ui.sticky.classList.toggle('emm-sticky-off', !settings.sticky);

    if (!settings.showSearch && state.filter) {
        state.filter = '';
        if (ui.search) ui.search.value = '';
    }

    if (ui.dropdown) {
        const setHidden = (action, hidden) => {
            const item = ui.dropdown.querySelector(`[data-action="${action}"]`);
            if (item) item.hidden = hidden;
        };
        setHidden('manage', !settings.compactActions);
        setHidden('install', !settings.compactActions);
        setHidden('show-native', !settings.compactActions);
        setHidden('hide-native', !!settings.compactActions);
    }
    if (ui.kebab) {
        ui.kebab.title = settings.compactActions ? '扩展操作（管理 / 安装）' : '扩展操作';
    }

    applyThemeMode();

    for (const [id, key] of [
        ['emm-opt-compact', 'compactActions'],
        ['emm-opt-search', 'showSearch'],
        ['emm-opt-tabs', 'showTabs'],
        ['emm-opt-sticky', 'sticky'],
    ]) {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
        if (input) input.checked = !!settings[key];
    }

    const themeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('emm-opt-theme'));
    if (themeSelect) themeSelect.value = normalizeTheme(settings.theme);
}

/** Apply the toolbar's own day/night palette, or follow the ST theme. */
function applyThemeMode() {
    if (!ui.sticky) return;
    const mode = normalizeTheme(settings.theme);
    ui.sticky.classList.remove('emm-theme-auto', 'emm-theme-day', 'emm-theme-night');
    ui.sticky.classList.add(`emm-theme-${mode}`);
    applyStickyBackground();
}

/**
 * SillyTavern theme tints are translucent. Compose an almost opaque color from
 * the active tint so scrolled content cannot shine through the sticky bar.
 * Day/night palettes are opaque via CSS, so the inline color is cleared.
 */
function applyStickyBackground() {
    if (!ui.sticky) return;
    if (normalizeTheme(settings.theme) !== 'auto') {
        ui.sticky.style.backgroundColor = '';
        return;
    }
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const tint = (rootStyle.getPropertyValue('--SmartThemeBlurTintColor')
        || bodyStyle.getPropertyValue('--SmartThemeBlurTintColor')
        || '').trim();
    const rgba = tintToRgba(tint, 1);
    if (rgba) ui.sticky.style.backgroundColor = rgba;
}

function tintToRgba(value, alpha) {
    if (!value) return null;
    const probe = document.createElement('span');
    probe.style.color = value;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const match = computed.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(',').map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
}

function applyFilter() {
    const query = state.filter.trim().toLowerCase();
    const drawers = getDrawers();
    let visible = 0;

    for (const drawer of drawers) {
        const matches = !query || getSearchText(drawer).includes(query);
        const hide = !!query && !matches;
        if (hide !== drawer.classList.contains('emm-filtered')) {
            drawer.classList.toggle('emm-filtered', hide);
        }
        if (matches) visible++;
    }

    if (ui.count) {
        ui.count.hidden = !query;
        ui.count.textContent = query ? `${visible}/${drawers.length}` : '';
    }
    if (ui.noResults) ui.noResults.hidden = !query || visible > 0;
    if (ui.searchClear) ui.searchClear.hidden = !query;

    renderTabs();
}

function renderTabs(force = false) {
    if (!ui.tabs) return;

    const open = getOpenDrawers();
    const signature = open.map(drawer => drawer.dataset.emmId).join('|');
    if (!force && signature === state.tabsSignature) {
        // Titles may change (e.g. an extension updates its header) without the
        // set of open drawers changing; update labels in place, no rebuild.
        const tabs = Array.from(ui.tabs.querySelectorAll('.emm-tab'));
        open.forEach((drawer, index) => {
            const tab = tabs[index];
            if (!tab) return;
            const title = getTitle(drawer);
            const label = tab.querySelector('.emm-tab-label');
            if (label) label.textContent = title;
            tab.title = title;
        });
        ui.collapseAll?.classList.toggle('emm-disabled', open.length === 0);
        syncActiveTab(false);
        updateTabScrollButtons();
        return;
    }
    state.tabsSignature = signature;

    ui.tabs.textContent = '';
    ui.tabsEmpty.hidden = open.length > 0;

    for (const drawer of open) {
        const title = getTitle(drawer);
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'emm-tab';
        tab.dataset.emmTarget = drawer.dataset.emmId;
        tab.title = title;
        tab.setAttribute('role', 'tab');

        const label = document.createElement('span');
        label.className = 'emm-tab-label';
        label.textContent = title;

        const close = document.createElement('span');
        close.className = 'emm-tab-close';
        close.title = '折叠';
        close.innerHTML = '<i class="fa-solid fa-xmark"></i>';

        tab.append(label, close);
        ui.tabs.appendChild(tab);
    }

    if (state.activeKey && !open.some(drawer => drawer.dataset.emmId === state.activeKey)) {
        state.activeKey = null;
    }
    ui.collapseAll?.classList.toggle('emm-disabled', open.length === 0);
    syncActiveTab(false);
    requestAnimationFrame(updateTabScrollButtons);
}

function activateDrawer(drawer) {
    state.activeKey = drawer.dataset.emmId;
    // Keep the clicked tab selected until the user scrolls manually; when the
    // target is the last drawer the container may not be able to scroll far
    // enough, and the scroll spy would otherwise jump to the previous header.
    state.spyLocked = true;
    openDrawer(drawer);
    scrollToDrawer(drawer);
    syncActiveTab(true);
}

function scrollToDrawer(drawer) {
    const container = document.querySelector('#rm_extensions_block');
    if (!container) return;

    const stickyHeight = settings.sticky && ui.sticky ? ui.sticky.offsetHeight : 0;
    const delta = drawer.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const top = Math.max(0, container.scrollTop + delta - stickyHeight - 8);
    container.scrollTo({ top, behavior: 'smooth' });
}

function syncActiveTab(reveal) {
    if (!ui.tabs) return;
    const tabs = Array.from(ui.tabs.querySelectorAll('.emm-tab'));
    if (!tabs.length) {
        state.activeKey = null;
        return;
    }
    let active = tabs.find(tab => tab.dataset.emmTarget === state.activeKey);
    if (!active) {
        active = tabs[0];
        state.activeKey = active.dataset.emmTarget;
    }
    for (const tab of tabs) {
        tab.classList.toggle('active', tab === active);
        tab.setAttribute('aria-selected', String(tab === active));
    }
    if (reveal && ui.tabs) {
        // Horizontal-only reveal. scrollIntoView() would also scroll the
        // settings container vertically and cancel scrollToDrawer().
        const tabRect = active.getBoundingClientRect();
        const boxRect = ui.tabs.getBoundingClientRect();
        const left = ui.tabs.scrollLeft + (tabRect.left - boxRect.left) - (boxRect.width - tabRect.width) / 2;
        ui.tabs.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    }
}

function updateTabScrollButtons() {
    if (!ui.tabs || !ui.tabsLeft || !ui.tabsRight) return;
    const overflow = ui.tabs.scrollWidth > ui.tabs.clientWidth + 4;
    ui.tabsLeft.hidden = !overflow;
    ui.tabsRight.hidden = !overflow;
    if (!overflow) return;
    ui.tabsLeft.classList.toggle('emm-disabled', ui.tabs.scrollLeft <= 1);
    ui.tabsRight.classList.toggle(
        'emm-disabled',
        ui.tabs.scrollLeft >= ui.tabs.scrollWidth - ui.tabs.clientWidth - 1,
    );
}

function updateActiveTabFromScroll() {
    if (state.spyLocked) return;
    const open = getOpenDrawers();
    if (!open.length) return;

    const container = document.querySelector('#rm_extensions_block');
    if (!container) return;

    const stickyHeight = settings.sticky && ui.sticky ? ui.sticky.offsetHeight : 0;
    const line = container.getBoundingClientRect().top + stickyHeight + 10;
    let current = open[0];
    for (const drawer of open) {
        if (drawer.getBoundingClientRect().top <= line) current = drawer;
    }
    if (current.dataset.emmId !== state.activeKey) {
        state.activeKey = current.dataset.emmId;
        syncActiveTab(false);
    }
}

function collapseAll() {
    for (const drawer of getDrawers()) {
        if (isDrawerOpen(drawer)) collapseDrawer(drawer);
    }
    state.activeKey = null;
    setTimeout(() => refresh(), 380);
}

function refresh() {
    applyFilter();
}

function scheduleRefresh(delay = 120) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refresh, delay);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function bindUi() {
    if (!ui.search) return;

    ui.search.addEventListener('input', () => {
        state.filter = ui.search.value;
        // Coalesce into one update per frame so typing never waits on layout.
        scheduleFilter();
    });
    ui.search.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            clearSearch();
        }
    });

    ui.searchClear?.addEventListener('click', clearSearch);

    ui.tabsLeft?.addEventListener('click', () => {
        ui.tabs.scrollBy({ left: -160, behavior: 'smooth' });
    });
    ui.tabsRight?.addEventListener('click', () => {
        ui.tabs.scrollBy({ left: 160, behavior: 'smooth' });
    });
    ui.tabs?.addEventListener('click', event => {
        // Delegated so a tab strip rebuild cannot orphan the click handler.
        const tab = event.target.closest('.emm-tab');
        if (!tab || !ui.tabs?.contains(tab)) return;
        const drawer = getDrawers().find(item => item.dataset.emmId === tab.dataset.emmTarget);
        if (!drawer) return;

        if (event.target.closest('.emm-tab-close')) {
            event.stopPropagation();
            collapseDrawer(drawer);
            state.activeKey = drawer.dataset.emmId;
            setTimeout(() => renderTabs(true), 320);
            return;
        }
        activateDrawer(drawer);
    });
    ui.tabs?.addEventListener('wheel', event => {
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            ui.tabs.scrollLeft += event.deltaY;
            event.preventDefault();
        }
    }, { passive: false });
    ui.tabs?.addEventListener('scroll', updateTabScrollButtons, { passive: true });

    ui.collapseAll?.addEventListener('click', collapseAll);

    ui.kebab?.addEventListener('click', event => {
        event.stopPropagation();
        if (!ui.dropdown) return;
        ui.dropdown.hidden = !ui.dropdown.hidden;
    });

    ui.dropdown?.addEventListener('click', event => {
        const item = event.target.closest('.emm-menu-item');
        if (!item) return;
        const action = item.dataset.action;
        if (action === 'manage') {
            document.querySelector('#extensions_details')?.click();
        } else if (action === 'install') {
            document.querySelector('#third_party_extension_button')?.click();
        } else if (action === 'show-native') {
            settings.compactActions = false;
            extension_settings[MODULE_NAME] = settings;
            saveSettingsDebounced();
            updateLayout();
            refresh();
        } else if (action === 'hide-native') {
            settings.compactActions = true;
            extension_settings[MODULE_NAME] = settings;
            saveSettingsDebounced();
            updateLayout();
            refresh();
        }
        if (ui.dropdown) ui.dropdown.hidden = true;
    });

    document.addEventListener('click', event => {
        if (!ui.dropdown || ui.dropdown.hidden) return;
        if (event.target.closest('.emm-menu-wrap')) return;
        ui.dropdown.hidden = true;
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && ui.dropdown && !ui.dropdown.hidden) {
            ui.dropdown.hidden = true;
        }
    });

    ui.settingsBtn?.addEventListener('click', () => {
        const drawer = document.getElementById('emm-settings-drawer');
        if (!drawer) return;
        if (state.filter) clearSearch();
        if (!isDrawerOpen(drawer)) getHeader(drawer)?.click();
        setTimeout(() => scrollToDrawer(drawer), 80);
    });

    const rm = document.querySelector('#rm_extensions_block');
    rm?.addEventListener('scroll', onScroll, { passive: true });
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        rm?.addEventListener(type, () => {
            state.spyLocked = false;
        }, { passive: true });
    }

    // SillyTavern applies themes by writing CSS variables to :root. Recompute
    // the translucent follow-theme surface when that happens.
    new MutationObserver(() => {
        if (normalizeTheme(settings.theme) === 'auto') applyStickyBackground();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

    document.addEventListener('inline-drawer-toggle', event => {
        const drawer = event.target?.closest?.('.inline-drawer');
        if (!drawer || !drawer.closest('#rm_extensions_block')) return;
        if (!isTopLevelDrawer(drawer)) return;
        // The icon class flips synchronously, so the tab can appear on the next
        // frame; a second pass after the slide animation catches late header
        // changes without making the open action feel delayed.
        requestAnimationFrame(() => refresh());
        scheduleRefresh(320);
    });

    window.addEventListener('resize', () => {
        updateTabScrollButtons();
    });

    observeSettings();
}

function clearSearch() {
    state.filter = '';
    if (ui.search) ui.search.value = '';
    cancelScheduledFilter();
    applyFilter();
    ui.search?.focus();
}

let filterFrame = 0;

function scheduleFilter() {
    if (filterFrame) return;
    filterFrame = requestAnimationFrame(() => {
        filterFrame = 0;
        applyFilter();
    });
}

function cancelScheduledFilter() {
    if (!filterFrame) return;
    cancelAnimationFrame(filterFrame);
    filterFrame = 0;
}

function onScroll() {
    if (state.scrollRaf) return;
    state.scrollRaf = requestAnimationFrame(() => {
        state.scrollRaf = 0;
        updateActiveTabFromScroll();
        updateTabScrollButtons();
    });
}

function observeSettings() {
    if (state.observer) state.observer.disconnect();
    state.observer = new MutationObserver(() => scheduleRefresh(150));
    for (const root of [document.querySelector('#extensions_settings'), document.querySelector('#extensions_settings2')]) {
        if (root) {
            state.observer.observe(root, { childList: true, subtree: true });
        }
    }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function init() {
    if (document.getElementById('emm-sticky')) return true;
    if (!buildToolbar()) return false;
    appendSettingsDrawer();
    bindUi();
    updateLayout();
    refresh();
    console.log(`[${MODULE_NAME}] ready (v${VERSION})`);
    return true;
}

function boot() {
    if (init()) return;
    let attempts = 0;
    const timer = setInterval(() => {
        if (init() || ++attempts > 40) {
            clearInterval(timer);
            if (attempts > 40) console.warn(`[${MODULE_NAME}] extensions panel not found`);
        }
    }, 250);
}

boot();
