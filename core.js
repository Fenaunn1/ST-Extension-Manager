/**
 * Extension Manager — Settings and state
 *
 * Defaults, the persisted settings object and the shared in-memory state.
 * This module touches no DOM, so every other module can read settings and state without
 * creating an import cycle.
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'extension_manager';
const LEGACY_MODULE_NAME = 'extension_manager_plus';
const VERSION = '1.3.9';
const UNGROUPED_ID = '__ungrouped';
const MODAL_CLOSE_MS = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 0 : 160;

/** Group once the settings panel has been unchanged for this long. */
const SETTLE_QUIET_MS = 800;

/** Upper bound so a chatty extension cannot postpone grouping forever. */
const SETTLE_MAX_MS = 12000;

const DEFAULTS = {
    compactActions: true, // fold Manage/Install into the ⋯ menu
    showSearch: true,
    hideBuiltins: false, // hide the built-in Assets drawer and the deprecated Extras API block
    theme: 'auto', // auto | day | night
    tabLabelMax: 5, // characters shown in a tab before the name is clipped
    tabLabelClip: true, // clip long tab names; off shows the full title
    barFullBleed: false, // paint the sticky bar edge-to-edge across the drawer
    grouping: false, // show custom groups instead of a flat list
    groups: [], // [{ id, name, enabled, collapsed, members: [key] }]
    ungroupedCollapsed: false, // collapse state of the implicit "未分组" section
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
    groupEditorSignature: '',
    expandedGroups: new Set(),
    edit: null,
    confirm: null,
    modalKeysBound: false,
    origin: new Map(),
    groupingReady: false,
    focusStack: [],
    toastAction: null,
};

const ui = {};

function normalize(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function saveSettings() {
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

export {
    DEFAULTS,
    LEGACY_MODULE_NAME,
    MODAL_CLOSE_MS,
    MODULE_NAME,
    SETTLE_MAX_MS,
    SETTLE_QUIET_MS,
    UNGROUPED_ID,
    VERSION,
    normalize,
    saveSettings,
    settings,
    state,
    ui,
};
