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
const VERSION = '1.1.0';
const UNGROUPED_ID = '__ungrouped';

const DEFAULTS = {
    compactActions: true, // fold Manage/Install into the ⋯ menu
    showSearch: true,
    theme: 'auto', // auto | day | night
    tabLabelMax: 5, // characters shown in a tab before the name is clipped
    grouping: false, // show custom groups instead of a flat list
    groups: [], // [{ id, name, enabled, collapsed, members: [title] }]
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
    groupSignature: '',
    origin: new Map(),
    groupingReady: false,
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
/* Groups                                                              */
/* ------------------------------------------------------------------ */

function saveSettings() {
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

function normalizeGroups() {
    if (!Array.isArray(settings.groups)) settings.groups = [];
    const seen = new Set();
    settings.groups = settings.groups
        .filter(group => group && typeof group === 'object')
        .map((group, index) => {
            let id = String(group.id || `g${index + 1}`);
            while (seen.has(id)) id = `${id}x`;
            seen.add(id);
            return {
                id,
                name: normalize(group.name) || `分组 ${index + 1}`,
                enabled: group.enabled !== false,
                collapsed: !!group.collapsed,
                members: Array.isArray(group.members) ? group.members.map(String) : [],
            };
        });
}

function findGroupForTitle(title) {
    return settings.groups.find(group => group.members.includes(title)) ?? null;
}

function clampLabelMax(value) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return 5;
    return Math.min(30, Math.max(2, parsed));
}

function tabLabel(title) {
    const max = clampLabelMax(settings.tabLabelMax);
    const chars = Array.from(title);
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : title;
}

function ensureGroupHost() {
    const host = document.querySelector('#rm_extensions_block .extensions_block');
    if (!host) return null;
    let wrap = document.getElementById('emm-groups');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'emm-groups';
        const anchor = document.getElementById('extensions_settings') ?? host.firstChild;
        host.insertBefore(wrap, anchor);
    }
    return wrap;
}

function setNativeRootsHidden(hidden) {
    for (const id of ['extensions_settings', 'extensions_settings2']) {
        const root = document.getElementById(id);
        if (root) root.style.display = hidden ? 'none' : '';
    }
}

function groupSignature() {
    const titles = getDrawers().map(drawer => getTitle(drawer)).join('\u0001');
    const groups = settings.groups
        .map(group => [group.id, group.enabled ? 1 : 0, group.name, group.members.join(',')].join(':'))
        .join('\u0002');
    return `${titles}\u0003${groups}`;
}

function buildGroupSection(group, drawers) {
    const section = document.createElement('section');
    section.className = 'emm-group';
    section.dataset.groupId = group.id;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'emm-group-head';
    head.innerHTML = `
        <i class="fa-solid fa-chevron-down emm-group-caret" aria-hidden="true"></i>
        <span class="emm-group-name"></span>
        <span class="emm-group-count"></span>
    `;
    head.querySelector('.emm-group-name').textContent = group.name;
    head.querySelector('.emm-group-count').textContent = String(drawers.length);
    head.addEventListener('click', () => {
        const collapsed = section.classList.toggle('emm-collapsed');
        if (group.id === UNGROUPED_ID) {
            state.ungroupedCollapsed = collapsed;
        } else {
            group.collapsed = collapsed;
            saveSettings();
        }
    });

    const body = document.createElement('div');
    body.className = 'emm-group-body';
    const split = Math.ceil(drawers.length / 2);
    for (const slice of [drawers.slice(0, split), drawers.slice(split)]) {
        const column = document.createElement('div');
        column.className = 'emm-group-col';
        column.append(...slice);
        body.append(column);
    }

    if (group.collapsed) section.classList.add('emm-collapsed');
    section.append(head, body);
    return section;
}

