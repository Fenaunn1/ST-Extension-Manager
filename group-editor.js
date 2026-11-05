/**
 * Extension Manager — Group management dialogs
 *
 * The group list, binding plugins into a group, drag reordering, clipboard import and
 * export, and delete with undo.
 */

import { VERSION, normalize, saveSettings, settings, state } from './core.js';
import { keyTitle } from './dom.js';
import { applyGrouping, editablePlugins, findGroupForKey, groupEditorSignature, groupNameExists, normalizeGroups } from './groups.js';
import { askConfirm, closeModalLayer, openModalLayer, showToast, syncModalLock } from './modal.js';

/**
 * One compact row per group: expand arrow, name, enable switch, edit, delete.
 * Renaming and membership live in the edit dialog so this list stays quiet.
 */
function buildGroupManagerItem(group) {
    const item = document.createElement('div');
    item.className = 'emm-mg-item';
    item.dataset.groupId = group.id;

    const row = document.createElement('div');
    row.className = 'emm-mg-row';

    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'emm-mg-grip';
    grip.title = '拖动调整分组顺序';
    grip.setAttribute('aria-label', `拖动调整分组 ${group.name} 的顺序`);
    grip.innerHTML = '<i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>';
    grip.draggable = true;

    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'emm-mg-caret';
    caret.title = '展开 / 收起插件列表';
    caret.setAttribute('aria-expanded', 'false');
    caret.innerHTML = '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'emm-mg-name';
    name.textContent = group.name;
    name.title = group.name;

    const switchLabel = document.createElement('label');
    switchLabel.className = 'emm-switch';
    switchLabel.title = group.enabled ? '分组已启用' : '分组已停用';
    switchLabel.innerHTML = `
        <input type="checkbox" class="emm-switch-input">
        <span class="emm-switch-track"><span class="emm-switch-thumb"></span></span>
    `;
    const switchInput = /** @type {HTMLInputElement} */ (switchLabel.querySelector('input'));
    switchInput.checked = group.enabled;
    switchInput.setAttribute('aria-label', `启用分组 ${group.name}`);
    switchInput.addEventListener('change', () => {
        group.enabled = switchInput.checked;
        switchLabel.title = switchInput.checked ? '分组已启用' : '分组已停用';
        item.classList.toggle('is-off', !switchInput.checked);
        saveSettings();
        applyGrouping(true);
    });

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'emm-mg-btn';
    edit.title = '编辑分组';
    edit.setAttribute('aria-label', `编辑分组 ${group.name}`);
    edit.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i>';
    edit.addEventListener('click', () => openGroupEditor(group.id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'emm-mg-btn emm-mg-delete';
    remove.title = '删除分组';
    remove.setAttribute('aria-label', `删除分组 ${group.name}`);
    remove.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i>';
    remove.addEventListener('click', () => requestDeleteGroup(group));

    row.append(grip, caret, name, switchLabel, edit, remove);

    const body = document.createElement('div');
    body.className = 'emm-mg-members';
    if (group.members.length) {
        for (const key of group.members) {
            const title = keyTitle(key);
            const chip = document.createElement('span');
            chip.className = 'emm-chip';
            chip.textContent = title;
            chip.title = title;
            body.append(chip);
        }
    } else {
        const empty = document.createElement('span');
        empty.className = 'emm-mg-empty';
        empty.textContent = '还没有插件，点击编辑图标添加';
        body.append(empty);
    }

    item.append(row, body);
    item.classList.toggle('is-off', !group.enabled);

    const setOpen = open => {
        item.classList.toggle('open', open);
        body.hidden = !open;
        caret.setAttribute('aria-expanded', String(open));
        if (open) state.expandedGroups.add(group.id);
        else state.expandedGroups.delete(group.id);
    };
    setOpen(state.expandedGroups.has(group.id));
    caret.addEventListener('click', () => setOpen(!item.classList.contains('open')));
    name.addEventListener('click', () => setOpen(!item.classList.contains('open')));

    return item;
}

function renderGroupEditor(force = false) {
    const host = document.getElementById('emm-group-rows');
    if (!host) return;
    const signature = groupEditorSignature();
    if (!force && signature === state.groupEditorSignature && host.childElementCount) return;
    state.groupEditorSignature = signature;

    const body = host.closest('.emm-modal-body');
    const scrollTop = body?.scrollTop ?? 0;
    host.textContent = '';
    if (!settings.groups.length) {
        const empty = document.createElement('div');
        empty.className = 'emm-groups-empty';
        empty.textContent = '还没有分组，输入名称添加第一个分组';
        host.append(empty);
    } else {
        for (const group of settings.groups) host.append(buildGroupManagerItem(group));
        bindGroupRowDrag(host);
    }
    if (body) body.scrollTop = scrollTop;
}

/**
 * Reorder the group list by dragging a row's grip. Rows are rebuilt after a
 * drop, so the hook is re-attached on every render.
 */
function bindGroupRowDrag(host) {
    let draggedId = null;
    const clearMarks = () => {
        host.querySelectorAll('.emm-mg-item').forEach(item => {
            item.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
        });
    };

    host.querySelectorAll('.emm-mg-item').forEach(item => {
        const grip = item.querySelector('.emm-mg-grip');
        grip?.addEventListener('dragstart', event => {
            draggedId = item.dataset.groupId;
            item.classList.add('is-dragging');
            event.dataTransfer?.setData('text/plain', draggedId ?? '');
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        grip?.addEventListener('dragend', () => {
            draggedId = null;
            clearMarks();
        });

        item.addEventListener('dragover', event => {
            if (!draggedId || draggedId === item.dataset.groupId) return;
            event.preventDefault();
            const rect = item.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            item.classList.toggle('is-drop-before', !after);
            item.classList.toggle('is-drop-after', after);
        });
        item.addEventListener('dragleave', () => {
            item.classList.remove('is-drop-before', 'is-drop-after');
        });
        item.addEventListener('drop', event => {
            if (!draggedId || draggedId === item.dataset.groupId) return;
            event.preventDefault();
            const rect = item.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            moveGroup(draggedId, item.dataset.groupId, after);
            draggedId = null;
            clearMarks();
        });
    });
}

function moveGroup(sourceId, targetId, after) {
    const sourceIndex = settings.groups.findIndex(group => group.id === sourceId);
    if (sourceIndex === -1) return;
    const [moved] = settings.groups.splice(sourceIndex, 1);
    let targetIndex = settings.groups.findIndex(group => group.id === targetId);
    if (targetIndex === -1) {
        settings.groups.splice(sourceIndex, 0, moved);
        return;
    }
    if (after) targetIndex += 1;
    settings.groups.splice(targetIndex, 0, moved);
    saveSettings();
    renderGroupEditor(true);
    applyGrouping(true);
}

function openGroupEditor(groupId) {
    normalizeGroups();
    const group = settings.groups.find(item => item.id === groupId);
    if (!group) return;

    const assign = new Map();
    for (const { key } of editablePlugins()) {
        assign.set(key, findGroupForKey(key)?.id ?? null);
    }

    state.edit = {
        groupId,
        name: group.name,
        assign,
        baseName: group.name,
        baseAssign: new Map(assign),
        tab: 'ungrouped',
    };
    renderGroupEditModal();

    const modal = document.getElementById('emm-group-edit');
    if (!modal) return;
    openModalLayer(modal);
    syncModalLock();
    setTimeout(() => {
        const input = /** @type {HTMLInputElement} */ (document.getElementById('emm-edit-name'));
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }, 50);
}

function renderGroupEditModal() {
    const edit = state.edit;
    if (!edit) return;
    const group = settings.groups.find(item => item.id === edit.groupId);
    if (!group) {
        closeGroupEditModal();
        return;
    }
    const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('emm-edit-name'));
    if (nameInput) nameInput.value = edit.name;
    clearEditNameError();
    renderGroupPicker();
}

function currentEditGroup() {
    const edit = state.edit;
    if (!edit) return null;
    return settings.groups.find(item => item.id === edit.groupId) ?? null;
}

function renderBoundList(keys, host) {
    host.textContent = '';
    host.classList.toggle('is-empty', !keys.length);
    if (!keys.length) {
        const empty = document.createElement('span');
        empty.className = 'emm-bound-empty';
        empty.textContent = '还没有插件，从下方列表点 + 加入';
        host.append(empty);
        return;
    }

    keys.forEach((key, index) => {
        const title = keyTitle(key);
        const row = document.createElement('div');
        row.className = 'emm-bound-row';
        row.draggable = true;
        row.dataset.key = key;
        row.setAttribute('role', 'listitem');

        const grip = document.createElement('i');
        grip.className = 'fa-solid fa-grip-vertical emm-bound-grip';
        grip.setAttribute('aria-hidden', 'true');

        const order = document.createElement('span');
        order.className = 'emm-bound-index';
        order.textContent = String(index + 1);

        const name = document.createElement('span');
        name.className = 'emm-bound-name';
        name.textContent = title;
        name.title = title;

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'emm-unbind-btn';
        remove.title = '移出本分组';
        remove.setAttribute('aria-label', `将 ${title} 移出本分组`);
        remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        remove.addEventListener('click', () => unbindKeyFromGroup(key));

        row.append(grip, order, name, remove);
        row.tabIndex = 0;
        row.setAttribute('aria-label', `第 ${index + 1} 个，${title}，按 Alt 加上下方向键调整顺序`);
        row.addEventListener('keydown', event => {
            if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
            event.preventDefault();
            moveBoundKeyByStep(key, event.key === 'ArrowUp' ? -1 : 1);
        });
        host.append(row);
    });
    bindChipDrag(host);
}

/**
 * Keyboard counterpart to dragging: shifts one member by one slot and puts the
 * focus back on the moved row so repeated presses keep working.
 */
function moveBoundKeyByStep(key, step) {
    const edit = state.edit;
    const group = currentEditGroup();
    if (!edit || !group) return;
    const bound = [...edit.assign.entries()]
        .filter(([, ownerId]) => ownerId === group.id)
        .map(([boundKey]) => boundKey);
    const from = bound.indexOf(key);
    const to = from + step;
    if (from === -1 || to < 0 || to >= bound.length) return;
    reorderBoundKey(key, bound[to], step > 0);
    document.querySelector(`.emm-bound-row[data-key="${CSS.escape(key)}"]`)?.focus();
}

/** Reorder bound members by dragging a row up or down the list. */
function bindChipDrag(host) {
    let draggedKey = null;
    const clearMarks = () => {
        host.querySelectorAll('.emm-bound-row').forEach(row => {
            row.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
        });
    };

    host.querySelectorAll('.emm-bound-row').forEach(row => {
        row.addEventListener('dragstart', event => {
            draggedKey = row.dataset.key;
            row.classList.add('is-dragging');
            event.dataTransfer?.setData('text/plain', draggedKey ?? '');
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
            draggedKey = null;
            clearMarks();
        });
        row.addEventListener('dragover', event => {
            if (!draggedKey || draggedKey === row.dataset.key) return;
            event.preventDefault();
            const rect = row.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            row.classList.toggle('is-drop-before', !after);
            row.classList.toggle('is-drop-after', after);
        });
        row.addEventListener('dragleave', () => {
            row.classList.remove('is-drop-before', 'is-drop-after');
        });
        row.addEventListener('drop', event => {
            if (!draggedKey || draggedKey === row.dataset.key) return;
            event.preventDefault();
            const rect = row.getBoundingClientRect();
            const after = event.clientY > rect.top + rect.height / 2;
            reorderBoundKey(draggedKey, row.dataset.key, after);
            draggedKey = null;
            clearMarks();
        });
    });
}

/**
 * Members are reordered in the staged map, so the new order only reaches
 * settings on Save. The map keeps insertion order, which saveGroupEditor
 * replays into group.members.
 */
function reorderBoundKey(sourceKey, targetKey, after) {
    const edit = state.edit;
    if (!edit) return;
    const group = currentEditGroup();
    if (!group) return;
    const order = [...edit.assign.entries()];
    const bound = order.filter(([, ownerId]) => ownerId === group.id).map(([key]) => key);
    const from = bound.indexOf(sourceKey);
    if (from === -1) return;
    bound.splice(from, 1);
    let to = bound.indexOf(targetKey);
    if (to === -1) return;
    if (after) to += 1;
    bound.splice(to, 0, sourceKey);

    // Rebuild the map: every non-bound entry keeps its place, bound entries
    // are replayed in their new order behind the same owner.
    const next = new Map();
    let cursor = 0;
    for (const [key, ownerId] of order) {
        if (ownerId === group.id) {
            next.set(bound[cursor++], ownerId);
        } else {
            next.set(key, ownerId);
        }
    }
    edit.assign = next;
    renderGroupPicker();
}

/**
 * Stage membership in state.edit.assign; nothing is written until Save.
 * Bound plugins are chips; the other-groups tab shows each current owner.
 * Every bind/unbind is confirmed and only written into the staged map.
 */
function renderGroupPicker() {
    const edit = state.edit;
    const list = document.getElementById('emm-picker-list');
    const boundList = document.getElementById('emm-bound-list');
    if (!edit || !list || !boundList) return;
    if (edit.tab !== 'ungrouped' && edit.tab !== 'other') edit.tab = 'ungrouped';

    for (const { key } of editablePlugins()) {
        if (edit.assign.has(key)) continue;
        const ownerId = findGroupForKey(key)?.id ?? null;
        edit.assign.set(key, ownerId);
        edit.baseAssign?.set(key, ownerId);
    }

    const bound = [];
    const ungrouped = [];
    const other = [];
    for (const [key, ownerId] of edit.assign) {
        if (ownerId === edit.groupId) bound.push(key);
        else if (ownerId) other.push([key, ownerId]);
        else ungrouped.push(key);
    }

    for (const tab of document.querySelectorAll('#emm-group-edit .emm-picker-tab')) {
        const isActive = tab.dataset.tab === edit.tab;
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
        tab.setAttribute('tabindex', isActive ? '0' : '-1');
    }
    const counts = {
        bound: document.querySelector('#emm-group-edit [data-count="bound"]'),
        ungrouped: document.querySelector('#emm-group-edit [data-count="ungrouped"]'),
        other: document.querySelector('#emm-group-edit [data-count="other"]'),
    };
    if (counts.bound) counts.bound.textContent = String(bound.length);
    if (counts.ungrouped) counts.ungrouped.textContent = String(ungrouped.length);
    if (counts.other) counts.other.textContent = String(other.length);

    renderBoundList(bound, boundList);

    const scrollTop = list.scrollTop;
    list.textContent = '';

    const entries = edit.tab === 'other'
        ? other
        : ungrouped.map(key => [key, null]);

    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'emm-picker-empty';
        empty.textContent = edit.tab === 'other' ? '没有属于其他分组的插件' : '所有插件都已分组';
        list.append(empty);
        list.scrollTop = scrollTop;
        return;
    }

    for (const [key, ownerId] of entries) {
        const title = keyTitle(key);
        const row = document.createElement('div');
        row.className = 'emm-pick';

        const text = document.createElement('span');
        text.className = 'emm-pick-name';
        text.textContent = title;
        text.title = title;
        row.append(text);

        if (edit.tab === 'other' && ownerId) {
            const owner = settings.groups.find(item => item.id === ownerId);
            const badge = document.createElement('span');
            badge.className = 'emm-pick-badge';
            badge.textContent = owner?.name ?? '其他分组';
            badge.title = owner?.name ?? '其他分组';
            row.append(badge);
        }

        const bind = document.createElement('button');
        bind.type = 'button';
        bind.className = 'emm-bind-btn';
        bind.title = '绑定到本分组';
        bind.setAttribute('aria-label', `将 ${title} 绑定到本分组`);
        bind.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
        bind.addEventListener('click', () => bindKeyToGroup(key));
        row.append(bind);

        list.append(row);
    }
    list.scrollTop = scrollTop;
}

/** Staged in state.edit.assign; nothing is written until Save, so no confirm. */
function bindKeyToGroup(key) {
    const edit = state.edit;
    const group = currentEditGroup();
    if (!edit || !group) return;

    edit.assign.set(key, group.id);
    renderGroupPicker();
}

async function unbindKeyFromGroup(key) {
    const edit = state.edit;
    const group = currentEditGroup();
    if (!edit || !group) return;

    const title = keyTitle(key);
    const ok = await askConfirm({
        title: '移出插件',
        message: `将「${title}」从「${group.name}」移出？移出后回到未分组。`,
        confirmText: '移出',
        danger: true,
    });
    if (!ok || state.edit !== edit || !settings.groups.includes(group)) return;

    edit.assign.set(key, null);
    renderGroupPicker();
}

function saveGroupEditor() {
    const edit = state.edit;
    if (!edit) return;
    const group = settings.groups.find(item => item.id === edit.groupId);
    if (!group) {
        closeGroupEditModal();
        return;
    }

    const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('emm-edit-name'));
    const rawName = normalize(nameInput?.value);
    const nextName = rawName || group.name;
    if (rawName && rawName !== group.name && groupNameExists(nextName, group.id)) {
        showEditNameError(`已存在同名分组「${nextName}」`);
        return;
    }
    group.name = nextName;
    clearEditNameError();

    // Rebuild tracked memberships; keep members whose drawers are not loaded
    // right now instead of silently dropping them.
    const tracked = new Set(edit.assign.keys());
    for (const item of settings.groups) {
        item.members = item.members.filter(key => !tracked.has(key));
    }
    for (const [key, ownerId] of edit.assign) {
        if (!ownerId) continue;
        const owner = settings.groups.find(item => item.id === ownerId);
        if (owner && !owner.members.includes(key)) owner.members.push(key);
    }

    normalizeGroups();
    saveSettings();
    renderGroupEditor(true);
    applyGrouping(true);
    closeGroupEditModal();
    showToast(`已保存分组「${group.name}」`);
}

/** True when the staged name or membership differs from what was opened. */
function isGroupEditDirty() {
    const edit = state.edit;
    if (!edit) return false;
    const group = settings.groups.find(item => item.id === edit.groupId);
    if (!group) return false;

    const currentName = normalize(document.getElementById('emm-edit-name')?.value) || edit.baseName;
    if (currentName !== edit.baseName) return true;

    const base = edit.baseAssign;
    if (!base || base.size !== edit.assign.size) return true;
    // Compare as ordered pairs: reordering bound members alone is a change.
    const next = [...edit.assign.entries()];
    const prev = [...base.entries()];
    for (let i = 0; i < next.length; i += 1) {
        if (next[i][0] !== prev[i][0]) return true;
        if (next[i][1] !== prev[i][1]) return true;
    }
    return false;
}

/**
 * Closing the editor with unsaved edits asks first; without edits it just
 * closes, so the exit path never nags.
 */
async function requestCloseGroupEditor() {
    const modal = document.getElementById('emm-group-edit');
    if (!modal || modal.hidden) return;
    if (!isGroupEditDirty()) {
        closeGroupEditModal();
        return;
    }
    const ok = await askConfirm({
        title: '放弃修改',
        message: '分组有未保存的修改，确定退出并放弃吗？',
        confirmText: '放弃修改',
        danger: true,
    });
    if (!ok) return;
    closeGroupEditModal();
}

function closeGroupEditModal() {
    const modal = document.getElementById('emm-group-edit');
    state.edit = null;
    closeModalLayer(modal, syncModalLock);
}

async function requestDeleteGroup(group) {
    const count = group.members.length;
    const ok = await askConfirm({
        title: '删除分组',
        message: count > 0
            ? `确定删除「${group.name}」？组内的 ${count} 个插件会回到未分组。`
            : `确定删除「${group.name}」？`,
        confirmText: '删除',
        danger: true,
    });
    if (!ok) return;

    // Keep enough state to put the group back exactly where it was.
    const index = settings.groups.findIndex(item => item.id === group.id);
    const removed = { ...group, members: [...group.members] };
    const expanded = state.expandedGroups.has(group.id);

    settings.groups = settings.groups.filter(item => item.id !== group.id);
    state.expandedGroups.delete(group.id);
    if (state.edit?.groupId === group.id) closeGroupEditModal();
    saveSettings();
    renderGroupEditor(true);
    applyGrouping(true);

    showToast(`已删除分组「${removed.name}」`, {
        actionLabel: '撤销',
        actionHandler: () => {
            if (settings.groups.some(item => item.id === removed.id)) return;
            settings.groups.splice(Math.max(0, index), 0, removed);
            if (expanded) state.expandedGroups.add(removed.id);
            saveSettings();
            renderGroupEditor(true);
            applyGrouping(true);
            showToast(`已恢复分组「${removed.name}」`);
        },
    });
}

/** Serialize the current grouping into the on-disk JSON shape. */
function buildGroupsConfig() {
    normalizeGroups();
    return {
        app: 'extension-manager',
        version: VERSION,
        groups: settings.groups,
        ungroupedCollapsed: !!settings.ungroupedCollapsed,
    };
}

/** Download the grouping as a JSON file the user can keep or move around. */
function exportGroupsConfig() {
    const payload = buildGroupsConfig();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'extension-manager-groups.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoke on the next tick so the browser has already started the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`已导出 ${settings.groups.length} 个分组的配置`);
}

/** Open the file picker; the chosen JSON is validated and confirmed. */
function importGroupsConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        let text = '';
        try {
            text = await file.text();
        } catch {
            showToast('读取文件失败');
            return;
        }
        const parsed = parseGroupsConfig(text);
        if (!parsed) {
            showToast('文件不是有效的分组配置');
            return;
        }
        const ok = await askConfirm({
            title: '导入分组配置',
            message: `将用 ${parsed.groups.length} 个分组替换当前的 ${settings.groups.length} 个分组，确定导入吗？`,
            confirmText: '导入',
            danger: true,
        });
        if (!ok) return;
        settings.groups = parsed.groups;
        settings.ungroupedCollapsed = parsed.ungroupedCollapsed;
        state.expandedGroups.clear();
        normalizeGroups();
        saveSettings();
        renderGroupEditor(true);
        applyGrouping(true);
        showToast(`已导入 ${settings.groups.length} 个分组`);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
}

