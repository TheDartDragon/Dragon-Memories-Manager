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

// ── Dev logging ──────────────────────────────────────────────────────────────
// Enable:  localStorage.setItem('DMM_DEV', '1')
// Disable: localStorage.removeItem('DMM_DEV')
// Log file: data/default-user/files/dmm_dev.log  (auto-flushed, readable by Claude)

const _devBuffer = [];
let _devFlushTimer = null;

/**
 * Dev-only log. Fires only when DMM_DEV is set in localStorage.
 * Always-on in prod means zero overhead when disabled.
 * Auto-flushes session buffer to disk 1 s after the last call.
 */
export function dmmDevLog(...args) {
    const text = args
        .map(a => (a !== null && typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)))
        .join(' ');
    const line = `[${new Date().toISOString()}] [DEV] ${text}`;

    // Always visible in the UI log buffer so testers can copy without file access
    _logBuffer.push(line);
    if (_logBuffer.length > MAX_BUFFER) _logBuffer.shift();

    if (!localStorage.getItem('DMM_DEV')) return;
    _devBuffer.push(line);
    console.log('[DMM:DEV]', ...args);
    _scheduleDevFlush();
}

function _scheduleDevFlush() {
    if (_devFlushTimer) clearTimeout(_devFlushTimer);
    _devFlushTimer = setTimeout(() => {
        _devFlushTimer = null;
        flushDevLog();
    }, 1000);
}

let _csrfToken = null;
async function getCsrfToken() {
    if (_csrfToken) return _csrfToken;
    const res = await fetch('/csrf-token');
    _csrfToken = (await res.json()).token;
    return _csrfToken;
}

/** Write the full session dev-log buffer to data/default-user/user/files/dmm_dev.log */
export async function flushDevLog() {
    if (!_devBuffer.length) return;
    const content = _devBuffer.join('\n') + '\n';
    // btoa doesn't handle non-Latin chars; this two-step encodes UTF-8 safely
    const b64 = btoa(unescape(encodeURIComponent(content)));
    try {
        const csrf = await getCsrfToken();
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify({ name: 'dmm_dev.log', data: b64 }),
        });
        if (!res.ok) console.warn('[DMM:DEV] Log flush failed:', res.status, await res.text());
    } catch (e) {
        console.warn('[DMM:DEV] Log flush error:', e);
    }
}

if (typeof window !== 'undefined') {
    window.DMM = window.DMM || {};
    window.DMM.flushDevLog = flushDevLog;
}

/** Return the full buffer as a newline-joined string. */
export function getLogText() {
    return _logBuffer.join('\n');
}

/** Clear the ring buffer. */
export function clearLog() {
    _logBuffer.length = 0;
}
