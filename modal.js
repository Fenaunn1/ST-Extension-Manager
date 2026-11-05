/**
 * Extension Manager — Modals and toasts
 *
 * Modal layer plumbing (open, close, focus trap, Escape handling), toasts, and the
 * confirmation dialog every destructive action goes through.
 */

import { MODAL_CLOSE_MS, normalize, state } from './core.js';
import { addGroup, clearAddGroupError, clearEditNameError, closeGroupEditModal, exportGroupsConfig, importGroupsConfig, openGroupEditor, renderGroupEditor, renderGroupPicker, requestCloseGroupEditor, saveGroupEditor, showAddGroupError } from './group-editor.js';
import { groupNameExists, normalizeGroups } from './groups.js';

function syncModalLock() {
    const groups = document.getElementById('emm-group-modal');
    const edit = document.getElementById('emm-group-edit');
    const open = (groups && !groups.hidden) || (edit && !edit.hidden);
    document.body.classList.toggle('emm-modal-open', !!open);
}

/**
 * Animate modal layers out before applying [hidden] so closing feels
 * deliberate. Reopening cancels a pending close.
 */
function openModalLayer(layer) {
    if (!layer) return;
    if (layer.__emmCloseTimer) {
        clearTimeout(layer.__emmCloseTimer);
        layer.__emmCloseTimer = 0;
    }
    layer.__emmCloseCallbacks = [];
    layer.classList.remove('emm-closing');
    layer.hidden = false;
    // Remember what had focus so closing returns the user where they were.
    const active = document.activeElement;
    if (active instanceof HTMLElement && !layer.contains(active)) state.focusStack.push(active);
}

function closeModalLayer(layer, done) {
    if (!layer) {
        done?.();
        return;
    }
    if (layer.__emmCloseTimer) {
        if (done) layer.__emmCloseCallbacks.push(done);
        return;
    }
    if (layer.hidden) {
        done?.();
        return;
    }

    layer.__emmCloseCallbacks = done ? [done] : [];
    layer.classList.add('emm-closing');
    layer.__emmCloseTimer = setTimeout(() => {
        layer.__emmCloseTimer = 0;
        layer.hidden = true;
        layer.classList.remove('emm-closing');
        const callbacks = layer.__emmCloseCallbacks ?? [];
        layer.__emmCloseCallbacks = [];
        for (const callback of callbacks) callback();
        restoreModalFocus();
    }, MODAL_CLOSE_MS);
}

/** Focus the element that had it before the top-most layer opened. */
function restoreModalFocus() {
    while (state.focusStack.length) {
        const node = state.focusStack.pop();
        if (node?.isConnected) {
            node.focus?.();
            return;
        }
    }
}

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Visible, tabbable descendants of the open layer, in DOM order. */
function focusableIn(layer) {
    if (!layer) return [];
    return [...layer.querySelectorAll(FOCUSABLE)].filter(node => {
        if (node.closest('[hidden]')) return false;
        return node.getClientRects().length > 0;
    });
}

/** Top-most open modal layer, or null. */
function topModalLayer() {
    const layers = ['#emm-confirm', '#emm-group-edit', '#emm-group-modal']
        .map(selector => document.querySelector(selector))
        .filter(layer => layer && !layer.hidden);
    return layers[0] ?? null;
}

/** Keep Tab and Shift+Tab inside the open dialog. */
function trapModalFocus(event) {
    if (event.key !== 'Tab') return;
    const layer = topModalLayer();
    if (!layer) return;
    const items = focusableIn(layer);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!layer.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
    }
    if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return;
    }
    if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
    }
}

/**
 * SillyTavern closes the extensions drawer on a mousedown outside the drawer.
 * Modal layers live on <body>, so without this every click inside a dialog
 * would count as "outside" and collapse the drawer behind it.
 */
function shieldDrawerEvents(element) {
    if (!element) return;
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
        element.addEventListener(type, event => event.stopPropagation());
    }
}

