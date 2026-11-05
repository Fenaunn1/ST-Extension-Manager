/**
 * Extension Manager — a UI-only SillyTavern extension.
 *
 * It enhances the built-in "Extensions" drawer with a sticky toolbar, search filtering,
 * an open-extension tab strip, one-click collapse, and user-defined groups that support
 * drag reordering, clipboard import and export, and delete with undo.
 *
 * The implementation lives in the sibling modules; this file only boots it.
 */

import { boot } from './events.js';

boot();
