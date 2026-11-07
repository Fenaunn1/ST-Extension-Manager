/**
 * Extension Manager — Group state
 *
 * Normalisation and one-time migration of member keys, the grouped rendering pass, and
 * the collapsed/enabled bookkeeping shared by the toolbar and the management dialog.
 */

import { ensureGroupHost, isBuiltinHidden } from './builtins.js';
import { UNGROUPED_ID, normalize, saveSettings, settings, state } from './core.js';
import { drawerKey, getDrawers, getTitle, setNativeRootsHidden, titleKeyMap } from './dom.js';
import { renderGroupEditor } from './group-editor.js';

const KEY_PREFIX = /^(id|i18n|title):/;

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

    // Groups used to store drawer titles. Convert those to stable keys once;
    // a title that no drawer matches right now becomes a title key so it still
    // resolves if that extension loads later.
    const byTitle = titleKeyMap();
    for (const group of settings.groups) {
        group.members = group.members.map(member => {
            if (KEY_PREFIX.test(member)) return member;
            return byTitle.get(member) ?? `title:${member}`;
        });
    }

    const claimed = new Set();
    for (const group of settings.groups) {
        group.members = group.members.filter(key => {
            if (claimed.has(key)) return false;
            claimed.add(key);
            return true;
        });
    }
}

function findGroupForKey(key) {
    return settings.groups.find(group => group.members.includes(key)) ?? null;
}

function groupNameExists(name, exceptId = null) {
    const target = normalize(name).toLowerCase();
    if (!target) return false;
    return settings.groups.some(group => group.id !== exceptId
        && normalize(group.name).toLowerCase() === target);
}