function buildGroupModal() {
    if (!document.getElementById('emm-group-modal')) {
        const modal = document.createElement('div');
        modal.id = 'emm-group-modal';
        modal.className = 'emm-modal';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="emm-modal-backdrop" data-action="close"></div>
            <div class="emm-modal-card emm-groups-card" role="dialog" aria-modal="true" aria-label="管理分组">
                <div class="emm-modal-head">
                    <b class="emm-head-title">
                        <i class="fa-solid fa-pen-to-square emm-head-icon" aria-hidden="true"></i>
                        <span>管理分组</span>
                    </b>
                    <button type="button" class="emm-icon-btn emm-modal-close" data-action="close" title="关闭" aria-label="关闭">
                        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </div>
                <div class="emm-modal-body">
                    <div class="emm-add-group">
                        <input id="emm-new-group" class="text_pole" type="text" maxlength="16"
                               placeholder="新分组名称" aria-label="新分组名称">
                        <button id="emm-add-group-btn" type="button" class="menu_button">添加</button>
                    </div>
                    <div id="emm-add-group-error" class="emm-form-error" role="alert" hidden></div>
                    <div id="emm-group-rows"></div>
                </div>
                <div class="emm-modal-foot emm-groups-foot">
                    <button type="button" class="menu_button" data-action="import-groups" title="从 JSON 文件导入分组配置">
                        <i class="fa-solid fa-file-import" aria-hidden="true"></i><span>导入</span>
                    </button>
                    <button type="button" class="menu_button" data-action="export-groups" title="将分组配置导出为 JSON 文件">
                        <i class="fa-solid fa-file-export" aria-hidden="true"></i><span>导出</span>
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        shieldDrawerEvents(modal);
        modal.addEventListener('click', event => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'close') closeGroupModal();
            else if (action === 'export-groups') exportGroupsConfig();
            else if (action === 'import-groups') importGroupsConfig();
        });

        const newGroup = /** @type {HTMLInputElement} */ (document.getElementById('emm-new-group'));
        const addButton = /** @type {HTMLButtonElement} */ (document.getElementById('emm-add-group-btn'));
        const syncAdd = () => {
            const ready = !!normalize(newGroup?.value ?? '');
            if (addButton) {
                addButton.disabled = !ready;
                addButton.classList.toggle('emm-disabled', !ready);
            }
        };
        const commitGroup = () => {
            const name = normalize(newGroup?.value ?? '');
            if (!name) {
                newGroup?.focus();
                return;
            }
            if (groupNameExists(name)) {
                showAddGroupError(`已存在同名分组「${name}」`);
                return;
            }
            const group = addGroup(name);
            if (!group) {
                showAddGroupError(`已存在同名分组「${name}」`);
                return;
            }
            newGroup.value = '';
            clearAddGroupError();
            syncAdd();
            openGroupEditor(group.id);
        };
        addButton?.addEventListener('click', commitGroup);
        newGroup?.addEventListener('input', () => {
            syncAdd();
            clearAddGroupError();
        });
        newGroup?.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commitGroup();
            }
        });
        syncAdd();
    }

    buildGroupEditModal();
    buildConfirmDialog();

    if (!state.modalKeysBound) {
        state.modalKeysBound = true;
        document.addEventListener('keydown', event => {
            if (event.key === 'Tab') {
                trapModalFocus(event);
                return;
            }
            if (event.key !== 'Escape') return;
            if (state.confirm) {
                event.preventDefault();
                event.stopPropagation();
                finishConfirm(false);
                return;
            }
            const edit = document.getElementById('emm-group-edit');
            if (edit && !edit.hidden) {
                event.preventDefault();
                event.stopPropagation();
                requestCloseGroupEditor();
                return;
            }
            const modal = document.getElementById('emm-group-modal');
            if (modal && !modal.hidden) {
                event.preventDefault();
                event.stopPropagation();
                closeGroupModal();
            }
        }, true);
    }
}

