// Meetly room client: WebRTC mesh + WebSocket signaling + chat + screen share + host controls + guest support
(() => {
    // 1) Extract room code from URL param or sessionStorage
    const urlParams = new URLSearchParams(window.location.search);
    let room = (urlParams.get('room') || sessionStorage.getItem('meetly_room') || '').trim().toLowerCase();

    // The room code is interpolated into WebSocket/fetch paths below, so it
    // must match exactly what the server accepts (rooms.py ROOM_CODE_PATTERN)
    // — a crafted ?room=../api/x link must not pivot the request paths.
    const ROOM_CODE_PATTERN = /^[a-z0-9_-]{1,64}$/;
    if (!room || !ROOM_CODE_PATTERN.test(room)) {
        sessionStorage.removeItem('meetly_room');
        window.location.href = '/dashboard.html';
        return;
    }

    sessionStorage.setItem('meetly_room', room);

    // A stable identity for THIS browser tab. sessionStorage is isolated per
    // tab, so refreshing keeps the same identity while another tab gets a
    // different one. The server uses this to replace stale connections from
    // a refresh without incorrectly treating two tabs of the same account as
    // the same participant.
    const connectionStorageKey = `meetly_connection_id_${room}`;
    let connectionId = sessionStorage.getItem(connectionStorageKey);
    if (!connectionId) {
        connectionId = (globalThis.crypto?.randomUUID)
            ? globalThis.crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem(connectionStorageKey, connectionId);
    }

    // Set UI room labels
    const roomCodeLabel = document.getElementById('room-code-label');
    if (roomCodeLabel) roomCodeLabel.textContent = room;
    const modalRoomCodeTag = document.getElementById('modal-room-code-tag');
    if (modalRoomCodeTag) modalRoomCodeTag.textContent = room;

    let token = API.getToken();
    let user = API.getUser();
    let name = (token && user && user.username) ? user.username : (sessionStorage.getItem('meetly_guest_name') || '');
    // Display names are not identities. Guests get a random ID that survives
    // refreshes within this browser session and is used only for authorization.
    let guestToken = null;
    if (!token) {
        guestToken = sessionStorage.getItem(`meetly_guest_token_${room}`);
    }
    // Server-signed proof of room membership, issued in the WebSocket 'joined'
    // message. Consumed by /livekit/token when the server routes media through
    // LiveKit; unused in P2P (mesh) mode.
    let meetingTicket = null;

    const CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ]
    };

    let turnConfigured = false;

    async function addTurnServers(turnTicket) {
        if (turnConfigured || !turnTicket) return;
        try {
            const t = await apiFetch(`/turn/credentials?room=${encodeURIComponent(room)}`, {
                headers: { 'X-Meetly-Turn-Ticket': turnTicket }
            });
            const urls = (t && Array.isArray(t.urls) && t.urls.length) ? t.urls : (t && t.url ? [t.url] : []);
            const liveUrls = urls.filter(u => u && u.length);
            if (liveUrls.length && t.username && t.credential) {
                CONFIG.iceServers.push({
                    urls: liveUrls,
                    username: t.username,
                    credential: t.credential,
                });
                turnConfigured = true;
                console.log('TURN configured:', liveUrls.join(', '));
            }
        } catch (err) {
            console.warn('TURN unavailable:', err.message);
        }
    }

    const state = {
        ws: null,
        myId: null,
        isOwner: false,
        // Media transport: 'p2p' (mesh over WebSocket signaling) or 'livekit'
        // (SFU via LiveKit Cloud). The server decides in the 'joined' message.
        mediaMode: 'p2p',
        lkRoom: null,
        lkConnected: false,
        lkIdentity: null,
        localStream: null,
        screenStream: null,
        isScreenSharing: false,
        peers: new Map(),     // remoteId -> RTCPeerConnection
        peerNames: new Map(), // remoteId -> name
        peerRoles: new Map(), // remoteId -> isOwner (bool)
        peerHands: new Map(), // remoteId -> hand raised (bool)
        peerForceMuted: new Map(), // remoteId -> host force-muted (bool)
        peerCamForcedOff: new Map(), // remoteId -> host force-disabled cam (bool)
        micOn: true,
        camOn: true,
        selfForceMuted: false,  // host force-muted MY mic; only a host can release it
        selfCamForcedOff: false, // host force-disabled MY camera
        reconnectAttempts: 0,
        maxReconnectAttempts: 10,
        reconnecting: false,
        intentionalLeave: false,
        // Set when the WebSocket 'joined' message arrives — a page idling in
        // the guest modal must not accrue "call time".
        callStartTime: null,
        unreadCount: 0,
        drawerOpen: false,
        activeDrawerTab: 'chat',
        handRaised: false,
        localPinId: null,     // tile the viewer manually pinned/fullscreened (takes priority)
        hostSpotlightId: null,// tile the host spotlighted for everyone (used when no local pin)
        dmTarget: '',         // '' = Everyone, otherwise a peer client_id
    };

    // DOM Elements
    const grid = document.getElementById('video-grid');
    const emptyHint = document.getElementById('empty-hint');
    const connStatusText = document.getElementById('conn-status-text');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sideDrawer = document.getElementById('side-drawer');
    const unreadBadge = document.getElementById('unread-badge');
    const peopleList = document.getElementById('people-list');
    const peopleCountPill = document.getElementById('people-count-pill');
    const callTimerEl = document.getElementById('call-timer');
    const hostBadge = document.getElementById('host-badge');
    const guestModal = document.getElementById('guest-modal');
    const guestNameInput = document.getElementById('guest-name-input');
    const signinInsteadLink = document.getElementById('signin-instead-link');
    const reactionOverlay = document.getElementById('reaction-overlay');
    const chatTargetSelect = document.getElementById('chat-target-select');

    if (signinInsteadLink) {
        signinInsteadLink.href = `/index.html?redirect=${encodeURIComponent('/room.html?room=' + room)}`;
    }

    // Call Timer — starts counting from the 'joined' message (state.callStartTime)
    setInterval(() => {
        if (state.callStartTime === null || !callTimerEl) return;
        const elapsed = Math.floor((Date.now() - state.callStartTime) / 1000);
        const hrs = Math.floor(elapsed / 3600);
        const mins = Math.floor((elapsed % 3600) / 60);
        const secs = elapsed % 60;
        callTimerEl.textContent = 
            (hrs > 0 ? String(hrs).padStart(2, '0') + ':' : '') +
            String(mins).padStart(2, '0') + ':' +
            String(secs).padStart(2, '0');
    }, 1000);

    // Dynamic Grid Layout Updater
    function updateGridLayout() {
        const tiles = Array.from(grid.querySelectorAll('.video-tile'));
        const count = tiles.length;

        // Local pin (manual, per-viewer) always wins over the host's spotlight.
        const pinnedId = state.localPinId || state.hostSpotlightId;
        const pinnedTile = pinnedId ? document.getElementById('tile-' + pinnedId) : null;

        if (pinnedTile && count > 1) {
            grid.className = 'grid-pinned';
            let strip = document.getElementById('pinned-strip');
            if (!strip) {
                strip = document.createElement('div');
                strip.id = 'pinned-strip';
                grid.appendChild(strip);
            }
            tiles.forEach(t => {
                if (t === pinnedTile) {
                    t.classList.add('pinned-main');
                    if (t.parentElement !== grid) grid.insertBefore(t, strip);
                } else {
                    t.classList.remove('pinned-main');
                    if (t.parentElement !== strip) strip.appendChild(t);
                }
            });
            if (strip.parentElement !== grid) grid.appendChild(strip);
            emptyHint?.classList.add('hidden');
        } else {
            // Un-pinned / normal grid: move any strip children back out and drop it.
            const strip = document.getElementById('pinned-strip');
            if (strip) {
                Array.from(strip.children).forEach(t => grid.insertBefore(t, strip));
                strip.remove();
            }
            tiles.forEach(t => t.classList.remove('pinned-main'));

            grid.className = '';
            if (count <= 1) {
                grid.classList.add('grid-1');
            } else if (count === 2) {
                grid.classList.add('grid-2');
            } else {
                grid.classList.add('grid-multi');
            }

            if (emptyHint) {
                if (count <= 1) {
                    emptyHint.style.display = 'block';
                } else {
                    emptyHint.style.display = 'none';
                }
            }
        }
        updatePeopleList();
    }

    // Local Media Initialization
    async function initLocalStream() {
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Camera/microphone API unavailable on this connection.');
            }

            try {
                state.localStream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
                    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
                });
            } catch (mediaErr) {
                console.warn('Full media acquisition failed, trying audio-only:', mediaErr);
                try {
                    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    state.camOn = false;
                } catch (audioErr) {
                    console.warn('Audio-only acquisition failed:', audioErr);
                    state.camOn = false;
                    state.micOn = false;
                }
            }

            const tile = addTile('me', name, true);
            if (state.localStream) {
                const video = tile.querySelector('video');
                if (video) {
                    video.srcObject = state.localStream;
                    video.muted = true;
                    await video.play().catch(() => {});
                }
                setupAudioAnalyser(state.localStream, 'me');
            }
            setTileCameraState('me', state.camOn);
            setTileMicState('me', state.micOn);
            updateGridLayout();
        } catch (err) {
            console.warn('initLocalStream error:', err);
            const tile = addTile('me', name, true);
            state.camOn = false;
            state.micOn = false;
            setTileCameraState('me', false);
            setTileMicState('me', false);
            updateGridLayout();
            showToast('Camera/Microphone notice: ' + err.message, 'info', 4000);
        }
    }

    // Video Tile Generator
    function addTile(id, displayName, isSelf = false) {
        let tile = document.getElementById('tile-' + id);
        if (tile) return tile;

        tile = document.createElement('div');
        tile.id = 'tile-' + id;
        tile.className = 'video-tile' + (isSelf ? ' self-tile' : '');
        
        const initials = (displayName || '?').substring(0, 2).toUpperCase();

        tile.innerHTML = `
            <video autoplay playsinline webkit-playsinline ${isSelf ? 'muted' : ''}></video>

            <div class="avatar-fallback hidden">
                <div class="avatar-circle">${escapeHtml(initials)}</div>
            </div>

            <span class="tile-hand-badge hidden">✋</span>

            <div class="tile-controls">
                <button class="tile-icon-btn tile-pin-btn" data-id="${id}" title="Pin / fullscreen">
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5M9 15v4.5M9 15H4.5M9 15l-5.5 5.5M15 15h4.5M15 15v4.5m0-4.5l5.5 5.5"/></svg>
                </button>
                <button class="tile-icon-btn tile-fullscreen-btn" data-id="${id}" title="Fullscreen">
                    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
                </button>
            </div>

            <div class="tile-name-tag">
                <span class="truncate">${escapeHtml(displayName)}${isSelf ? ' (You)' : ''}</span>
                <svg class="tile-mute-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"/></svg>
            </div>
        `;

        grid.appendChild(tile);

        tile.querySelector('.tile-pin-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePin(id);
        });
        tile.querySelector('.tile-fullscreen-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            requestTileFullscreen(id);
        });
        tile.addEventListener('dblclick', () => requestTileFullscreen(id));

        if (state.peerHands.get(id) || (isSelf && state.handRaised)) {
            tile.querySelector('.tile-hand-badge')?.classList.remove('hidden');
        }

        return tile;
    }

    // Local pin: any participant can pin any tile (their own camera, a
    // peer's camera, or a screen share) to the large "main stage" view. This
    // is per-viewer and does not affect what anyone else sees.
    function togglePin(id) {
        state.localPinId = (state.localPinId === id) ? null : id;
        document.querySelectorAll('.tile-pin-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.id === state.localPinId);
        });
        updateGridLayout();
    }

    function requestTileFullscreen(id) {
        const tile = document.getElementById('tile-' + id);
        const video = tile?.querySelector('video');
        const target = video || tile;
        if (!target) return;
        const req = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
        if (req) {
            req.call(target).catch(() => {});
        }
    }

    function removeTile(id) {
        stopAudioAnalyser(id);
        const tile = document.getElementById('tile-' + id);
        if (tile) tile.remove();
        if (state.localPinId === id) state.localPinId = null;
        if (state.hostSpotlightId === id) state.hostSpotlightId = null;
        updateGridLayout();
    }

    function setTileCameraState(id, camOn) {
        const tile = document.getElementById('tile-' + id);
        if (!tile) return;
        const video = tile.querySelector('video');
        const fallback = tile.querySelector('.avatar-fallback');
        if (video) video.style.display = camOn ? 'block' : 'none';
        if (fallback) fallback.style.display = camOn ? 'none' : 'flex';
    }

    function setTileMicState(id, micOn) {
        const tile = document.getElementById('tile-' + id);
        if (!tile) return;
        const icon = tile.querySelector('.tile-mute-icon');
        if (icon) {
            icon.style.display = micOn ? 'none' : 'inline';
        }
    }

    // Per-tile connection status overlay so a black remote tile is
    // distinguishable between "still negotiating" and "ICE failed".
    function setTileConnState(id, state) {
        const tile = document.getElementById('tile-' + id);
        if (!tile) return;
        let badge = tile.querySelector('.tile-conn-status');
        if (state === 'connected') {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'tile-conn-status';
            tile.appendChild(badge);
        }
        badge.textContent = state === 'failed'
            ? 'Connection failed (media could not traverse the network)'
            : 'Connecting…';
        badge.classList.toggle('failed', state === 'failed');
    }

    // Speaking indicator. One shared AudioContext is created lazily and reused
    // for every tile — a fresh AudioContext per tile leaks them, and Chrome
    // caps concurrent contexts (~6), which eventually breaks the indicators.
    let sharedAudioCtx = null;

    function getAudioContext() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return null;
            if (!sharedAudioCtx) sharedAudioCtx = new AudioContext();
            if (sharedAudioCtx.state === 'suspended') {
                sharedAudioCtx.resume().catch(() => {});
            }
            return sharedAudioCtx;
        } catch (e) {
            return null;
        }
    }

    // targetId -> { rafId, source }; cleaned up when the tile is removed.
    const analysers = new Map();

    function stopAudioAnalyser(targetId) {
        const a = analysers.get(targetId);
        if (!a) return;
        analysers.delete(targetId);
        cancelAnimationFrame(a.rafId);
        try { a.source?.disconnect(); } catch (_) {}
    }

    function setupAudioAnalyser(stream, targetId) {
        stopAudioAnalyser(targetId);
        try {
            if (!stream || !stream.getAudioTracks().length) return;
            const audioCtx = getAudioContext();
            if (!audioCtx) return;

            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);

            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            let rafId = 0;
            const checkSpeaking = () => {
                const tile = document.getElementById('tile-' + targetId);
                if (!tile) {
                    // Tile is gone — stop the loop and release the graph node.
                    stopAudioAnalyser(targetId);
                    return;
                }
                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    sum += dataArray[i];
                }
                const average = sum / bufferLength;
                tile.classList.toggle('is-speaking', average > 25);
                rafId = requestAnimationFrame(checkSpeaking);
            };
            rafId = requestAnimationFrame(checkSpeaking);
            analysers.set(targetId, { rafId, source });
        } catch (e) {
            console.log('Audio analyser notice:', e);
        }
    }

    // WebRTC Peer Management.
    // ICE candidates that arrive before the remote description is applied are
    // buffered per-connection (and per-peer before the RTCPeerConnection even
    // exists) and flushed afterwards. Without this, the offer/answer chain —
    // which completes across several async hops — can lose candidates that
    // arrive in between, and the peer connection then never reaches a
    // "connected" ICE state (the remote video stays black).
    const earlyIce = new Map(); // remoteId -> [candidates that arrived before their pc existed]

    function bufferIceCandidate(pc, fromId, candidate) {
        if (!pc) {
            const list = earlyIce.get(fromId) || [];
            list.push(candidate);
            earlyIce.set(fromId, list);
            return;
        }
        if (pc.remoteDescription && pc.remoteDescription.type) {
            pc.addIceCandidate(candidate).catch(console.error);
        } else {
            pc._pendingCandidates.push(candidate);
        }
    }

    function flushPendingCandidates(pc) {
        const pending = pc._pendingCandidates;
        pc._pendingCandidates = [];
        pending.forEach(c => pc.addIceCandidate(c).catch(console.error));
    }

    // ICE-failure recovery: a fresh offer with iceRestart is delivered through
    // the normal offer/answer relay — the remote treats it like any offer and
    // answers, so no extra protocol support is needed.
    async function restartIceOffer(pc) {
        if (pc.signalingState !== 'stable') return null;
        pc._makingOffer = true;
        try {
            const offer = await pc.createOffer({ iceRestart: true });
            await pc.setLocalDescription(offer);
            return pc.localDescription;
        } catch (err) {
            console.error('ICE restart offer failed:', err);
            return null;
        } finally {
            pc._makingOffer = false;
        }
    }

    function createPeer(remoteId, peerName, isInitiator, isPeerOwner = false) {
        if (state.peers.has(remoteId)) return state.peers.get(remoteId);

        const pc = new RTCPeerConnection(CONFIG);
        state.peers.set(remoteId, pc);
        state.peerNames.set(remoteId, peerName);
        state.peerRoles.set(remoteId, isPeerOwner);
        pc._pendingCandidates = earlyIce.get(remoteId) || [];
        earlyIce.delete(remoteId);
        pc._makingOffer = false;

        // Add local tracks. The stream can legitimately be null when the user
        // denied camera/microphone access — they still join to watch others.
        const currentStream = state.isScreenSharing && state.screenStream ? state.screenStream : state.localStream;
        if (currentStream) {
            currentStream.getTracks().forEach(track => pc.addTrack(track, currentStream));
        }
        // Without a matching local track there is no m-line for that media type
        // and the offer negotiates nothing — a participant without a camera
        // could never receive the peers' video either. Add recvonly
        // transceivers so watch-only participants still get a full connection.
        // The video one is kept on _screenPromotable: a camera-less participant
        // later promoting it to sendrecv is how they can still share a screen
        // (the only sendable "sender" they otherwise have is the mic).
        if (!currentStream || currentStream.getVideoTracks().length === 0) {
            const recvOnlyVideo = pc.addTransceiver('video', { direction: 'recvonly' });
            pc._screenPromotable = recvOnlyVideo;
        }
        if (!currentStream || currentStream.getAudioTracks().length === 0) {
            pc.addTransceiver('audio', { direction: 'recvonly' });
        }

        // Remote track arrived
        pc.ontrack = (event) => {
            const tile = addTile(remoteId, state.peerNames.get(remoteId) || peerName);
            const video = tile.querySelector('video');
            if (video.srcObject !== event.streams[0]) {
                video.srcObject = event.streams[0];
                video.muted = false;
                video.play().catch(() => {});
                setupAudioAnalyser(event.streams[0], remoteId);
            }
            updateGridLayout();
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                send({ type: 'ice-candidate', to: remoteId, candidate: e.candidate });
            }
        };

        pc.oniceconnectionstatechange = () => {
            const s = pc.iceConnectionState;
            if (s === 'connected') {
                setConnBadgeStatus(`${state.peers.size + 1} in call`, 'connected');
                setTileConnState(remoteId, 'connected');
            } else if (s === 'failed') {
                // Media is peer-to-peer: this normally means NAT traversal
                // failed (no reachable TURN server), not a Meetly bug. One
                // automatic ICE restart gives a transient network change a
                // chance to recover before the tile is declared failed.
                setTileConnState(remoteId, 'failed');
                if (!pc._iceRestartAttempted && pc.signalingState === 'stable') {
                    pc._iceRestartAttempted = true;
                    restartIceOffer(pc).then(sdp => {
                        if (sdp) send({ type: 'offer', to: remoteId, sdp });
                    }).catch(console.error);
                }
            } else if (s === 'disconnected') {
                setTileConnState(remoteId, 'connecting');
            }
        };
        setTileConnState(remoteId, 'connecting');

        if (isInitiator) {
            pc._makingOffer = true;
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    send({ type: 'offer', to: remoteId, sdp: pc.localDescription });
                })
                .catch(console.error)
                .finally(() => { pc._makingOffer = false; });
        }

        return pc;
    }

    function closePeer(remoteId) {
        const pc = state.peers.get(remoteId);
        if (pc) {
            pc.close();
            state.peers.delete(remoteId);
        }
        earlyIce.delete(remoteId);
        state.peerNames.delete(remoteId);
        state.peerRoles.delete(remoteId);
        state.peerHands.delete(remoteId);
        state.peerForceMuted.delete(remoteId);
        state.peerCamForcedOff.delete(remoteId);
        updateChatTargetOptions();
        removeTile(remoteId);
        updateGridLayout();
        if (state.peerNames.size === 0) {
            setConnBadgeStatus('Connected (Alone)', 'connected');
        }
    }

    function closeAllPeers() {
        state.peers.forEach((pc, remoteId) => stopAudioAnalyser(remoteId));
        state.peers.forEach(pc => pc.close());
        state.peers.clear();
        earlyIce.clear();
        state.peerNames.clear();
        state.peerRoles.clear();
        state.peerHands.clear();
        state.peerForceMuted.clear();
        state.peerCamForcedOff.clear();
        state.localPinId = null;
        state.hostSpotlightId = null;
        updateChatTargetOptions();
        const remoteTiles = grid.querySelectorAll('.video-tile:not(#tile-me)');
        remoteTiles.forEach(t => t.remove());
        updateGridLayout();
    }

    // Host Action: Kick Participant
    function kickParticipant(peerId, peerDisplayName) {
        if (!state.isOwner) return;
        if (!confirm(`Are you sure you want to remove ${peerDisplayName} from this room?`)) return;

        send({ type: 'kick', target_id: peerId });
        showToast(`Removed ${peerDisplayName}`, 'info');
    }

    // ------------------------------------------------------------------
    // LiveKit media layer (SFU mode). Used when the server reports
    // media: 'livekit' in the 'joined' message. Chat, roster, and host
    // controls ALWAYS run over the WebSocket; LiveKit only carries the
    // audio/video tracks. Participants are keyed by the same client_id the
    // WebSocket assigned (the server embeds it in the media token), so
    // tiles, host controls and pins stay identical across both modes.
    // ------------------------------------------------------------------
    // track.attach(video) sets srcObject and calls video.play() internally,
    // but on mobile browsers (iOS Safari in particular) that play() promise
    // can reject silently — e.g. AbortError from a getUserMedia permission
    // prompt stealing focus, or NotAllowedError right after a backgrounded
    // tab returns — and LiveKit doesn't retry it. The tile then sits black
    // forever with no console error surfaced anywhere in our code. This
    // wrapper attaches, explicitly re-attempts play() if it rejects, and
    // retries once more when the tab regains visibility/focus (covers the
    // permission-prompt-backgrounds-the-tab case).
    function attachAndPlay(track, video) {
        if (!track || !video) return;
        track.attach(video);
        let resolved = false;
        const tryPlay = () => {
            if (resolved && !video.paused) return;
            video.play().then(() => {
                resolved = true;
                // Play succeeded — stop retrying on future visibility/focus.
                document.removeEventListener('visibilitychange', retryOnVisible);
                window.removeEventListener('focus', retryOnVisible);
            }).catch(err => {
                console.warn('Video play() failed, will retry on visibility/focus:', err);
            });
        };
        // Persistent listeners (not once:true): a single once-retry can be
        // consumed while the permission prompt still has the tab backgrounded,
        // leaving the tile black with no further attempts.
        const retryOnVisible = () => {
            if (document.visibilityState === 'visible' && video.paused) tryPlay();
        };
        document.addEventListener('visibilitychange', retryOnVisible);
        window.addEventListener('focus', retryOnVisible);
        tryPlay();
    }

    async function connectLiveKit() {
        if (state.mediaMode !== 'livekit' || !meetingTicket) return;
        if (typeof LivekitClient === 'undefined') {
            throw new Error('Video library failed to load. Check your connection and refresh.');
        }
        // Reconnect with a fresh WS id: the LiveKit identity must equal our
        // current roster id, so a replaced connection re-joins the SFU too.
        if (state.lkConnected && state.lkIdentity === state.myId) return;
        if (state.lkRoom) {
            try { await state.lkRoom.disconnect(); } catch (_) {}
            state.lkRoom = null;
            state.lkConnected = false;
        }

        const info = await apiFetch(`/livekit/token?room=${encodeURIComponent(room)}`, {
            headers: { Authorization: `Bearer ${meetingTicket}` }
        });
        if (!info || !info.url || !info.token) {
            throw new Error('Could not get a media session from the server.');
        }

        const lkRoom = new LivekitClient.Room({
            adaptiveStream: true, // don't pull full-res video for tiles the viewer can't see
            dynacast: true,       // stop encoding simulcast layers nobody is subscribed to
            // Capture high (up to what the camera supports) and let
            // simulcast/adaptiveStream deliver whatever each viewer's tile
            // actually needs. The old defaults capped the top layer at ~720p
            // with a low bitrate ceiling, which read as visible quality loss
            // versus the raw P2P stream.
            videoCaptureDefaults: {
                resolution: LivekitClient.VideoPresets.h1080.resolution,
                // Mobile browsers often default to the BACK camera. This makes
                // every LiveKit-side camera start (initial join AND any later
                // re-enable after a failed acquisition) prefer the front one.
                facingMode: 'user',
            },
            publishDefaults: {
                // Generous ceiling for the top simulcast layer so pinned /
                // fullscreen tiles stay sharp; dynacast still saves uplink
                // when nobody is subscribed to the high layer.
                videoEncoding: { maxBitrate: 3_000_000, maxFramerate: 30 },
                // Screen shares are mostly text: keep resolution under
                // bandwidth pressure and give the encoder room to work.
                screenShareEncoding: { maxBitrate: 5_000_000, maxFramerate: 30 },
                // Under congestion, drop frames rather than softening detail.
                degradationPreference: 'maintain-resolution',
            },
        });
        state.lkRoom = lkRoom;

        lkRoom
            .on(LivekitClient.RoomEvent.TrackSubscribed, onTrackSubscribed)
            .on(LivekitClient.RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
            .on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
                removeTile(participant.identity + '-screen');
            })
            .on(LivekitClient.RoomEvent.ActiveSpeakersChanged, onActiveSpeakersChanged)
            .on(LivekitClient.RoomEvent.Disconnected, onLiveKitDisconnected)
            .on(LivekitClient.RoomEvent.Reconnecting, () => showToast('Reconnecting media...', 'info', 2000))
            .on(LivekitClient.RoomEvent.Reconnected, () => showToast('Media reconnected', 'success', 1500));

        // Build the local tile and acquire camera+mic in ONE getUserMedia
        // call (a single permission prompt) BEFORE connecting to the SFU —
        // the prompt then fires right in the join-click gesture, instead of
        // two separate setCameraEnabled/setMicrophoneEnabled prompts firing
        // back-to-back after connect, which on mobile frequently failed or
        // landed on the wrong camera.
        const tile = addTile('me', name, true);
        const video = tile.querySelector('video');
        video.muted = true;
        // Apply the real grid sizing (.grid-1 etc.) now, before the camera
        // track attaches below. Previously this only ran at the very end of
        // this function — so the local video started decoding/painting its
        // first frame while #video-grid still had no grid-template-columns
        // set at all, and the later reflow (once updateGridLayout() finally
        // ran) didn't reliably repaint the already-playing video. That's
        // what produced the black self-tile on first join until the user
        // toggled the camera off/on to force a fresh attach.
        updateGridLayout();

        const { stream, cameraDenied, micDenied } = await acquireLocalTracks();

        try {
            await lkRoom.connect(info.url, info.token);
        } catch (err) {
            stream?.getTracks().forEach(t => t.stop());
            // The self tile exists by now — don't leave it as a black video
            // with a live "mic" pretense; show the avatar and reflect reality
            // on our own roster tile.
            setTileCameraState('me', false);
            setTileMicState('me', false);
            send({ type: 'cam-state', on: false });
            send({ type: 'mic-state', on: false });
            throw err;
        }
        state.lkConnected = true;
        state.lkIdentity = state.myId;

        if (!stream) {
            showToast('Camera/microphone unavailable — joined without media', 'error', 4000);
            setMicState(false, false);
            setCamState(false, false);
            updateGridLayout();
            return;
        }

        state.localStream = stream; // owned tracks; stopped on leave/unload
        const videoTrack = stream.getVideoTracks()[0];
        const audioTrack = stream.getAudioTracks()[0];

        if (videoTrack) {
            // publishTrack() resolves WITH the LocalTrackPublication — use
            // that directly instead of a follow-up getTrackPublication()
            // lookup. That lookup was racing LiveKit's internal publication
            // map right after publish resolved: when the map hadn't caught
            // up yet, camPub/camPub.track came back empty, the attach was
            // silently skipped, and the code still marked the camera "on"
            // and showed the (sourceless) video element instead of falling
            // back to the avatar — the blank self-tile.
            const camPub = await lkRoom.localParticipant.publishTrack(videoTrack, { source: LivekitClient.Track.Source.Camera });
            if (camPub && camPub.track) {
                attachAndPlay(camPub.track, video);
                state.camOn = true;
                setTileCameraState('me', true);
            } else {
                // Publish didn't hand back a usable track — don't claim the
                // camera is on over a blank tile; show the avatar instead.
                state.camOn = false;
                setTileCameraState('me', false);
                send({ type: 'cam-state', on: false });
            }
        } else {
            state.camOn = false;
            setTileCameraState('me', false);
            send({ type: 'cam-state', on: false });
        }
        if (cameraDenied) {
            state.camOn = false;
            setTileCameraState('me', false);
            send({ type: 'cam-state', on: false });
        }
        if (audioTrack) {
            await lkRoom.localParticipant.publishTrack(audioTrack, { source: LivekitClient.Track.Source.Audio });
            state.micOn = true;
        } else {
            state.micOn = false;
            send({ type: 'mic-state', on: false });
        }
        if (micDenied) {
            state.micOn = false;
            send({ type: 'mic-state', on: false });
        }
        setTileMicState('me', state.micOn);
        updatePeopleList();
        updateGridLayout();
    }

    // Acquire camera+mic in a single getUserMedia (one permission prompt),
    // degrading gracefully: camera denied → mic only; both denied → null.
    // facingMode 'user' so phones pick the FRONT camera when they honor it.
    async function acquireLocalTracks() {
        const videoConstraints = {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 },
            facingMode: 'user',
        };
        const audioConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        try {
            return { stream: await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints }) };
        } catch (err) {
            console.warn('Camera+mic acquisition failed, trying mic only:', err);
            try {
                return { stream: await navigator.mediaDevices.getUserMedia({ audio: audioConstraints }), cameraDenied: true };
            } catch (err2) {
                console.warn('Mic-only acquisition failed:', err2);
                return { stream: null, cameraDenied: true, micDenied: true };
            }
        }
    }

    function onActiveSpeakersChanged(speakers) {
        const speakingIds = new Set(speakers.map(p => p.identity === state.myId ? 'me' : p.identity));
        document.querySelectorAll('.video-tile').forEach(t => {
            const id = t.id.replace(/^tile-/, '');
            t.classList.toggle('is-speaking', speakingIds.has(id));
        });
    }

    function onLiveKitDisconnected() {
        state.lkConnected = false;
        if (!state.intentionalLeave) {
            showToast('Media connection lost — attempting to reconnect...', 'error', 3000);
        }
    }

    // A remote (or our own screen-share) track became available to render.
    function onTrackSubscribed(track, publication, participant) {
        const isScreen = publication.source === LivekitClient.Track.Source.ScreenShare;
        const baseId = participant.identity;
        const tileId = isScreen ? `${baseId}-screen` : baseId;

        if (track.kind === LivekitClient.Track.Kind.Video) {
            const displayName = state.peerNames.get(baseId) || participant.name || 'Participant';
            const tile = addTile(tileId, isScreen ? `${displayName}'s screen` : displayName, false);
            const video = tile.querySelector('video');
            attachAndPlay(track, video);
            if (isScreen) {
                tile.classList.add('screen-tile');
                if (!state.localPinId) state.localPinId = tileId;
            }
            setTileCameraState(tileId, true);
            updateGridLayout();
        } else if (track.kind === LivekitClient.Track.Kind.Audio) {
            // Audio has no tile UI; attach to an off-screen element so it plays.
            track.attach();
        }
    }

    function onTrackUnsubscribed(track, publication, participant) {
        const isScreen = publication.source === LivekitClient.Track.Source.ScreenShare;
        const tileId = isScreen ? `${participant.identity}-screen` : participant.identity;
        track.detach();
        if (isScreen) {
            if (state.localPinId === tileId) state.localPinId = null;
            removeTile(tileId);
        }
        // Camera tiles stay (roster/host controls still show the person);
        // mark the feed off until a new track arrives.
        if (!isScreen) setTileCameraState(tileId, false);
    }

    function disconnectLiveKit() {
        if (state.lkRoom) {
            const room = state.lkRoom;
            state.lkRoom = null;
            state.lkConnected = false;
            state.lkIdentity = null;
            room.disconnect().catch(() => {});
        }
    }

    // Signaling
    function send(msg) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify(msg));
        }
    }

    async function handleMessage(data) {
        switch (data.type) {
            case 'joined':
                state.myId = data.id;
                if (state.callStartTime === null) state.callStartTime = Date.now();
                // Persist the server-issued, room-bound guest credential so a
                // page refresh can reconnect as the same guest and retrieve
                // private chat history. Never persist a client-generated ID.
                if (!token && data.guest_token) {
                    guestToken = data.guest_token;
                    sessionStorage.setItem(`meetly_guest_token_${room}`, guestToken);
                }
                state.isOwner = !!data.is_owner;
                state.hostSpotlightId = data.spotlight || null;
                state.mediaMode = data.media === 'livekit' ? 'livekit' : 'p2p';
                if (data.meeting_ticket) meetingTicket = data.meeting_ticket;

                if (state.isOwner && hostBadge) {
                    hostBadge.style.display = 'inline-flex';
                }

                setConnBadgeStatus('Connected', 'connected');

                // The server-issued guest credential now exists, so history can
                // be loaded immediately without waiting for camera permissions
                // or LiveKit/P2P media initialization.
                await loadChatHistory().catch(e => console.warn('Chat history load notice:', e));

                if (state.mediaMode === 'livekit') {
                    // Media (audio/video) flows through LiveKit's SFU; the
                    // roster below only updates presence/tiles metadata.
                    connectLiveKit().catch(err => {
                        console.error('LiveKit connect failed:', err);
                        showToast('Could not start video/audio: ' + err.message, 'error', 5000);
                    });
                } else {
                    // P2P mesh: TURN credentials are issued only after the
                    // server has authenticated this WebSocket as a legitimate
                    // room participant.
                    await addTurnServers(data.turn_ticket);
                    // Local media must exist before offers go out (tracks are
                    // added when each peer connection is created).
                    await initLocalStream();
                    data.peers.forEach(p => {
                        createPeer(p.id, p.name, true, !!p.is_owner);
                        state.peerHands.set(p.id, !!p.hand_raised);
                        state.peerForceMuted.set(p.id, !!p.host_muted);
                        state.peerCamForcedOff.set(p.id, !!p.host_cam_off);
                    });
                }
                // Roster metadata for both modes.
                if (state.mediaMode === 'livekit') {
                    data.peers.forEach(p => {
                        state.peerNames.set(p.id, p.name);
                        state.peerRoles.set(p.id, !!p.is_owner);
                        state.peerHands.set(p.id, !!p.hand_raised);
                        state.peerForceMuted.set(p.id, !!p.host_muted);
                        state.peerCamForcedOff.set(p.id, !!p.host_cam_off);
                    });
                }

                if (data.peers.length === 0) {
                    setConnBadgeStatus('Connected (Alone)', 'connected');
                } else {
                    setConnBadgeStatus(`${data.peers.length + 1} in call`, 'connected');
                }

                if (state.reconnecting) {
                    state.reconnecting = false;
                    state.reconnectAttempts = 0;
                    showToast('Reconnected to room', 'success');
                }
                updateChatTargetOptions();
                updateGridLayout();
                updatePeopleList();
                break;

            case 'peer-joined':
                showToast(`${data.name} joined`, 'info');
                if (state.mediaMode === 'p2p') {
                    createPeer(data.id, data.name, false, !!data.is_owner);
                } else {
                    // LiveKit brings the tracks; just keep roster metadata.
                    state.peerNames.set(data.id, data.name);
                    state.peerRoles.set(data.id, !!data.is_owner);
                }
                state.peerHands.set(data.id, !!data.hand_raised);
                state.peerForceMuted.set(data.id, !!data.host_muted);
                state.peerCamForcedOff.set(data.id, !!data.host_cam_off);
                setConnBadgeStatus(`${state.peerNames.size + 1} in call`, 'connected');
                updateChatTargetOptions();
                updatePeopleList();
                break;

            case 'offer': {
                const pcOffer = createPeer(data.from, data.from_name, false);
                if (!pcOffer) break;
                // Perfect-negotiation-lite: offers are normally only created by
                // the newcomer, but a near-simultaneous join can make both sides
                // initiate. Resolve the glare deterministically instead of
                // letting setRemoteDescription throw and kill the connection.
                const offerCollision = pcOffer._makingOffer || pcOffer.signalingState !== 'stable';
                const polite = String(state.myId) < String(data.from);
                if (offerCollision && !polite) break; // our offer wins; their answer will arrive
                (async () => {
                    try {
                        await pcOffer.setRemoteDescription(data.sdp); // implicit rollback if colliding
                        await pcOffer.setLocalDescription(await pcOffer.createAnswer());
                        send({ type: 'answer', to: data.from, sdp: pcOffer.localDescription });
                        flushPendingCandidates(pcOffer);
                    } catch (err) {
                        console.error('Failed to handle offer:', err);
                    }
                })();
                break;
            }

            case 'answer': {
                const pcAns = state.peers.get(data.from);
                if (!pcAns) break;
                pcAns.setRemoteDescription(data.sdp)
                    .then(() => flushPendingCandidates(pcAns))
                    .catch(console.error);
                break;
            }

            case 'ice-candidate': {
                if (!data.candidate) break;
                const pcIce = state.peers.get(data.from);
                bufferIceCandidate(pcIce, data.from, data.candidate);
                break;
            }

            case 'chat':
                if (data.private) {
                    // A DM sent to me — data.name is the sender
                    appendChat(data.name, data.text, false, null, { private: true, label: 'Private' });
                } else {
                    appendChat(data.name, data.text, false);
                }
                break;

            case 'kicked':
                state.intentionalLeave = true;
                disconnectLiveKit();
                alert(data.reason || 'You were removed from this room by the host.');
                sessionStorage.removeItem('meetly_room');
                window.location.href = '/index.html';
                break;

            case 'role-granted':
                // Host promoted me, OR I was auto-promoted because the room
                // creator left (see data.reason for which one happened).
                state.isOwner = true;
                if (hostBadge) {
                    hostBadge.style.display = 'inline-flex';
                }
                showToast(data.reason || 'You are now a host', data.reason ? 'info' : 'success', 4000);
                updatePeopleList();
                break;

            case 'role-revoked':
                state.isOwner = false;
                if (hostBadge) {
                    hostBadge.style.display = 'none';
                }
                showToast('Your host rights were removed', 'info');
                updatePeopleList();
                break;

            case 'role-update':
                // Someone else's host status changed
                state.peerRoles.set(data.id, !!data.is_owner);
                updatePeopleList();
                break;

            case 'mic-force-off':
                // Host muted my microphone. The server keeps enforcing this:
                // unmuting myself is rejected until a host allows me again.
                state.selfForceMuted = true;
                if (state.micOn) {
                    setMicState(false, false);
                    showToast('Host muted your microphone', 'error', 3000);
                }
                break;

            case 'mic-unmuted':
                // A host released the force-mute on me.
                state.selfForceMuted = false;
                setMicState(true, false);
                showToast('A host allowed your microphone', 'success', 3000);
                break;

            case 'cam-force-off':
                // Host turned off my camera. Also enforced server-side.
                state.selfCamForcedOff = true;
                if (state.camOn) {
                    setCamState(false, false);
                    showToast('Host turned off your camera', 'error', 3000);
                }
                break;

            case 'cam-unmuted':
                // A host released the forced camera-off on me.
                state.selfCamForcedOff = false;
                setCamState(true, false);
                showToast('A host turned your camera back on', 'success', 3000);
                break;

            case 'peer-mic-state':
                setTileMicState(data.id, !!data.on);
                if ('forced' in data) state.peerForceMuted.set(data.id, !!data.forced);
                updatePeopleList();
                break;

            case 'peer-cam-state':
                setTileCameraState(data.id, !!data.on);
                if ('forced' in data) state.peerCamForcedOff.set(data.id, !!data.forced);
                updatePeopleList();
                break;

            case 'peer-hand-state':
                state.peerHands.set(data.id, !!data.on);
                setTileHandState(data.id, !!data.on);
                if (data.on) {
                    showToast(`${state.peerNames.get(data.id) || 'Someone'} raised their hand`, 'info', 2500);
                }
                updatePeopleList();
                break;

            case 'reaction':
                showFloatingEmoji(data.id || data.from, data.emoji);
                break;

            case 'spotlight-update':
                state.hostSpotlightId = data.id || null;
                updateGridLayout();
                if (data.id && data.id !== state.myId) {
                    showToast(`${state.peerNames.get(data.id) || 'A participant'} was spotlighted`, 'info', 2000);
                }
                break;

            case 'peer-left':
                const leavingName = state.peerNames.get(data.id);
                // Only announce peers we actually had a tile for: a peer-left
                // for an unknown id (e.g. a stale entry reaped at join time)
                // shouldn't produce a confusing "A participant left" toast.
                if (leavingName) showToast(`${leavingName} left`, 'info');
                closePeer(data.id);
                break;

            case 'peer-count':
                if (data.count <= 1) {
                    setConnBadgeStatus('Connected (Alone)', 'connected');
                } else {
                    setConnBadgeStatus(`${data.count} in call`, 'connected');
                }
                break;

            case 'ping':
                // Server heartbeat: answer so a half-open socket isn't counted
                // as a participant (the server evicts after two missed probes).
                send({ type: 'pong' });
                break;
        }
    }

    // Raised-hand tile badge
    function setTileHandState(id, on) {
        const tile = document.getElementById('tile-' + id);
        const badge = tile?.querySelector('.tile-hand-badge');
        if (badge) badge.style.display = on ? 'flex' : 'none';
    }

    // Floating emoji reaction animation, anchored over the sender's tile
    // (or centered on the stage if we can't find it, e.g. reactions overlay).
    function showFloatingEmoji(fromId, emoji) {
        if (!reactionOverlay || !emoji) return;
        const tile = fromId ? document.getElementById('tile-' + fromId) : null;
        const span = document.createElement('span');
        span.className = 'floating-emoji';
        span.textContent = emoji;

        const stageRect = reactionOverlay.getBoundingClientRect();
        let left = stageRect.width / 2, bottom = 16;
        if (tile) {
            const r = tile.getBoundingClientRect();
            left = r.left - stageRect.left + r.width / 2 + (Math.random() * 30 - 15);
            bottom = stageRect.bottom - r.bottom + 16;
        }
        span.style.left = `${left}px`;
        span.style.bottom = `${bottom}px`;

        reactionOverlay.appendChild(span);
        setTimeout(() => span.remove(), 1900);
    }

    // Chat Management
    function appendChat(fromName, text, self, timeStr = null, opts = {}) {
        const time = timeStr || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const isPrivate = !!opts.private;
        const div = document.createElement('div');
        div.className = 'chat-msg ' + (self ? 'chat-msg-self' : 'chat-msg-received');

        const privateTag = isPrivate
            ? `<span class="chat-private-tag">${escapeHtml(opts.label || 'Private')}</span>`
            : '';

        const meta = `
            <div class="chat-meta">
                <span class="chat-sender">${escapeHtml(self ? 'You' : fromName)}</span>
                ${privateTag}
                <span>&bull;</span>
                <span class="chat-meta-time">${time}</span>
            </div>`;

        const bubbleClass = isPrivate
            ? (self ? 'chat-bubble chat-bubble-sent chat-bubble-private-sent'
                    : 'chat-bubble chat-bubble-received chat-bubble-private-received')
            : (self ? 'chat-bubble chat-bubble-sent'
                    : 'chat-bubble chat-bubble-received');

        div.innerHTML = `${meta}<div class="${bubbleClass}">${escapeHtml(text)}</div>`;

        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        if (!state.drawerOpen || state.activeDrawerTab !== 'chat') {
            state.unreadCount++;
            if (unreadBadge) {
                unreadBadge.textContent = state.unreadCount > 9 ? '9+' : state.unreadCount;
                unreadBadge.style.display = 'flex';
            }
        }
    }

    function sendChat() {
        const text = chatInput.value.trim();
        if (!text) return;

        const targetId = chatTargetSelect ? chatTargetSelect.value : '';
        if (targetId) {
            const targetName = state.peerNames.get(targetId) || 'them';
            appendChat(name, text, true, null, { private: true, label: `to ${targetName}` });
            send({ type: 'chat', text, to: targetId });
        } else {
            appendChat(name, text, true);
            send({ type: 'chat', text });
        }
        chatInput.value = '';
    }

    if (chatTargetSelect) {
        chatTargetSelect.addEventListener('change', () => {
            state.dmTarget = chatTargetSelect.value;
            if (chatInput) {
                chatInput.placeholder = chatTargetSelect.value
                    ? `Message ${chatTargetSelect.options[chatTargetSelect.selectedIndex].textContent}...`
                    : 'Send a message...';
            }
        });
    }

    // People List Generator with Host Controls
    function updatePeopleList() {
        if (!peopleList) return;
        const total = (state.mediaMode === 'livekit' ? state.peerNames.size : state.peers.size) + 1;
        if (peopleCountPill) peopleCountPill.textContent = total;

        peopleList.innerHTML = `
            <!-- Self -->
            <div class="people-row is-own-row">
                <div class="people-row-main">
                    <div class="people-avatar">${escapeHtml((name || 'U').substring(0, 2).toUpperCase())}</div>
                    <div class="people-name">
                        <span>${escapeHtml(name)}</span>
                        <span class="people-badge">You</span>
                        ${state.isOwner ? '<span class="people-badge host">Host</span>' : ''}
                    </div>
                </div>
                <div class="people-state">
                    <span>${state.micOn ? '🎙️' : '🔇'}</span>
                    <span>${state.camOn ? '📹' : '🚫'}</span>
                </div>
            </div>
        `;

        state.peerNames.forEach((peerName, peerId) => {
            const isPeerHost = state.peerRoles.get(peerId);
            const handUp = state.peerHands.get(peerId);
            const isSpotlit = state.hostSpotlightId === peerId;
            const forceMuted = !!state.peerForceMuted.get(peerId);
            const camForcedOff = !!state.peerCamForcedOff.get(peerId);
            const item = document.createElement('div');
            item.className = 'people-row';

            let controls = '';
            if (state.isOwner) {
                controls = `
                    <div class="people-actions">
                        <button class="host-action-btn spotlight-btn" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="${isSpotlit ? 'Remove spotlight' : 'Spotlight for everyone'}">
                            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5"/></svg>
                        </button>
                        ${isPeerHost ? `
                        <button class="host-action-btn role demote-host-btn" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="Remove host rights">
                            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"/></svg>
                        </button>` : `
                        <button class="host-action-btn role make-host-btn" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="Make host">
                            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                        </button>`}
                        <button class="host-action-btn danger mute-mic-btn" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="${forceMuted ? 'Allow microphone' : 'Mute microphone'}">
                            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-14 0m7 7v4m-4 0h8M9 9V5a3 3 0 016 0v4"/></svg>
                        </button>
                        <button class="host-action-btn danger disable-cam-btn" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="${camForcedOff ? 'Turn camera back on' : 'Turn off camera'}">
                            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                        </button>
                        <button class="host-action-btn danger kick-btn" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="Remove participant">
                            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7a4 4 0 11-8 0 4 4 0 018 0zM9 14a6 6 0 00-6 6v1h12v-1a6 6 0 00-6-6zM21 12h-6"/></svg>
                        </button>
                    </div>`;
            } else {
                controls = `<span class="people-dot"></span>`;
            }

            item.innerHTML = `
                <div class="people-row-main">
                    <div class="people-avatar">${escapeHtml((peerName || 'P').substring(0, 2).toUpperCase())}</div>
                    <div class="people-name">
                        <span>${escapeHtml(peerName)}</span>
                        ${handUp ? '<span title="Hand raised">✋</span>' : ''}
                        ${isPeerHost ? '<span class="people-badge host">Host</span>' : ''}
                    </div>
                </div>
                ${controls}
            `;
            peopleList.appendChild(item);
        });

        if (state.isOwner) {
            peopleList.querySelectorAll('.kick-btn').forEach(btn => {
                btn.addEventListener('click', () => kickParticipant(btn.dataset.id, btn.dataset.name));
            });
            peopleList.querySelectorAll('.make-host-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (!confirm(`Make ${btn.dataset.name} a host?`)) return;
                    send({ type: 'make-host', target_id: btn.dataset.id });
                    showToast(`Promoted ${btn.dataset.name} to host`, 'success');
                });
            });
            peopleList.querySelectorAll('.demote-host-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (!confirm(`Remove host rights from ${btn.dataset.name}?`)) return;
                    send({ type: 'demote-host', target_id: btn.dataset.id });
                    showToast(`Removed host rights from ${btn.dataset.name}`, 'info');
                });
            });
            peopleList.querySelectorAll('.spotlight-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const alreadySpotlit = state.hostSpotlightId === btn.dataset.id;
                    send({ type: 'spotlight', target_id: alreadySpotlit ? null : btn.dataset.id });
                });
            });
            peopleList.querySelectorAll('.mute-mic-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    // Server toggles: mutes if audible, releases if force-muted.
                    const releasing = !!state.peerForceMuted.get(btn.dataset.id);
                    if (!confirm(releasing ? `Allow ${btn.dataset.name}'s microphone?` : `Mute ${btn.dataset.name}'s microphone?`)) return;
                    send({ type: 'mute-mic', target_id: btn.dataset.id });
                    showToast(releasing ? `Allowed ${btn.dataset.name}'s microphone` : `Muted ${btn.dataset.name}`, 'info');
                });
            });
            peopleList.querySelectorAll('.disable-cam-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const releasing = !!state.peerCamForcedOff.get(btn.dataset.id);
                    if (!confirm(releasing ? `Turn ${btn.dataset.name}'s camera back on?` : `Turn off ${btn.dataset.name}'s camera?`)) return;
                    send({ type: 'disable-cam', target_id: btn.dataset.id });
                    showToast(releasing ? `Turned ${btn.dataset.name}'s camera back on` : `Turned off ${btn.dataset.name}'s camera`, 'info');
                });
            });
        }
    }

    // Populate the "send to" dropdown in the chat panel from current peers
    function updateChatTargetOptions() {
        if (!chatTargetSelect) return;
        const prevValue = state.dmTarget;
        chatTargetSelect.innerHTML = '<option value="">Everyone</option>';
        state.peerNames.forEach((peerName, peerId) => {
            const opt = document.createElement('option');
            opt.value = peerId;
            opt.textContent = peerName;
            chatTargetSelect.appendChild(opt);
        });
        // Keep the previous selection if that peer is still in the room,
        // otherwise fall back to Everyone.
        if (prevValue && state.peerNames.has(prevValue)) {
            chatTargetSelect.value = prevValue;
            state.dmTarget = prevValue;
        } else {
            chatTargetSelect.value = '';
            state.dmTarget = '';
        }
    }

    // Controls Logic
    function setMicState(on, announce = true) {
        state.micOn = on;
        if (state.lkRoom) {
            // LiveKit mode: mute at the publisher so every subscriber sees it.
            state.lkRoom.localParticipant.setMicrophoneEnabled(on).then(() => {
                // Enabling may have had to acquire the mic fresh; a failure
                // leaves us muted — reflect that instead of trusting the toggle.
                if (on) {
                    const pub = state.lkRoom?.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
                    if (!pub || !pub.track) {
                        state.micOn = false;
                        showToast('Microphone could not be started', 'error', 3000);
                        updatePeopleList();
                    }
                }
            }).catch(err => {
                console.warn('setMicrophoneEnabled failed:', err);
                state.micOn = false;
                if (on) showToast('Microphone could not be started', 'error', 3000);
                updatePeopleList();
            });
        } else if (state.localStream) {
            state.localStream.getAudioTracks().forEach(t => t.enabled = on);
        }
        const micBtn = document.getElementById('mic-btn');
        const iconOn = document.getElementById('mic-icon-on');
        const iconOff = document.getElementById('mic-icon-off');
        if (micBtn && iconOn && iconOff) {
            if (on) {
                micBtn.classList.remove('active');
                iconOn.style.display = 'block';
                iconOff.style.display = 'none';
            } else {
                micBtn.classList.add('active');
                iconOn.style.display = 'none';
                iconOff.style.display = 'block';
            }
        }
        setTileMicState('me', on);
        if (announce) send({ type: 'mic-state', on });
        updatePeopleList();
    }

    function setCamState(on, announce = true) {
        state.camOn = on;
        if (state.lkRoom) {
            state.lkRoom.localParticipant.setCameraEnabled(on).then(() => {
                const pub = state.lkRoom?.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
                if (on && (!pub || !pub.track)) {
                    // Enabling failed to produce a track (denied earlier or
                    // device gone) — show the avatar, not a black tile.
                    state.camOn = false;
                    setTileCameraState('me', false);
                    send({ type: 'cam-state', on: false });
                    showToast('Camera could not be started', 'error', 3000);
                    updatePeopleList();
                } else if (on && pub && pub.track) {
                    setTileCameraState('me', true);
                    // A re-enable can hand back a fresh track — re-attach so
                    // the local tile keeps showing it.
                    const video = document.getElementById('tile-me')?.querySelector('video');
                    if (video) attachAndPlay(pub.track, video);
                }
            }).catch(err => {
                console.warn('setCameraEnabled failed:', err);
                state.camOn = false;
                setTileCameraState('me', false);
                if (on) showToast('Camera could not be started', 'error', 3000);
                updatePeopleList();
            });
        } else if (state.localStream) {
            state.localStream.getVideoTracks().forEach(t => t.enabled = on);
        }
        const camBtn = document.getElementById('cam-btn');
        const iconOn = document.getElementById('cam-icon-on');
        const iconOff = document.getElementById('cam-icon-off');
        if (camBtn && iconOn && iconOff) {
            if (on) {
                camBtn.classList.remove('active');
                iconOn.style.display = 'block';
                iconOff.style.display = 'none';
            } else {
                camBtn.classList.add('active');
                iconOn.style.display = 'none';
                iconOff.style.display = 'block';
            }
        }
        setTileCameraState('me', on);
        if (announce) send({ type: 'cam-state', on });
        updatePeopleList();
    }

    function toggleMic() {
        if (state.selfForceMuted && !state.micOn) {
            showToast('A host muted you — ask them to allow your microphone', 'error', 3000);
            return;
        }
        setMicState(!state.micOn);
        showToast(state.micOn ? 'Microphone unmuted' : 'Microphone muted', 'info', 1500);
    }

    function toggleCam() {
        if (state.selfCamForcedOff && !state.camOn) {
            showToast('A host turned off your camera — ask them to enable it', 'error', 3000);
            return;
        }
        setCamState(!state.camOn);
        showToast(state.camOn ? 'Camera turned on' : 'Camera turned off', 'info', 1500);
    }

    // Screen Sharing
    // Camera-less participants have no sendable video sender — but they DO
    // have the recvonly video transceiver stored at pc._screenPromotable by
    // createPeer. Promoting it to sendrecv and replacing its sender's track
    // switches the connection into a screen-sending one; the direction change
    // fires a renegotiation delivered as a normal offer through the relay.
    async function promoteSendVideo(pc, remoteId, track) {
        const transceiver = pc._screenPromotable;
        if (!transceiver) return;
        try {
            transceiver.direction = 'sendrecv';
            await transceiver.sender.replaceTrack(track);
            if (pc.signalingState === 'stable') {
                pc._makingOffer = true;
                try {
                    await pc.setLocalDescription(await pc.createOffer());
                    send({ type: 'offer', to: remoteId, sdp: pc.localDescription });
                } finally {
                    pc._makingOffer = false;
                }
            } else {
                console.warn('Cannot renegotiate screen share for peer', remoteId, '— signaling not stable');
            }
        } catch (err) {
            console.error('Screen share (promoted sender) failed for peer', remoteId, ':', err);
        }
    }

    async function toggleScreenShare() {
        if (state.mediaMode === 'livekit') {
            await toggleScreenShareLiveKit();
            return;
        }
        const screenBtn = document.getElementById('screen-btn');

        if (state.isScreenSharing) {
            stopScreenShare();
            return;
        }

        try {
            state.screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always' },
                audio: false
            });

            state.isScreenSharing = true;
            if (screenBtn) screenBtn.className = 'dock-btn dock-btn-sharing';
            showToast('Screen sharing started', 'success');

            const screenTrack = state.screenStream.getVideoTracks()[0];
            const myTile = document.getElementById('tile-me');
            if (myTile) {
                myTile.classList.add('screen-tile');
                const video = myTile.querySelector('video');
                video.srcObject = state.screenStream;
            }

            state.peers.forEach((pc, remoteId) => {
                const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (videoSender) {
                    videoSender.replaceTrack(screenTrack);
                } else {
                    promoteSendVideo(pc, remoteId, screenTrack);
                }
            });

            screenTrack.onended = () => {
                stopScreenShare();
            };
        } catch (err) {
            console.log('Screen share notice:', err);
            stopScreenShare();
        }
    }

    // LiveKit mode: the screen share is published as a separate ScreenShare
    // source, so it arrives as its own tile for everyone (instead of replacing
    // the camera feed the way the P2P mesh has to).
    async function toggleScreenShareLiveKit() {
        if (!state.lkRoom) return;
        const screenBtn = document.getElementById('screen-btn');

        if (state.isScreenSharing) {
            await stopScreenShareLiveKit();
            return;
        }

        try {
            // contentHint 'detail' tells the encoder this is text/graphics:
            // preserve sharpness instead of optimizing for motion.
            await state.lkRoom.localParticipant.setScreenShareEnabled(true, { audio: false, contentHint: 'detail' });
            state.isScreenSharing = true;
            if (screenBtn) screenBtn.className = 'dock-btn dock-btn-sharing';
            showToast('Screen sharing started', 'success');

            const screenPub = state.lkRoom.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
            if (screenPub && screenPub.track) {
                const tile = addTile('me-screen', `${name}'s screen`, false);
                screenPub.track.attach(tile.querySelector('video'));
                tile.classList.add('screen-tile');
                state.localPinId = 'me-screen';
                updateGridLayout();
                // Browser's native "Stop sharing" button
                screenPub.track.mediaStreamTrack.onended = () => stopScreenShareLiveKit();
            }
        } catch (err) {
            console.log('Screen share notice:', err);
            state.isScreenSharing = false;
            if (screenBtn) screenBtn.className = 'dock-btn';
        }
    }

    async function stopScreenShareLiveKit() {
        if (!state.isScreenSharing || !state.lkRoom) return;
        state.isScreenSharing = false;

        const screenBtn = document.getElementById('screen-btn');
        if (screenBtn) screenBtn.className = 'dock-btn';

        await state.lkRoom.localParticipant.setScreenShareEnabled(false).catch(() => {});
        if (state.localPinId === 'me-screen') state.localPinId = null;
        removeTile('me-screen');
        showToast('Screen sharing stopped', 'info');
    }

    function stopScreenShare() {
        if (!state.isScreenSharing) return;
        state.isScreenSharing = false;

        const screenBtn = document.getElementById('screen-btn');
        if (screenBtn) screenBtn.className = 'dock-btn';

        if (state.screenStream) {
            state.screenStream.getTracks().forEach(t => t.stop());
            state.screenStream = null;
        }

        const myTile = document.getElementById('tile-me');
        if (myTile) {
            myTile.classList.remove('screen-tile');
            const video = myTile.querySelector('video');
            if (video) video.srcObject = state.localStream;
        }

        // localStream may be null when the user has no camera permission.
        const camTrack = state.localStream ? state.localStream.getVideoTracks()[0] : null;
        state.peers.forEach((pc, remoteId) => {
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!videoSender) return;
            videoSender.replaceTrack(camTrack || null);
            if (camTrack) return;
            // There was no camera track to restore: this screen was flowing on
            // the transceiver promoted in promoteSendVideo — demote it back to
            // recvonly and renegotiate so peers stop rendering a frozen screen.
            const transceiver = pc._screenPromotable;
            if (transceiver && transceiver.direction === 'sendrecv') {
                transceiver.direction = 'recvonly';
                if (pc.signalingState === 'stable') {
                    pc._makingOffer = true;
                    pc.setLocalDescription(pc.createOffer())
                        .then(() => send({ type: 'offer', to: remoteId, sdp: pc.localDescription }))
                        .catch(console.error)
                        .finally(() => { pc._makingOffer = false; });
                }
            }
        });
        setTileCameraState('me', state.camOn);
        showToast('Screen sharing stopped', 'info');
    }

    // Side Drawer Controls
    function toggleDrawer(tab = 'chat') {
        if (state.drawerOpen && state.activeDrawerTab === tab) {
            closeDrawer();
        } else {
            openDrawer(tab);
        }
    }

    function openDrawer(tab = 'chat') {
        state.drawerOpen = true;
        state.activeDrawerTab = tab;
        sideDrawer.classList.add('open');

        const chatTab = document.getElementById('drawer-tab-chat');
        const peopleTab = document.getElementById('drawer-tab-people');
        const chatView = document.getElementById('drawer-view-chat');
        const peopleView = document.getElementById('drawer-view-people');

        if (tab === 'chat') {
            chatTab.classList.add('active');
            peopleTab.classList.remove('active');
            chatView.style.display = 'flex';
            peopleView.style.display = 'none';
            state.unreadCount = 0;
            if (unreadBadge) unreadBadge.style.display = 'none';
            setTimeout(() => chatInput?.focus(), 150);
        } else {
            peopleTab.classList.add('active');
            chatTab.classList.remove('active');
            peopleView.style.display = 'flex';
            chatView.style.display = 'none';
            updatePeopleList();
        }
    }

    function closeDrawer() {
        state.drawerOpen = false;
        sideDrawer.classList.remove('open');
    }

    function setConnBadgeStatus(text, status = 'connected') {
        if (connStatusText) connStatusText.textContent = text;
        // The dot actually reflects the state now — previously it stayed
        // hardcoded green even while the text read "Access Denied".
        const dot = document.querySelector('#conn-badge .conn-dot');
        if (!dot) return;
        const STATUS_COLORS = {
            connected: '#2E7D32',
            warning: '#D9A64B',
            error: 'var(--danger)',
            offline: 'var(--fg-tertiary)',
        };
        dot.style.backgroundColor = STATUS_COLORS[status] || STATUS_COLORS.offline;
        dot.classList.toggle('pulse', status === 'connected' || status === 'warning');
    }

    // WebSocket Lifecycle
    function connectWebSocket() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        state.ws = new WebSocket(`${proto}://${location.host}/ws/${room}`);

        state.ws.onopen = () => {
            // Read the credential at connection time. refreshSession() may have
            // rotated the access token since this script was initialized.
            const currentToken = API.getToken();
            if (currentToken) {
                state.ws.send(JSON.stringify({ type: 'auth', token: currentToken, connection_id: connectionId }));
            } else {
                state.ws.send(JSON.stringify({ type: 'auth', guest_name: name, connection_id: connectionId, ...(guestToken ? { guest_token: guestToken } : {}) }));
            }
        };

        // Serialize message handling: several cases await (LiveKit connect,
        // stream init), and interleaved handlers could process 'peer-joined'
        // before local media is ready or out of order with roster updates.
        let handleQueue = Promise.resolve();
        state.ws.onmessage = (e) => {
            handleQueue = handleQueue
                .then(() => handleMessage(JSON.parse(e.data)))
                .catch(console.error);
        };

        state.ws.onclose = (event) => {
            if (state.intentionalLeave) return;

            // 4000 is an intentional server-side replacement of this tab's
            // stale connection (normally caused by a refresh/reconnect). Do
            // not reconnect the old socket or two tabs can fight indefinitely.
            if (event.code === 4000) {
                setConnBadgeStatus('Replaced', 'error');
                return;
            }

            if (event.code >= 4400 && event.code < 4500) {
                setConnBadgeStatus('Access Denied', 'error');
                showToast('Unable to connect: ' + (event.reason || 'Authentication failed'), 'error', 5000);
                // A room invite must remain usable for guests. Discard only the
                // room-scoped guest credential when the server rejects it.
                if (!API.getToken()) {
                    sessionStorage.removeItem(`meetly_guest_token_${room}`);
                    guestToken = null;
                    if (guestModal) {
                        guestModal.classList.add('open');
                        guestNameInput?.focus();
                    }
                }
                return;
            }

            setConnBadgeStatus('Reconnecting...', 'warning');
            attemptReconnect();
        };
    }

    function attemptReconnect() {
        if (state.intentionalLeave) return;
        if (state.reconnectAttempts >= state.maxReconnectAttempts) {
            setConnBadgeStatus('Disconnected', 'error');
            showToast('Connection lost. Please rejoin the call.', 'error');
            return;
        }

        state.reconnecting = true;
        state.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 20000);
        showToast(`Reconnecting (Attempt ${state.reconnectAttempts})...`, 'info', 2000);

        setTimeout(() => {
            closeAllPeers();
            connectWebSocket();
        }, delay);
    }

    // Leave Call
    function leaveCall() {
        state.intentionalLeave = true;
        send({ type: 'leave' });
        disconnectLiveKit();
        state.peers.forEach(pc => pc.close());
        state.peers.clear();
        state.localStream?.getTracks().forEach(t => t.stop());
        state.screenStream?.getTracks().forEach(t => t.stop());
        state.ws?.close();
        sessionStorage.removeItem('meetly_room');
        window.location.href = API.getToken() ? '/dashboard.html' : '/index.html';
    }

    window.addEventListener('beforeunload', () => {
        state.intentionalLeave = true;
        send({ type: 'leave' });
        disconnectLiveKit();
        state.localStream?.getTracks().forEach(t => t.stop());
        state.screenStream?.getTracks().forEach(t => t.stop());
    });

    // Share link copy function
    function copyShareLink() {
        const shareUrl = `${window.location.origin}/room.html?room=${room}`;
        copyToClipboard(shareUrl, `Invite link for room "${room}" copied!`);
    }

    // Event Bindings
    document.getElementById('mic-btn')?.addEventListener('click', toggleMic);
    document.getElementById('cam-btn')?.addEventListener('click', toggleCam);
    document.getElementById('screen-btn')?.addEventListener('click', toggleScreenShare);
    document.getElementById('leave-btn')?.addEventListener('click', leaveCall);
    document.getElementById('header-leave-btn')?.addEventListener('click', leaveCall);

    document.getElementById('chat-drawer-btn')?.addEventListener('click', () => toggleDrawer('chat'));
    document.getElementById('people-drawer-btn')?.addEventListener('click', () => toggleDrawer('people'));
    document.getElementById('close-drawer-btn')?.addEventListener('click', closeDrawer);
    document.getElementById('drawer-tab-chat')?.addEventListener('click', () => openDrawer('chat'));
    document.getElementById('drawer-tab-people')?.addEventListener('click', () => openDrawer('people'));

    document.getElementById('chat-send')?.addEventListener('click', sendChat);
    document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendChat();
    });

    document.getElementById('header-share-btn')?.addEventListener('click', copyShareLink);
    document.getElementById('drawer-share-btn')?.addEventListener('click', copyShareLink);
    document.getElementById('empty-copy-btn')?.addEventListener('click', copyShareLink);
    document.getElementById('copy-room-pill')?.addEventListener('click', copyShareLink);

    // Reactions: raise hand + quick emoji popover
    const reactionsBtn = document.getElementById('reactions-btn');
    const reactionsPopover = document.getElementById('reactions-popover');
    const raiseHandBtn = document.getElementById('raise-hand-btn');
    const raiseHandLabel = document.getElementById('raise-hand-label');

    reactionsBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        reactionsPopover?.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
        if (reactionsPopover?.classList.contains('open') &&
            !reactionsPopover.contains(e.target) && e.target !== reactionsBtn) {
            reactionsPopover.classList.remove('open');
        }
    });

    raiseHandBtn?.addEventListener('click', () => {
        state.handRaised = !state.handRaised;
        send({ type: 'hand-raise', on: state.handRaised });
        setTileHandState('me', state.handRaised);
        if (raiseHandLabel) raiseHandLabel.textContent = state.handRaised ? 'Lower Hand' : 'Raise Hand';
        raiseHandBtn.classList.toggle('active', state.handRaised);
        showToast(state.handRaised ? 'You raised your hand' : 'You lowered your hand', 'info', 1800);
        updatePeopleList();
    });

    document.querySelectorAll('.reaction-emoji-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const emoji = btn.dataset.emoji;
            send({ type: 'reaction', emoji });
            showFloatingEmoji('me', emoji); // show it over our own tile immediately
            reactionsPopover?.classList.remove('open');
        });
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
        if (document.activeElement === chatInput || document.activeElement === guestNameInput) return;
        // Never hijack the key when a browser/system modifier combo is in play
        // (e.g. ⌘V paste, Ctrl+C behind a selection, Alt-Tab focus tricks).
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'm' || e.key === 'M') toggleMic();
        if (e.key === 'v' || e.key === 'V') toggleCam();
        if (e.key === 'c' || e.key === 'C') toggleDrawer('chat');
    });

    // Initial Chat History
    async function loadChatHistory() {
        try {
            // Guest credentials are sent in the Authorization header, never in
            // the URL, so they are not exposed through browser history or URL logs.
            const currentToken = API.getToken();
            const options = (!currentToken && guestToken)
                ? { headers: { Authorization: `Bearer ${guestToken}` } }
                : {};
            const msgs = await apiFetch(`/rooms/${room}/messages`, options);
            if (msgs && msgs.length > 0) {
                chatMessages.innerHTML = '';
                msgs.forEach(m => {
                    const isSelf = Boolean(m.is_self);
                    const time = m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
                    if (m.is_private) {
                        const label = isSelf ? `to ${m.to_name || 'someone'}` : 'Private';
                        appendChat(m.username, m.text, isSelf, time, { private: true, label });
                    } else {
                        appendChat(m.username, m.text, isSelf, time);
                    }
                });
            }
        } catch (err) {
            console.log('Chat history notice:', err);
        }
    }

    async function startCallSession() {
        try {
            // Roll the session forward BEFORE anything reads the stored token,
            // so chat history and the WebSocket don't authenticate with a
            // possibly-expired access token.
            await refreshSession();
            token = API.getToken();
            user = API.getUser();
            if (token && user?.username) name = user.username;
            // Chat history is loaded after the WebSocket 'joined' message so a
            // first-time guest already has its server-issued room credential.
            // Media init happens once the WS 'joined' message tells us which
            // transport the server chose: connectLiveKit() (SFU) or
            // initLocalStream() (P2P mesh), both from the 'joined' case.
            connectWebSocket();
        } catch (err) {
            console.error('Error starting call session:', err);
            connectWebSocket();
        }
    }

    // Bootstrap: check if logged in or guest
    if (!token && !name) {
        // Show guest modal to ask for display name
        if (guestModal) {
            guestModal.classList.add('open');
            setTimeout(() => guestNameInput?.focus(), 150);

            document.getElementById('guest-join-btn')?.addEventListener('click', () => {
                const inputName = guestNameInput.value.trim();
                name = inputName || `Guest_${Math.floor(1000 + Math.random() * 9000)}`;
                sessionStorage.setItem('meetly_guest_name', name);
                guestModal.classList.remove('open');
                startCallSession();
            });

            guestNameInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    document.getElementById('guest-join-btn')?.click();
                }
            });
        }
    } else {
        startCallSession();
    }
})();