function groupSignature() {
    const titles = getDrawers().map(drawer => drawerKey(drawer)).join('\u0001');
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
        <span class="emm-group-caret" aria-hidden="true">
            <i class="fa-solid fa-chevron-down emm-caret-down"></i>
            <i class="fa-solid fa-chevron-right emm-caret-right"></i>
        </span>
        <span class="emm-group-name"></span>
        <span class="emm-group-count"></span>
        <span class="emm-group-spacer"></span>
    `;
    head.querySelector('.emm-group-name').textContent = group.name;
    head.setAttribute('aria-expanded', String(!group.collapsed));
    head.addEventListener('click', () => {
        const collapsed = section.classList.toggle('emm-collapsed');
        head.setAttribute('aria-expanded', String(!collapsed));
        if (group.id === UNGROUPED_ID) {
            settings.ungroupedCollapsed = collapsed;
        } else {
            group.collapsed = collapsed;
        }
        saveSettings();
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
    // A unit can carry more than one drawer, so the badge counts drawers rather
    // than the units that will be moved.
    head.querySelector('.emm-group-count').textContent =
        String(body.querySelectorAll('.inline-drawer').length);

    if (group.collapsed) section.classList.add('emm-collapsed');
    section.append(head, body);
    return section;
}

/**
 * Decorative title row above the grouped list: a bold "分组列表" label on the
 * left and one-click expand / collapse controls on the right.
 */
function buildGroupsHeader() {
    const head = document.createElement('div');
    head.className = 'emm-groups-head';
    head.id = 'emm-groups-head';

    const title = document.createElement('span');
    title.className = 'emm-groups-title';
    const titleIcon = document.createElement('i');
    titleIcon.className = 'fa-solid fa-layer-group emm-groups-title-icon';
    titleIcon.setAttribute('aria-hidden', 'true');
    const titleText = document.createElement('span');
    titleText.textContent = '分组列表';
    title.append(titleIcon, titleText);

    const actions = document.createElement('div');
    actions.className = 'emm-groups-actions';

    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'emm-icon-btn emm-groups-btn';
    expand.title = '一键展开全部分组';
    expand.setAttribute('aria-label', '一键展开全部分组');
    expand.innerHTML = '<i class="fa-solid fa-angles-down" aria-hidden="true"></i>';
    expand.addEventListener('click', () => setAllGroupsCollapsed(false));

    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'emm-icon-btn emm-groups-btn';
    collapse.title = '一键折叠全部分组';
    collapse.setAttribute('aria-label', '一键折叠全部分组');
    collapse.innerHTML = '<i class="fa-solid fa-angles-up" aria-hidden="true"></i>';
    collapse.addEventListener('click', () => setAllGroupsCollapsed(true));

    actions.append(expand, collapse);
    head.append(title, actions);
    return head;
}

/**
 * Keeps the "分组列表" title row docked directly under the tab strip inside the
 * sticky bar, so it stays visible while the list scrolls. The row lives outside
 * the scrolling list; its height is fixed so tabs (and their scrollbar) can
 * never squeeze it.
 */
function syncGroupsHeader() {
    const sticky = document.getElementById('emm-sticky');
    if (!sticky) return;
    let head = document.getElementById('emm-groups-head');
    if (!head) {
        head = buildGroupsHeader();
        head.id = 'emm-groups-head';
    }
    // The tab strip may sit directly in the sticky bar or one level deep inside
    // #emm-toolbar; dock right below whichever element actually holds it.
    const tabsRow = document.getElementById('emm-tabs-row');
    let anchor = null;
    if (tabsRow) {
        if (tabsRow.parentElement === sticky) anchor = tabsRow;
        else if (tabsRow.parentElement?.parentElement === sticky) anchor = tabsRow.parentElement;
    }
    if (anchor) {
        if (head.previousElementSibling !== anchor) anchor.after(head);
    } else if (head.parentElement !== sticky) {
        sticky.append(head);
    }
    head.hidden = !settings.grouping;
}

function setAllGroupsCollapsed(collapsed) {
    const wrap = document.getElementById('emm-groups');
    if (!wrap) return;
    for (const group of settings.groups) group.collapsed = collapsed;
    settings.ungroupedCollapsed = collapsed;
    saveSettings();
    for (const section of wrap.querySelectorAll('.emm-group')) {
        section.classList.toggle('emm-collapsed', collapsed);
        section.querySelector('.emm-group-head')?.setAttribute('aria-expanded', String(!collapsed));
    }
}

/**
 * The element that must travel with a drawer. SillyTavern wraps most extension
 * drawers in a container that carries the selectors their own stylesheets rely
 * on (the regex panel hides its bulk-edit checkbox through
 * `.regex_settings .regex_bulk_checkbox`). Moving the bare drawer out of that
 * wrapper makes those rules miss, so the whole unit moves together.
 */
function drawerUnit(drawer) {
    let node = drawer;
    let parent = node.parentElement;
    while (parent && parent !== document.body) {
        if (parent.id === 'extensions_settings' || parent.id === 'extensions_settings2'
            || parent.id === 'emm-groups') {
            return node;
        }
        node = parent;
        parent = node.parentElement;
    }
    return drawer;
}

/** Unit that already owns a drawer, according to the recorded origins. */
function trackedUnit(drawer) {
    for (const unit of state.origin.keys()) {
        if (unit === drawer || unit.contains(drawer)) return unit;
    }
    return null;
}

/** Top-most element a stray drawer occupies inside the grouped list. */
function placementUnit(drawer, wrap) {
    let node = drawer;
    while (node.parentElement && node.parentElement !== wrap
        && !node.parentElement.matches('.emm-group-col, .emm-group-body, #emm-groups-hidden, #emm-groups-orphans')) {
        node = node.parentElement;
    }
    if (node === wrap || !wrap.contains(node)) return null;
    return node;
}

function renderGrouped() {
    const wrap = ensureGroupHost();
    if (!wrap) return;

    const all = getDrawers();
    const keys = new Map(all.map(drawer => [drawer, drawerKey(drawer)]));
    if (!state.baseOrder) state.baseOrder = new Map();
    let seq = state.baseOrder.size;
    const units = new Map();
    for (const drawer of all) {
        if (!state.baseOrder.has(drawer)) state.baseOrder.set(drawer, seq++);
        let unit = trackedUnit(drawer);
        if (!unit) {
            unit = drawer.closest('#emm-groups') ? drawer : drawerUnit(drawer);
            // Only record an origin for units still parked in SillyTavern's own
            // container; a unit already inside the grouped list has no home to
            // restore to.
            if (!unit.closest('#emm-groups') && !state.origin.has(unit)) {
                state.origin.set(unit, { parent: unit.parentElement, next: unit.nextElementSibling });
            }
        }
        units.set(drawer, unit);
    }
    all.sort((a, b) => (state.baseOrder.get(a) ?? 0) - (state.baseOrder.get(b) ?? 0));

    // A unit can only live in one place, so the first drawer of a unit decides
    // the group it lands in; later drawers of the same unit follow it.
    const claimed = new Set();
    const collect = drawers => {
        const out = [];
        for (const drawer of drawers) {
            const unit = units.get(drawer);
            if (!unit || claimed.has(unit)) continue;
            claimed.add(unit);
            out.push(unit);
        }
        return out;
    };

    const buckets = new Map(settings.groups.map(group => [group.id, []]));
    const ungrouped = [];
    const hidden = [];
    for (const drawer of all) {
        if (drawer.id === 'emm-settings-drawer') {
            ungrouped.push(drawer);
            continue;
        }
        const group = findGroupForKey(keys.get(drawer));
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
    const seenOrphans = new Set();
    for (const drawer of wrap.querySelectorAll('.inline-drawer')) {
        if (drawer.parentElement?.closest('.inline-drawer')) continue;
        if (known.has(drawer)) continue;
        const unit = placementUnit(drawer, wrap);
        if (!unit || seenOrphans.has(unit)) continue;
        // A stray nested drawer inside a unit we already move needs no rescue.
        if ([...known].some(other => unit.contains(other))) continue;
        seenOrphans.add(unit);
        orphans.push(unit);
    }
    wrap.textContent = '';

    for (const group of settings.groups) {
        const members = buckets.get(group.id);
        if (!members?.length) continue;
        // Membership order is user-defined (drag to reorder) and falls back to
        // the order the drawers appeared in.
        members.sort((a, b) => {
            const rank = member => {
                const index = group.members.indexOf(keys.get(member));
                return index === -1 ? Number.MAX_SAFE_INTEGER : index;
            };
            return rank(a) - rank(b);
        });
        const placed = collect(members);
        if (!placed.length) continue;
        wrap.append(buildGroupSection(group, placed));
    }

    const ungroupedUnits = collect(ungrouped);
    if (ungroupedUnits.length) {
        const section = buildGroupSection(
            { id: UNGROUPED_ID, name: '未分组', collapsed: !!settings.ungroupedCollapsed },
            ungroupedUnits,
        );
        wrap.append(section);
    }

    const hiddenUnits = collect(hidden);
    if (hiddenUnits.length) {
        const stash = document.createElement('div');
        stash.id = 'emm-groups-hidden';
        stash.hidden = true;
        stash.append(...hiddenUnits);
        wrap.append(stash);
    }

    const lost = [...state.origin.keys()].filter(unit => !unit.isConnected && !orphans.includes(unit));
    if (orphans.length || lost.length) {
        for (const unit of [...orphans, ...lost]) {
            if (!state.origin.has(unit)) {
                state.origin.set(unit, { parent: null, next: null });
            }
        }
        const stash = document.createElement('div');
        stash.id = 'emm-groups-orphans';
        stash.hidden = true;
        stash.append(...orphans, ...lost);
        wrap.append(stash);
    }

    updateGroupVisibility();

    if (document.getElementById('emm-group-rows')) renderGroupEditor();
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
    syncGroupsHeader();
}
function applyGrouping(force = false) {
    syncGroupsHeader();
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
        const visible = drawers.filter(drawer => !drawer.classList.contains('emm-filtered')
            && !isBuiltinHidden(drawer));
        section.hidden = visible.length === 0;
        const count = section.querySelector('.emm-group-count');
        if (count) count.textContent = String(visible.length);
    }
}

/** Groupable drawers as { key, title } pairs, one entry per stable key. */
function editablePlugins() {
    const seen = new Set();
    const plugins = [];
    for (const drawer of getDrawers()) {
        if (drawer.id === 'emm-settings-drawer') continue;
        // Built-in sections are not extensions and cannot be grouped.
        if (drawer.dataset.emmBuiltin === 'assets' || drawer.closest('#assets_container')) continue;
        const key = drawerKey(drawer);
        if (seen.has(key)) continue;
        seen.add(key);
        plugins.push({ key, title: getTitle(drawer) });
    }
    return plugins;
}

function editableTitles() {
    return editablePlugins().map(plugin => plugin.title);
}

function groupEditorSignature() {
    return settings.groups
        .map(group => [group.id, group.name, group.enabled ? 1 : 0, group.members.join('\u0001')].join('\u0002'))
        .join('\u0003');
}

export {
    KEY_PREFIX,
    applyGrouping,
    buildGroupSection,
    buildGroupsHeader,
    editablePlugins,
    editableTitles,
    findGroupForKey,
    groupEditorSignature,
    groupNameExists,
    groupSignature,
    normalizeGroups,
    renderGrouped,
    setAllGroupsCollapsed,
    syncGroupsHeader,
    teardownGrouping,
    updateGroupVisibility,
};