/** Validate an imported payload; returns null when it is not usable. */
function parseGroupsConfig(text) {
    let data;
    try {
        data = JSON.parse(String(text ?? ''));
    } catch {
        return null;
    }
    const raw = Array.isArray(data) ? data : data?.groups;
    if (!Array.isArray(raw)) return null;
    const groups = raw
        .filter(item => item && typeof item === 'object')
        .map(item => ({
            id: String(item.id ?? `g${Date.now().toString(36)}`),
            name: normalize(item.name),
            enabled: item.enabled !== false,
            collapsed: !!item.collapsed,
            members: Array.isArray(item.members) ? item.members.map(String) : [],
        }))
        .filter(group => group.name);
    return groups.length ? { groups, ungroupedCollapsed: !!data?.ungroupedCollapsed } : null;
}

function addGroup(rawName) {
    normalizeGroups();
    const name = normalize(rawName);
    if (!name || groupNameExists(name)) return null;
    const group = {
        id: `g${Date.now().toString(36)}`,
        name,
        enabled: true,
        collapsed: false,
        members: [],
    };
    settings.groups.push(group);
    saveSettings();
    renderGroupEditor(true);
    applyGrouping(true);
    return group;
}

function setFormError(element, message) {
    if (!element) return;
    element.textContent = message || '';
    element.hidden = !message;
}

