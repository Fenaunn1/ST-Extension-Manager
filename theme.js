/**
 * Extension Manager — Theme and layout
 *
 * Theme resolution and the layout measurements the sticky toolbar needs in order to stay
 * aligned with the SillyTavern drawer it floats over.
 */

import { applyBuiltinVisibility } from './builtins.js';
import { settings, state, ui } from './core.js';
import { clampLabelMax } from './dom.js';
import { applyGrouping } from './groups.js';

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

    if (ui.sticky) ui.sticky.classList.toggle('emm-bar-full', !!settings.barFullBleed);

    applyThemeMode();
    applyBuiltinVisibility();

    for (const [id, key] of [
        ['emm-opt-compact', 'compactActions'],
        ['emm-opt-search', 'showSearch'],
        ['emm-opt-hidebuiltins', 'hideBuiltins'],
        ['emm-opt-bleed', 'barFullBleed'],
    ]) {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
        if (input) input.checked = !!settings[key];
    }

    const labelClip = /** @type {HTMLInputElement} */ (document.getElementById('emm-opt-labelclip'));
    if (labelClip) labelClip.checked = settings.tabLabelClip !== false;
    const labelMax = /** @type {HTMLInputElement} */ (document.getElementById('emm-opt-labelmax'));
    if (labelMax) {
        labelMax.value = String(clampLabelMax(settings.tabLabelMax));
        labelMax.disabled = settings.tabLabelClip === false;
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

export {
    applyStickyBackground,
    applyThemeMode,
    normalizeTheme,
    tintToRgba,
    updateLayout,
};
