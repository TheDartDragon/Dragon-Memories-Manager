// logger.js — Conditional debug logging with in-memory ring buffer.
//
// Import dmmLog in any module and call it exactly like console.log.
// Output goes to the browser console only when debugLogging is enabled in
// extension settings; entries always accumulate in the ring buffer so the
// user can copy them for a bug report even if they forgot to enable logging
// before the problem occurred.

import { EXT_NAME } from './constants.js';

const MAX_BUFFER = 500;
const _logBuffer = [];

let _debugEnabled = false;

/** Called by index.js whenever the debugLogging setting changes. */
export function setDebugLogging(enabled) {
    _debugEnabled = !!enabled;
}

/**
 * Conditional debug log.
 * Always stores the entry in the ring buffer.
 * Prints to console only when debug logging is enabled.
 *
 * @param {...*} args
 */
export function dmmLog(...args) {
    const text = args
        .map(a => (a !== null && typeof a === 'object' ? JSON.stringify(a) : String(a)))
        .join(' ');
    const line = `[${new Date().toISOString()}] ${text}`;

    _logBuffer.push(line);
    if (_logBuffer.length > MAX_BUFFER) _logBuffer.shift();

    if (_debugEnabled) {
        console.log(`[${EXT_NAME}]`, ...args);
    }
}

/** Return the full buffer as a newline-joined string. */
export function getLogText() {
    return _logBuffer.join('\n');
}

/** Clear the ring buffer. */
export function clearLog() {
    _logBuffer.length = 0;
}