function buildGroupEditModal() {
    if (document.getElementById('emm-group-edit')) return;
    const modal = document.createElement('div');
    modal.id = 'emm-group-edit';
    modal.className = 'emm-modal emm-modal-stacked';
    modal.hidden = true;
    modal.innerHTML = `
        <div class="emm-modal-backdrop" data-action="close-edit"></div>
        <div class="emm-modal-card emm-edit-card" role="dialog" aria-modal="true" aria-labelledby="emm-edit-heading">
            <div class="emm-modal-head">
                <b class="emm-head-title" id="emm-edit-heading">
                    <i class="fa-solid fa-object-group emm-head-icon" aria-hidden="true"></i>
                    <span>编辑分组</span>
                </b>
                <button type="button" class="emm-icon-btn emm-modal-close" data-action="close-edit" title="关闭" aria-label="关闭">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
            </div>
            <div class="emm-modal-body">
                <label class="emm-field" for="emm-edit-name">
                    <span class="emm-field-label">分组名称</span>
                    <input id="emm-edit-name" class="text_pole" type="text" maxlength="16"
                           placeholder="分组名称" autocomplete="off">
                    <span id="emm-edit-name-error" class="emm-form-error" role="alert" hidden></span>
                </label>
                <div class="emm-bound">
                    <div class="emm-bound-head">
                        <span class="emm-field-label">本组插件</span>
                        <span class="emm-pill" data-count="bound">0</span>
                        <span class="emm-bound-hint">按住行上下拖动排序，此顺序即抽屉里的显示顺序</span>
                    </div>
                    <div id="emm-bound-list" class="emm-bound-list" role="list"
                         aria-label="本组插件，按显示顺序排列"></div>
                </div>
                <div class="emm-picker">
                    <div class="emm-picker-head">
                        <span class="emm-field-label">添加插件</span>
                        <span class="emm-picker-hint">点 + 绑定到本分组；列表行尾的 × 可移出</span>
                    </div>
                    <div class="emm-picker-tabs" role="tablist" aria-label="插件来源">
                        <button type="button" class="emm-picker-tab is-active" data-tab="ungrouped" role="tab"
                                aria-selected="true" tabindex="0" aria-controls="emm-picker-list">
                            未分组<span class="emm-pill" data-count="ungrouped">0</span>
                        </button>
                        <button type="button" class="emm-picker-tab" data-tab="other" role="tab"
                                aria-selected="false" tabindex="-1" aria-controls="emm-picker-list">
                            其他分组<span class="emm-pill" data-count="other">0</span>
                        </button>
                    </div>
                    <div id="emm-picker-list" class="emm-picker-list" role="tabpanel"
                         aria-label="扩展插件列表"></div>
                </div>
            </div>
            <div class="emm-modal-foot">
                <button type="button" class="menu_button" data-action="close-edit">
                    <i class="fa-solid fa-xmark" aria-hidden="true"></i><span>取消</span>
                </button>
                <button type="button" class="menu_button emm-btn-primary" id="emm-edit-save">
                    <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i><span>保存</span>
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    shieldDrawerEvents(modal);
    modal.addEventListener('click', event => {
        if (event.target.closest('[data-action="close-edit"]')) requestCloseGroupEditor();
    });
    const tabs = [...modal.querySelectorAll('.emm-picker-tab')];
    const selectTab = (tab, focus = false) => {
        if (!state.edit || !tab) return;
        state.edit.tab = tab.dataset.tab === 'other' ? 'other' : 'ungrouped';
        // Roving tabindex: only the selected tab is in the tab order.
        for (const item of tabs) {
            const active = item === tab;
            item.setAttribute('aria-selected', String(active));
            item.setAttribute('tabindex', active ? '0' : '-1');
        }
        if (focus) tab.focus();
        renderGroupPicker();
    };
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => selectTab(tab));
        tab.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const step = event.key === 'ArrowRight' ? 1 : -1;
            const next = tabs[(index + step + tabs.length) % tabs.length];
            selectTab(next, true);
        });
    });
    document.getElementById('emm-edit-save')?.addEventListener('click', saveGroupEditor);
    const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('emm-edit-name'));
    nameInput?.addEventListener('input', clearEditNameError);
    nameInput?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveGroupEditor();
        }
    });
}

/**
 * Non-interactive toast: confirms a save without stealing focus or asking
 * for a click. Reused so repeated saves restart the same bubble.
 */
function showToast(message, options = {}) {
    let layer = document.getElementById('emm-toast');
    if (!layer) {
        layer = document.createElement('div');
        layer.id = 'emm-toast';
        layer.className = 'emm-toast';
        layer.setAttribute('role', 'status');
        layer.setAttribute('aria-live', 'polite');
        layer.innerHTML = '<div class="emm-toast-bubble"><i class="fa-solid fa-circle-check emm-toast-icon" aria-hidden="true"></i><span class="emm-toast-text"></span></div>';
        document.body.appendChild(layer);
        shieldDrawerEvents(layer);
    }
    const text = layer.querySelector('.emm-toast-text');
    if (text) text.textContent = message;

    // The action button is built on demand so a plain toast keeps its markup.
    let action = layer.querySelector('.emm-toast-action');
    if (!action) {
        action = document.createElement('button');
        action.type = 'button';
        action.className = 'emm-toast-action';
        layer.querySelector('.emm-toast-bubble')?.append(action);
    }
    const label = normalize(options.actionLabel);
    const handler = typeof options.actionHandler === 'function' ? options.actionHandler : null;
    const run = label && typeof handler === 'function' ? handler : null;
    state.toastAction = run;
    action.hidden = !run;
    action.textContent = label;
    action.addEventListener('click', () => {
        const pending = state.toastAction;
        state.toastAction = null;
        hideToast();
        pending?.();
    });

    if (layer.__emmToastTimer) clearTimeout(layer.__emmToastTimer);
    layer.classList.remove('is-hiding');
    layer.hidden = false;
    // Force a reflow so a restart replays the entrance animation.
    void layer.offsetWidth;
    layer.classList.add('is-visible');
    // A toast carrying an action stays long enough to be clicked.
    layer.__emmToastTimer = setTimeout(hideToast, run ? 6000 : 1800);
}

function hideToast() {
    const layer = document.getElementById('emm-toast');
    if (!layer) return;
    if (layer.__emmToastTimer) clearTimeout(layer.__emmToastTimer);
    layer.__emmToastTimer = 0;
    layer.classList.add('is-hiding');
    layer.classList.remove('is-visible');
    setTimeout(() => {
        const current = document.getElementById('emm-toast');
        if (!current || current.classList.contains('is-visible')) return;
        current.hidden = true;
        current.classList.remove('is-hiding');
    }, 200);
}

function buildConfirmDialog() {
    if (document.getElementById('emm-confirm')) return;
    const layer = document.createElement('div');
    layer.id = 'emm-confirm';
    layer.className = 'emm-confirm';
    layer.hidden = true;
    layer.innerHTML = `
        <div class="emm-confirm-backdrop" data-action="cancel"></div>
        <div class="emm-confirm-card" role="alertdialog" aria-modal="true"
             aria-labelledby="emm-confirm-title" aria-describedby="emm-confirm-text">
            <div id="emm-confirm-title" class="emm-confirm-title"></div>
            <div id="emm-confirm-text" class="emm-confirm-text"></div>
            <div class="emm-confirm-actions">
                <button type="button" class="menu_button" data-action="cancel">取消</button>
                <button type="button" class="menu_button emm-btn-danger" data-action="ok">删除</button>
            </div>
        </div>
    `;
    document.body.appendChild(layer);
    shieldDrawerEvents(layer);
    layer.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'cancel') finishConfirm(false);
        else if (action === 'ok') finishConfirm(true);
    });
}

function askConfirm({ title, message, confirmText = '确定', danger = false, primary = false }) {
    buildConfirmDialog();
    const layer = document.getElementById('emm-confirm');
    if (!layer) return Promise.resolve(false);

    return new Promise(resolve => {
        if (state.confirm) finishConfirm(false);
        state.confirm = { resolve };
        const titleNode = document.getElementById('emm-confirm-title');
        const textNode = document.getElementById('emm-confirm-text');
        if (titleNode) titleNode.textContent = title;
        if (textNode) textNode.textContent = message;
        const ok = layer.querySelector('[data-action="ok"]');
        if (ok) {
            ok.textContent = confirmText;
            ok.classList.toggle('emm-btn-danger', danger);
            ok.classList.toggle('emm-btn-primary', primary && !danger);
        }
        layer.hidden = false;
        setTimeout(() => layer.querySelector('[data-action="cancel"]')?.focus(), 0);
    });
}

function finishConfirm(value) {
    const pending = state.confirm;
    state.confirm = null;
    const layer = document.getElementById('emm-confirm');
    if (layer) layer.hidden = true;
    pending?.resolve?.(value);
}

function openGroupModal() {
    const modal = document.getElementById('emm-group-modal');
    if (!modal) return;
    normalizeGroups();
    state.expandedGroups.clear();
    clearAddGroupError();
    renderGroupEditor(true);
    openModalLayer(modal);
    syncModalLock();
    setTimeout(() => document.getElementById('emm-new-group')?.focus(), 60);
}

function closeGroupModal() {
    finishConfirm(false);
    closeGroupEditModal();
    const modal = document.getElementById('emm-group-modal');
    closeModalLayer(modal, syncModalLock);
}

export {
    FOCUSABLE,
    askConfirm,
    buildConfirmDialog,
    buildGroupEditModal,
    buildGroupModal,
    closeGroupModal,
    closeModalLayer,
    finishConfirm,
    focusableIn,
    hideToast,
    openGroupModal,
    openModalLayer,
    restoreModalFocus,
    shieldDrawerEvents,
    showToast,
    syncModalLock,
    topModalLayer,
    trapModalFocus,
};
