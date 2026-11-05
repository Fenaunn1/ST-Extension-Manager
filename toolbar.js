/**
 * Extension Manager — Toolbar and settings
 *
 * The sticky toolbar above the extension drawers, and the extension's own settings
 * drawer that is injected next to the built-in settings blocks.
 */

import { OPTION_INPUTS, VERSION, saveSettings, settings, ui } from './core.js';
import { clampLabelMax } from './dom.js';
import { normalizeGroups } from './groups.js';
import { refresh, renderTabs } from './render.js';
import { normalizeTheme, updateLayout } from './theme.js';

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
                    <button type="button" class="emm-menu-item" data-action="manage-groups">
                        <i class="fa-solid fa-pen-to-square"></i><span>管理分组</span>
                    </button>
                    <label class="emm-menu-item emm-menu-toggle" for="emm-grouping-toggle">
                        <i class="fa-solid fa-layer-group"></i><span>启用分组</span>
                        <input id="emm-grouping-toggle" type="checkbox" class="emm-toggle-input">
                    </label>
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
            <label class="checkbox_label" for="emm-opt-bleed" title="让顶栏背景铺满抽屉左右两侧">
                <input id="emm-opt-bleed" type="checkbox">
                <i class="fa-solid fa-arrows-left-right emm-opt-icon" aria-hidden="true"></i>
                <span>顶栏铺满两侧</span>
            </label>
            <p class="emm-opt-desc">开启后顶栏背景一直延伸到抽屉左右边缘；关闭则留出两侧间距。</p>
            <label class="checkbox_label" for="emm-opt-hidebuiltins">
                <input id="emm-opt-hidebuiltins" type="checkbox">
                <i class="fa-solid fa-eye-slash emm-opt-icon" aria-hidden="true"></i>
                <span>隐藏内置区块</span>
            </label>
            <p class="emm-opt-desc">隐藏「下载扩展和资源菜单」与「(已弃用) 扩展API」区块。</p>
            <div class="checkbox_label emm-opt-row">
                <input id="emm-opt-labelclip" type="checkbox">
                <i class="fa-solid fa-tag emm-opt-icon" aria-hidden="true"></i>
                <label for="emm-opt-labelclip" class="emm-opt-row-label">标签字数上限</label>
                <input id="emm-opt-labelmax" class="text_pole emm-number" type="number"
                       min="2" max="10" step="1" inputmode="numeric" aria-label="标签字数上限">
            </div>
            <p class="emm-opt-desc">标签名超过上限时用 … 省略，悬停标签可查看完整名称；取消勾选则显示完整名称。</p>
            <div class="emm-hint">版本 ${VERSION}</div>
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

    for (const [id, key] of OPTION_INPUTS) {
        const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
        input.checked = !!settings[key];
        input.addEventListener('change', () => {
            settings[key] = input.checked;
            saveSettings();
            updateLayout();
            refresh();
        });
    }

    const labelClip = /** @type {HTMLInputElement} */ (document.getElementById('emm-opt-labelclip'));
    const labelMax = /** @type {HTMLInputElement} */ (document.getElementById('emm-opt-labelmax'));
    if (labelClip) {
        labelClip.checked = settings.tabLabelClip !== false;
        labelClip.addEventListener('change', () => {
            settings.tabLabelClip = labelClip.checked;
            if (labelMax) labelMax.disabled = !labelClip.checked;
            saveSettings();
            renderTabs(true);
        });
    }
    if (labelMax) {
        labelMax.value = String(clampLabelMax(settings.tabLabelMax));
        labelMax.disabled = settings.tabLabelClip === false;
        labelMax.addEventListener('change', () => {
            settings.tabLabelMax = clampLabelMax(labelMax.value);
            labelMax.value = String(settings.tabLabelMax);
            saveSettings();
            renderTabs(true);
        });
    }

    normalizeGroups();
}

export {
    appendSettingsDrawer,
    buildToolbar,
};