function renderGrouped() {
    const wrap = ensureGroupHost();
    if (!wrap) return;

    const all = getDrawers();
    if (!state.baseOrder) state.baseOrder = new Map();
    let seq = state.baseOrder.size;
    for (const drawer of all) {
        if (!state.baseOrder.has(drawer)) state.baseOrder.set(drawer, seq++);
        if (!state.origin.has(drawer)) {
            state.origin.set(drawer, { parent: drawer.parentElement, next: drawer.nextElementSibling });
        }
    }
    all.sort((a, b) => (state.baseOrder.get(a) ?? 0) - (state.baseOrder.get(b) ?? 0));

    const buckets = new Map(settings.groups.map(group => [group.id, []]));
    const ungrouped = [];
    const hidden = [];
    for (const drawer of all) {
        if (drawer.id === 'emm-settings-drawer') {
            ungrouped.push(drawer);
            continue;
        }
        const group = findGroupForTitle(getTitle(drawer));
        if (group && group.enabled) {
            buckets.get(group.id).push(drawer);
        } else if (group && !group.enabled) {
            hidden.push(drawer);
        } else {
            ungrouped.push(drawer);
        }
    }

    setNativeRootsHidden(false);

    // Preserve drawers that are not part of the tracked set (for example a
    // wrapper that appeared while a group was collapsed) instead of dropping
    // them when the container is rebuilt.
    const known = new Set(all);
    const orphans = [];
    for (const drawer of wrap.querySelectorAll('.inline-drawer')) {
        if (drawer.parentElement?.closest('.inline-drawer')) continue;
        if (!known.has(drawer)) orphans.push(drawer);
    }
    wrap.textContent = '';

    for (const group of settings.groups) {
        const members = buckets.get(group.id);
        if (members?.length) wrap.append(buildGroupSection(group, members));
    }

    if (ungrouped.length) {
        const section = buildGroupSection({ id: UNGROUPED_ID, name: '未分组' }, ungrouped);
        if (state.ungroupedCollapsed) section.classList.add('emm-collapsed');
        wrap.append(section);
    }

    if (hidden.length) {
        const stash = document.createElement('div');
        stash.id = 'emm-groups-hidden';
        stash.hidden = true;
        stash.append(...hidden);
        wrap.append(stash);
    }

    const lost = [...state.origin.keys()].filter(drawer => !drawer.isConnected && !orphans.includes(drawer));
    if (orphans.length || lost.length) {
        for (const drawer of [...orphans, ...lost]) {
            if (!state.origin.has(drawer)) {
                state.origin.set(drawer, { parent: null, next: null });
            }
        }
        const stash = document.createElement('div');
        stash.id = 'emm-groups-orphans';
        stash.hidden = true;
        stash.append(...orphans, ...lost);
        wrap.append(stash);
    }

    updateGroupVisibility();

    const editing = document.activeElement?.closest?.('#emm-group-rows');
    if (document.getElementById('emm-group-rows') && !editing) renderGroupEditor();
}

function teardownGrouping() {
    const wrap = document.getElementById('emm-groups');
    const entries = [...state.origin.entries()];
    for (let index = entries.length - 1; index >= 0; index--) {
        const [drawer, origin] = entries[index];
        if (!drawer.isConnected) continue;
        if (!origin.parent?.isConnected) {
            document.querySelector('#extensions_settings')?.append(drawer);
            continue;
        }
        const anchor = origin.next?.parentNode === origin.parent ? origin.next : null;
        origin.parent.insertBefore(drawer, anchor);
    }
    state.origin.clear();
    state.baseOrder = null;
    state.groupSignature = '';
    wrap?.remove();
    setNativeRootsHidden(false);
}
function applyGrouping(force = false) {
    if (settings.grouping && !state.groupingReady) return;
    if (!settings.grouping) {
        if (document.getElementById('emm-groups') || state.origin.size) teardownGrouping();
        return;
    }
    const signature = groupSignature();
    if (!force && signature === state.groupSignature && document.getElementById('emm-groups')) {
        updateGroupVisibility();
        return;
    }
    state.groupSignature = signature;
    renderGrouped();
}

function updateGroupVisibility() {
    const wrap = document.getElementById('emm-groups');
    if (!wrap) return;
    wrap.classList.toggle('emm-searching', !!state.filter.trim());
    if (!settings.grouping) return;
    for (const section of wrap.querySelectorAll('.emm-group')) {
        const drawers = [...section.querySelectorAll('.inline-drawer')]
            .filter(drawer => !drawer.parentElement.closest('.inline-drawer'));
        section.hidden = !drawers.some(drawer => !drawer.classList.contains('emm-filtered'));
    }
}

