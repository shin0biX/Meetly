// Meetly API helper with JWT auth + token persistence
// HTTPS enforcement for production (allow localhost and local network IP addresses)
(function checkProtocol() {
    const hostname = location.hostname;
    const isLocal = hostname === 'localhost' ||
                    hostname === '127.0.0.1' ||
                    /^192\.168\./.test(hostname) ||
                    /^10\./.test(hostname) ||
                    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname);
    // Only redirect if on a public domain over plain HTTP
    if (location.protocol === 'http:' && !isLocal && !location.port) {
        location.replace(`https://${hostname}${location.pathname}${location.search}`);
    }
})();

const API = {
    getToken() { return localStorage.getItem('meetly_token'); },
    setToken(t) { localStorage.setItem('meetly_token', t); },
    getRefreshToken() { return localStorage.getItem('meetly_refresh_token'); },
    setRefreshToken(t) { localStorage.setItem('meetly_refresh_token', t); },
    removeToken() { localStorage.removeItem('meetly_token'); localStorage.removeItem('meetly_refresh_token'); },
    getUser() {
        try { return JSON.parse(localStorage.getItem('meetly_user')); }
        catch { return null; }
    },
    setUser(u) { localStorage.setItem('meetly_user', JSON.stringify(u)); },
};

async function apiFetch(endpoint, options = {}) {
    const requestOptions = { ...options };
    const callerHeaders = { ...(options.headers || {}) };
    const callerSuppliedAuth = Object.keys(callerHeaders).some(k => k.toLowerCase() === 'authorization');

    const buildHeaders = () => {
        const currentHeaders = { ...callerHeaders };
        const token = API.getToken();
        if (token && !callerSuppliedAuth) currentHeaders.Authorization = `Bearer ${token}`;
        if (requestOptions.body && !(requestOptions.body instanceof FormData) && !(requestOptions.body instanceof URLSearchParams)) {
            currentHeaders['Content-Type'] = currentHeaders['Content-Type'] || 'application/json';
        }
        return currentHeaders;
    };

    const doFetch = () => fetch(endpoint, { ...requestOptions, headers: buildHeaders() });
    let res = await doFetch();

    // A normal Meetly API request may transparently refresh an expired access
    // token once. Requests with a caller-supplied Authorization header are
    // deliberately excluded because that header may contain a guest token,
    // meeting ticket, or another scoped credential rather than the user's JWT.
    if (res.status === 401 && !callerSuppliedAuth && !endpoint.startsWith('/auth/token') && !endpoint.startsWith('/auth/refresh')) {
        const refreshed = await refreshSession();
        if (refreshed) {
            res = await doFetch();
        }
    }

    if (res.status === 401 && !callerSuppliedAuth && !endpoint.startsWith('/auth/token') && !endpoint.startsWith('/auth/refresh')) {
        API.removeToken();
        if (window.location.pathname !== '/index.html') window.location.href = '/index.html';
        throw new Error('Session expired');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'Something went wrong');
    return data;
}

// Silently roll the session forward (sliding expiration). Call on app load
// when a token exists: a fresh token replaces the stored one so returning
// users stay signed in. Uses a raw fetch (not apiFetch) so a failure never
// triggers the global 401 logout — if the token is truly expired, the next
// real API call handles logout as usual. No-op for guests (no token).
//
// Refresh tokens are single-use, and localStorage is shared by every tab of
// the app. Without coordination, two tabs refreshing near-simultaneously
// would race: one rotates the token, the other's (now-revoked) token gets a
// 401 and that tab logs itself out. The Web Locks API serializes refreshes
// across tabs, and the token is re-read inside the lock so the second tab
// simply uses the token the first tab just stored.
async function refreshSession() {
    const refreshToken = API.getRefreshToken();
    if (!refreshToken) return false;
    const doRefresh = async () => {
        const current = API.getRefreshToken();
        if (!current) return false;
        try {
            const res = await fetch('/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: current }) });
            if (!res.ok) {
                // Only clear credentials if the stored token wasn't rotated by
                // another tab in the meantime.
                if (API.getRefreshToken() === current) API.removeToken();
                return false;
            }
            const data = await res.json();
            if (data.access_token) API.setToken(data.access_token);
            if (data.refresh_token) API.setRefreshToken(data.refresh_token);
            if (data.username) API.setUser({ ...(API.getUser() || {}), username: data.username });
            return true;
        } catch (_) { return false; }
    };
    if (navigator.locks && navigator.locks.request) {
        try {
            return await navigator.locks.request('meetly-refresh-lock', doRefresh);
        } catch (_) { return false; }
    }
    return doRefresh();
}

// Canonical escapeHtml — shared by all pages
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Copy text to clipboard with fallback and toast feedback
async function copyToClipboard(text, customMessage) {
    let success = false;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            success = true;
        } else {
            throw new Error('Clipboard API unavailable');
        }
    } catch {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            success = true;
        } catch {
            success = false;
        }
    }

    if (success) {
        showToast(customMessage || 'Copied to clipboard!', 'success');
    } else {
        showToast('Failed to copy', 'error');
    }
    return success;
}

// Sleek floating toast notification system
function showToast(message, type = 'info', duration = 3000) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `meetly-toast meetly-toast-${type}`;
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;

    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    });

    // Animate out
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
