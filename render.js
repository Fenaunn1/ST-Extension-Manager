/**
 * Extension Manager — Filtering and tabs
 *
 * Search filtering, the open-extension tab strip, and the scroll synchronisation that
 * keeps the active tab in view.
 */

import { UNGROUPED_ID, saveSettings, settings, state, ui } from './core.js';
import { collapseDrawer, getDrawers, getHeader, getOpenDrawers, getSearchText, getTitle, isDrawerOpen, openDrawer, tabLabel } from './dom.js';
import { cancelScheduledFilter } from './events.js';
import { applyGrouping, updateGroupVisibility } from './groups.js';

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

function openSettingsPanel() {
    const drawer = document.getElementById('emm-settings-drawer');
    if (!drawer) return;
    if (state.filter) clearSearch();
    expandGroupFor(drawer);
    if (!isDrawerOpen(drawer)) getHeader(drawer)?.click();
    setTimeout(() => scrollToDrawer(drawer), 80);
}

function clearSearch() {
    state.filter = '';
    if (ui.search) ui.search.value = '';
    cancelScheduledFilter();
    applyFilter();
    ui.search?.focus();
}

export {
    activateDrawer,
    applyFilter,
    clearSearch,
    collapseAll,
    expandGroupFor,
    openSettingsPanel,
    refresh,
    renderTabs,
    scrollToDrawer,
    syncActiveTab,
    updateActiveTabFromScroll,
    updateTabScrollButtons,
};