function buildGroupEditorRow(group, titles) {
    const row = document.createElement('div');
    row.className = 'emm-group-row';
    row.dataset.groupId = group.id;

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = group.enabled;
    enabled.title = '启用分组';
    enabled.setAttribute('aria-label', `启用分组 ${group.name}`);
    enabled.addEventListener('change', () => {
        group.enabled = enabled.checked;
        saveSettings();
        renderGearGroups();
        applyGrouping(true);
    });

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'text_pole emm-group-name-input';
    name.value = group.name;
    name.maxLength = 16;
    name.setAttribute('aria-label', '分组名称');
    name.addEventListener('change', () => {
        group.name = normalize(name.value) || group.name;
        name.value = group.name;
        saveSettings();
        renderGearGroups();
        applyGrouping(true);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'emm-group-remove';
    remove.title = '删除分组';
    remove.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    remove.addEventListener('click', () => {
        settings.groups = settings.groups.filter(item => item.id !== group.id);
        saveSettings();
        renderGroupEditor();
        renderGearGroups();
        applyGrouping(true);
    });

    row.append(enabled, name, remove);

    const members = document.createElement('details');
    members.className = 'emm-group-members';
    const summary = document.createElement('summary');
    summary.textContent = `成员 ${group.members.length}`;
    const list = document.createElement('div');
    list.className = 'emm-member-list';
    for (const title of titles) {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = title;
        box.checked = group.members.includes(title);
        box.addEventListener('change', () => {
            const checked = [...list.querySelectorAll('input[type="checkbox"]')]
                .filter(input => input.checked)
                .map(input => input.value);
            group.members = checked;
            summary.textContent = `成员 ${checked.length}`;
            saveSettings();
            renderGearGroups();
            applyGrouping(true);
        });
        const text = document.createElement('span');
        text.textContent = title;
        label.append(box, text);
        list.append(label);
    }
    members.append(summary, list);

    const wrapper = document.createElement('div');
    wrapper.className = 'emm-group-item';
    wrapper.append(row, members);
    return wrapper;
}

function renderGroupEditor() {
    const host = document.getElementById('emm-group-rows');
    if (!host) return;
    host.textContent = '';
    if (!settings.groups.length) {
        const empty = document.createElement('div');
        empty.className = 'emm-hint';
        empty.textContent = '还没有分组';
        host.append(empty);
        return;
    }
    const titles = getDrawers()
        .filter(drawer => drawer.id !== 'emm-settings-drawer')
        .map(drawer => getTitle(drawer));
    for (const group of settings.groups) {
        host.append(buildGroupEditorRow(group, titles));
    }
}

function renderGearGroups() {
    const host = document.getElementById('emm-acc-groups');
    if (!host) return;
    host.textContent = '';
    if (!settings.groups.length) {
        const empty = document.createElement('div');
        empty.className = 'emm-acc-empty';
        empty.textContent = '还没有分组，去设置里添加';
        host.append(empty);
        return;
    }
    for (const group of settings.groups) {
        const label = document.createElement('label');
        label.className = 'emm-acc-group';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = group.enabled;
        box.addEventListener('change', () => {
            group.enabled = box.checked;
            saveSettings();
            renderGroupEditor();
            applyGrouping(true);
        });
        const name = document.createElement('span');
        name.className = 'emm-acc-name';
        name.textContent = group.name;
        const count = document.createElement('span');
        count.className = 'emm-acc-count';
        count.textContent = String(group.members.length);
        label.append(box, name, count);
        host.append(label);
    }
}

function addGroup(rawName) {
    normalizeGroups();
    const name = normalize(rawName) || `分组 ${settings.groups.length + 1}`;
    settings.groups.push({
        id: `g${Date.now().toString(36)}`,
        name,
        enabled: true,
        collapsed: false,
        members: [],
    });
    saveSettings();
    renderGroupEditor();
    renderGearGroups();
    applyGrouping(true);
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
            <div class="emm-gear-wrap">
                <div id="emm-settings-btn" class="menu_button emm-icon-btn" title="扩展管理器菜单">
                    <i class="fa-solid fa-gear"></i>
                </div>
                <div id="emm-gear-menu" class="emm-dropdown emm-gear-menu" hidden>
                    <button type="button" class="emm-menu-item" data-action="settings">
                        <i class="fa-solid fa-sliders"></i><span>设置界面</span>
                    </button>
                    <div class="emm-gear-acc">
                        <div class="emm-gear-acc-head">
                            <label class="emm-switch-label" for="emm-grouping-toggle">
                                <input id="emm-grouping-toggle" type="checkbox">
                                <span>启用分组展示</span>
                            </label>
                            <button id="emm-acc-chevron" type="button" class="emm-acc-chevron" title="展开分组列表">
                                <i class="fa-solid fa-chevron-down"></i>
                            </button>
                        </div>
                        <div id="emm-acc-body" class="emm-acc-body" hidden>
                            <div id="emm-acc-groups"></div>
                            <button type="button" class="emm-menu-item emm-manage-groups" data-action="manage-groups">
                                <i class="fa-solid fa-pen-to-square"></i><span>管理分组…</span>
                            </button>
                        </div>
                    </div>
                </div>
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
    ui.gearMenu = document.getElementById('emm-gear-menu');
    ui.gearWrap = document.querySelector('.emm-gear-wrap');
    ui.groupingToggle = /** @type {HTMLInputElement} */ (document.getElementById('emm-grouping-toggle'));
    ui.accChevron = document.getElementById('emm-acc-chevron');
    ui.accBody = document.getElementById('emm-acc-body');
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
            <div class="emm-select-row">
                <i class="fa-solid fa-tag emm-opt-icon" aria-hidden="true"></i>
                <label for="emm-opt-labelmax">标签字数上限</label>
                <input id="emm-opt-labelmax" class="text_pole emm-number" type="number"
                       min="2" max="30" step="1" inputmode="numeric">
            </div>
            <div class="emm-group-editor" id="emm-group-editor">
                <div class="emm-section-title">
                    <i class="fa-solid fa-layer-group emm-opt-icon" aria-hidden="true"></i>
                    <span>分组</span>
                </div>
                <div id="emm-group-rows"></div>
                <div class="emm-add-group">
                    <input id="emm-new-group" class="text_pole" type="text" maxlength="16"
                           placeholder="新分组名称" aria-label="新分组名称">
                    <button id="emm-add-group-btn" type="button" class="menu_button">添加</button>
                </div>
            </div>
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
            saveSettings();
            updateLayout();
        });
    }

    const options = [
        ['emm-opt-compact', 'compactActions'],
        ['emm-opt-search', 'showSearch'],
    ];
    for (const [id, key] of options) {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
        input.checked = !!settings[key];
        input.addEventListener('change', () => {
            settings[key] = input.checked;
            saveSettings();
            updateLayout();
            refresh();
        });
    }

    const labelMax = /** @type {HTMLInputElement} */ (document.getElementById('emm-opt-labelmax'));
    if (labelMax) {
        labelMax.value = String(clampLabelMax(settings.tabLabelMax));
        labelMax.addEventListener('change', () => {
            settings.tabLabelMax = clampLabelMax(labelMax.value);
            labelMax.value = String(settings.tabLabelMax);
            saveSettings();
            renderTabs(true);
        });
    }

    const newGroup = /** @type {HTMLInputElement} */ (document.getElementById('emm-new-group'));
    const addGroupBtn = document.getElementById('emm-add-group-btn');
    const commitGroup = () => {
        if (!newGroup || !normalize(newGroup.value)) return;
        addGroup(newGroup.value);
        newGroup.value = '';
        newGroup.focus();
    };
    addGroupBtn?.addEventListener('click', commitGroup);
    newGroup?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            commitGroup();
        }
    });

    normalizeGroups();
    renderGroupEditor();
    renderGearGroups();
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
        ui.kebab.hidden = !settings.compactActions;
        ui.kebab.title = '扩展操作（管理 / 安装）';
        if (!settings.compactActions && ui.dropdown) ui.dropdown.hidden = true;
    }

    applyThemeMode();

    for (const [id, key] of [
        ['emm-opt-compact', 'compactActions'],
        ['emm-opt-search', 'showSearch'],
    ]) {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
        if (input) input.checked = !!settings[key];
    }

    const themeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('emm-opt-theme'));
    if (themeSelect) themeSelect.value = normalizeTheme(settings.theme);

    applyGrouping();
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
    updateGroupVisibility();
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
            if (label) label.textContent = tabLabel(title);
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
        label.textContent = tabLabel(title);

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
    expandGroupFor(drawer);
    openDrawer(drawer);
    scrollToDrawer(drawer);
    syncActiveTab(true);
}