function setInputInvalid(input, invalid) {
    if (!input) return;
    input.classList.toggle('is-invalid', invalid);
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
}

function showAddGroupError(message) {
    const input = document.getElementById('emm-new-group');
    setFormError(document.getElementById('emm-add-group-error'), message);
    setInputInvalid(input, true);
    input?.focus();
    input?.select();
}

function clearAddGroupError() {
    setFormError(document.getElementById('emm-add-group-error'), '');
    setInputInvalid(document.getElementById('emm-new-group'), false);
}

function showEditNameError(message) {
    const input = document.getElementById('emm-edit-name');
    setFormError(document.getElementById('emm-edit-name-error'), message);
    setInputInvalid(input, true);
    input?.focus();
    input?.select();
}

function clearEditNameError() {
    setFormError(document.getElementById('emm-edit-name-error'), '');
    setInputInvalid(document.getElementById('emm-edit-name'), false);
}

export {
    addGroup,
    bindChipDrag,
    bindGroupRowDrag,
    bindKeyToGroup,
    buildGroupManagerItem,
    buildGroupsConfig,
    clearAddGroupError,
    clearEditNameError,
    closeGroupEditModal,
    currentEditGroup,
    exportGroupsConfig,
    importGroupsConfig,
    isGroupEditDirty,
    moveGroup,
    openGroupEditor,
    parseGroupsConfig,
    renderBoundList,
    renderGroupEditModal,
    renderGroupEditor,
    renderGroupPicker,
    reorderBoundKey,
    requestCloseGroupEditor,
    requestDeleteGroup,
    saveGroupEditor,
    setFormError,
    setInputInvalid,
    showAddGroupError,
    showEditNameError,
    unbindKeyFromGroup,
};
