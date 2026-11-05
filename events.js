/**
 * Extension Manager — Wiring and boot
 *
 * User input bindings, the observer that watches the settings panel for late-loading
 * extensions, and the entry point.
 */

import { MODULE_NAME, SETTLE_MAX_MS, SETTLE_QUIET_MS, VERSION, saveSettings, settings, state, ui } from './core.js';
import { collapseDrawer, getDrawers, isTopLevelDrawer } from './dom.js';
import { renderGroupEditor } from './group-editor.js';
import { applyGrouping, normalizeGroups, syncGroupsHeader } from './groups.js';
import { buildGroupModal, openGroupModal } from './modal.js';
import { activateDrawer, applyFilter, clearSearch, collapseAll, openSettingsPanel, refresh, renderTabs, updateActiveTabFromScroll, updateTabScrollButtons } from './render.js';
import { applyStickyBackground, normalizeTheme, updateLayout } from './theme.js';
import { appendSettingsDrawer, buildToolbar } from './toolbar.js';

function scheduleRefresh(delay = 120) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refresh, delay);
}

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
            applyGrouping();
        }
    });

    ui.gearMenu?.addEventListener('click', event => {
        const item = event.target.closest('.emm-menu-item');
        if (!item) return;
        const action = item.dataset.action;
        if (action === 'settings') {
            ui.gearMenu.hidden = true;
            openSettingsPanel();
        } else if (action === 'manage-groups') {
            ui.gearMenu.hidden = true;
            openGroupModal();
        }
    });

    ui.groupingToggle?.addEventListener('change', () => {
        state.groupingReady = true;
        settings.grouping = ui.groupingToggle.checked;
        saveSettings();
        if (settings.grouping) normalizeGroups();
        syncGroupsHeader();
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

function groupWhenSettled() {
    const roots = ['#extensions_settings', '#extensions_settings2']
        .map(selector => document.querySelector(selector))
        .filter(Boolean);
    state.groupingReady = false;
    if (!roots.length) {
        state.groupingReady = true;
        applyGrouping(true);
        return;
    }

    let quietTimer = 0;
    let deadline = 0;
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(quietTimer);
        clearTimeout(deadline);
        watcher.disconnect();
        state.groupingReady = true;
        applyGrouping(true);
    };
    const watcher = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, SETTLE_QUIET_MS);
    });
    for (const root of roots) watcher.observe(root, { childList: true });
    quietTimer = setTimeout(finish, SETTLE_QUIET_MS);
    deadline = setTimeout(finish, SETTLE_MAX_MS);
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

function init() {
    if (document.getElementById('emm-sticky')) return true;
    if (!buildToolbar()) return false;
    appendSettingsDrawer();
    buildGroupModal();
    bindUi();
    updateLayout();
    refresh();

    if (settings.grouping) groupWhenSettled();
    else state.groupingReady = true;

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

export {
    bindUi,
    boot,
    cancelScheduledFilter,
    filterFrame,
    groupWhenSettled,
    init,
    observeSettings,
    onScroll,
    scheduleFilter,
    scheduleRefresh,
};