function expandGroupFor(drawer) {
    const section = drawer.closest('.emm-group');
    if (!section?.classList.contains('emm-collapsed')) return;
    section.classList.remove('emm-collapsed');
    if (section.dataset.groupId === UNGROUPED_ID) {
        state.ungroupedCollapsed = false;
        return;
    }
    const group = settings.groups.find(item => item.id === section.dataset.groupId);
    if (group) {
        group.collapsed = false;
        saveSettings();
    }
}

function scrollToDrawer(drawer) {
    const container = document.querySelector('#rm_extensions_block');
    if (!container) return;

    const stickyHeight = ui.sticky ? ui.sticky.offsetHeight : 0;
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

    const stickyHeight = ui.sticky ? ui.sticky.offsetHeight : 0;
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
    applyGrouping();
    updateGroupVisibility();
}

function openSettingsPanel(focusGroups) {
    const drawer = document.getElementById('emm-settings-drawer');
    if (!drawer) return;
    if (state.filter) clearSearch();
    expandGroupFor(drawer);
    if (!isDrawerOpen(drawer)) getHeader(drawer)?.click();
    setTimeout(() => {
        scrollToDrawer(drawer);
        if (focusGroups) {
            document.getElementById('emm-new-group')?.focus({ preventScroll: true });
            document.getElementById('emm-group-editor')?.scrollIntoView({ block: 'nearest' });
        }
    }, 80);
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
            saveSettings();
            updateLayout();
            refresh();
        } else if (action === 'hide-native') {
            settings.compactActions = true;
            saveSettings();
            updateLayout();
            refresh();
        }
        if (ui.dropdown) ui.dropdown.hidden = true;
    });

    ui.settingsBtn?.addEventListener('click', event => {
        event.stopPropagation();
        if (!ui.gearMenu) return;
        const willOpen = ui.gearMenu.hidden;
        ui.gearMenu.hidden = !willOpen;
        if (willOpen) {
            if (ui.groupingToggle) ui.groupingToggle.checked = !!settings.grouping;
            renderGearGroups();
            applyGrouping();
        }
    });

    ui.gearMenu?.addEventListener('click', event => {
        const item = event.target.closest('.emm-menu-item');
        if (item) {
            if (item.dataset.action === 'settings') openSettingsPanel(false);
            else if (item.dataset.action === 'manage-groups') openSettingsPanel(true);
            ui.gearMenu.hidden = true;
            return;
        }
        if (event.target.closest('#emm-acc-chevron')) {
            if (!ui.accBody) return;
            ui.accBody.hidden = !ui.accBody.hidden;
            ui.accChevron?.classList.toggle('emm-open', !ui.accBody.hidden);
            if (!ui.accBody.hidden) renderGearGroups();
        }
    });

    ui.groupingToggle?.addEventListener('change', () => {
        state.groupingReady = true;
        settings.grouping = ui.groupingToggle.checked;
        saveSettings();
        if (settings.grouping) normalizeGroups();
        applyGrouping(true);
        renderGroupEditor();
    });

    document.addEventListener('click', event => {
        if (ui.dropdown && !ui.dropdown.hidden && !event.target.closest('.emm-menu-wrap')) {
            ui.dropdown.hidden = true;
        }
        if (ui.gearMenu && !ui.gearMenu.hidden && !event.target.closest('.emm-gear-wrap')) {
            ui.gearMenu.hidden = true;
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (ui.dropdown) ui.dropdown.hidden = true;
        if (ui.gearMenu) ui.gearMenu.hidden = true;
    });

    const rm = document.querySelector('#rm_extensions_block');
    rm?.addEventListener('click', event => {
        const header = event.target.closest?.('.inline-drawer-header');
        if (!header || !header.closest('#rm_extensions_block')) return;
        requestAnimationFrame(() => refresh());
        scheduleRefresh(340);
    }, true);
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

    if (settings.grouping) {
        // Some extensions (e.g. the MVU variable framework) inject their
        // settings drawer several seconds after boot and look up an existing
        // drawer as an anchor. Grouping empties that container, so wait for
        // those late drawers before the first regroup.
        state.groupingReady = false;
        setTimeout(() => {
            state.groupingReady = true;
            applyGrouping(true);
        }, 4000);
    } else {
        state.groupingReady = true;
    }

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
