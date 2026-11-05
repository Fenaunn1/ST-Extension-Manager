/**
 * Extension Manager — Built-in blocks
 *
 * Visibility of the built-in SillyTavern extension drawers (Assets and the deprecated
 * Extras API block) plus the host element that grouped drawers move into.
 */

import { settings } from './core.js';

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

function markBuiltins() {
    for (const drawer of document.querySelectorAll('#assets_container .inline-drawer')) {
        drawer.dataset.emmBuiltin = 'assets';
    }

    document.querySelectorAll('[data-emm-builtin="api"]')
        .forEach(element => element.removeAttribute('data-emm-builtin'));

    const heading = [...document.querySelectorAll('#rm_extensions_block h4, #rm_extensions_block h3')]
        .find(element => element.textContent.includes('扩展API') || element.textContent.includes('Extensions API'));
    if (!heading) return;

    const titleRow = heading.parentElement;
    if (!titleRow?.closest('#rm_extensions_block')) return;
    titleRow.dataset.emmBuiltin = 'api';

    const separator = titleRow.previousElementSibling;
    if (separator?.tagName === 'HR') separator.dataset.emmBuiltin = 'api';

    const inputRow = titleRow.nextElementSibling;
    if (inputRow?.classList.contains('alignitemsflexstart')) inputRow.dataset.emmBuiltin = 'api';
}

function isBuiltinHidden(drawer) {
    if (!settings.hideBuiltins) return false;
    if (drawer?.dataset?.emmBuiltin === 'assets') return true;
    return !!drawer?.closest?.('[data-emm-builtin="assets"]');
}

function applyBuiltinVisibility() {
    markBuiltins();
    document.querySelector('#rm_extensions_block')
        ?.classList.toggle('emm-hide-builtins', !!settings.hideBuiltins);
}

export {
    applyBuiltinVisibility,
    ensureGroupHost,
    isBuiltinHidden,
    markBuiltins,
};
