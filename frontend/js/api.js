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
    removeToken() { localStorage.removeItem('meetly_token'); },
    getUser() {
        try { return JSON.parse(localStorage.getItem('meetly_user')); }
        catch { return null; }
    },
    setUser(u) { localStorage.setItem('meetly_user', JSON.stringify(u)); },
};

async function apiFetch(endpoint, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = API.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (options.body && !(options.body instanceof FormData) && !(options.body instanceof URLSearchParams)) {
        headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(endpoint, { ...options, headers });
    if (res.status === 401 && !endpoint.startsWith('/auth/token')) {
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
// users stay logged in. Uses a raw fetch (not apiFetch) so a failure never
// triggers the global 401 logout — if the token is truly expired, the next
// real API call handles logout as usual. No-op for guests (no token).
async function refreshSession() {
    const token = API.getToken();
    if (!token) return;
    try {
        const res = await fetch('/auth/refresh', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (res.ok) {
            const data = await res.json();
            if (data.access_token) API.setToken(data.access_token);
            if (data.username) API.setUser({ username: data.username });
        }
    } catch (_) {
        // Network hiccup — keep the existing token untouched.
    }
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
        container.className = 'fixed top-5 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none w-full max-w-sm px-4';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    const bgColors = {
        success: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
        error: 'bg-rose-500/15 border-rose-500/30 text-rose-300',
        info: 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300'
    };
    const iconSvgs = {
        success: `<svg class="w-4 h-4 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
        error: `<svg class="w-4 h-4 text-rose-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`,
        info: `<svg class="w-4 h-4 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
    };

    toast.className = `pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-full text-xs sm:text-sm font-medium backdrop-blur-xl border shadow-xl transition-all duration-300 transform -translate-y-2 opacity-0 ${bgColors[type] || bgColors.info} bg-slate-950/90`;
    toast.innerHTML = `${iconSvgs[type] || iconSvgs.info} <span>${escapeHtml(message)}</span>`;

    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.classList.remove('-translate-y-2', 'opacity-0');
        toast.classList.add('translate-y-0', 'opacity-100');
    });

    // Animate out
    setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('-translate-y-2', 'opacity-0');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
