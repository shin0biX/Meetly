// Meetly room client: WebRTC mesh + WebSocket signaling + chat + screen share + host controls + guest support
(() => {
    // 1) Extract room code from URL param or sessionStorage
    const urlParams = new URLSearchParams(window.location.search);
    let room = (urlParams.get('room') || sessionStorage.getItem('meetly_room') || '').toLowerCase().trim();

    if (!room) {
        window.location.href = '/dashboard.html';
        return;
    }

    sessionStorage.setItem('meetly_room', room);

    // Set UI room labels
    const roomCodeLabel = document.getElementById('room-code-label');
    if (roomCodeLabel) roomCodeLabel.textContent = room;
    const modalRoomCodeTag = document.getElementById('modal-room-code-tag');
    if (modalRoomCodeTag) modalRoomCodeTag.textContent = room;

    const token = API.getToken();
    const user = API.getUser();
    let name = (token && user && user.username) ? user.username : (sessionStorage.getItem('meetly_guest_name') || '');
    // Display names are not identities. Guests get a random ID that survives
    // refreshes within this browser session and is used only for authorization.
    let guestToken = null;
    if (!token) {
        guestToken = sessionStorage.getItem('meetly_guest_token');
    }

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
            if (t && t.url && t.username && t.credential) {
                CONFIG.iceServers.push({
                    urls: t.url,
                    username: t.username,
                    credential: t.credential,
                });
                turnConfigured = true;
                console.log('TURN configured:', t.url);
            }
        } catch (err) {
            console.warn('TURN unavailable:', err.message);
        }
    }

    const state = {
        ws: null,
        myId: null,
        isOwner: false,
        localStream: null,
        screenStream: null,
        isScreenSharing: false,
        peers: new Map(),     // remoteId -> RTCPeerConnection
        peerNames: new Map(), // remoteId -> name
        peerRoles: new Map(), // remoteId -> isOwner (bool)
        peerHands: new Map(), // remoteId -> hand raised (bool)
        micOn: true,
        camOn: true,
        reconnectAttempts: 0,
        maxReconnectAttempts: 10,
        reconnecting: false,
        intentionalLeave: false,
        callStartTime: Date.now(),
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

    // Call Timer
    setInterval(() => {
        const elapsed = Math.floor((Date.now() - state.callStartTime) / 1000);
        const hrs = Math.floor(elapsed / 3600);
        const mins = Math.floor((elapsed % 3600) / 60);
        const secs = elapsed % 60;
        if (callTimerEl) {
            callTimerEl.textContent = 
                (hrs > 0 ? String(hrs).padStart(2, '0') + ':' : '') +
                String(mins).padStart(2, '0') + ':' +
                String(secs).padStart(2, '0');
        }
    }, 1000);

    // Dynamic Grid Layout Updater
    function updateGridLayout() {
        const tiles = Array.from(grid.querySelectorAll('.video-tile'));
        const count = tiles.length;

        // Local pin (manual, per-viewer) always wins over the host's spotlight.
        const pinnedId = state.localPinId || state.hostSpotlightId;
        const pinnedTile = pinnedId ? document.getElementById('tile-' + pinnedId) : null;

        if (pinnedTile && count > 1) {
            grid.className = 'w-full h-full max-h-full grid-pinned';
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

            grid.className = 'w-full h-full max-h-full grid gap-3 sm:gap-4 items-center justify-center auto-rows-fr ';
            if (count <= 1) {
                grid.classList.add('grid-1');
            } else if (count === 2) {
                grid.classList.add('grid-2');
            } else {
                grid.classList.add('grid-multi');
            }

            if (count <= 1) {
                emptyHint?.classList.remove('hidden');
            } else {
                emptyHint?.classList.add('hidden');
            }
        }
        updatePeopleList();
    }

    // Local Media Initialization
    async function initLocalStream() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error(
                'Camera/microphone unavailable. This page must be opened over HTTPS (or localhost).'
            );
        }

        state.localStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        const tile = addTile('me', name, true);
        const video = tile.querySelector('video');
        video.srcObject = state.localStream;
        video.muted = true;
        await video.play().catch(() => {});
        setupAudioAnalyser(state.localStream, 'me');
        updateGridLayout();
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

            <div class="avatar-fallback hidden absolute inset-0 flex flex-col items-center justify-center bg-slate-900 z-10">
                <div class="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gradient-to-tr from-brand-600 to-cyan-500 text-white font-extrabold text-xl sm:text-2xl flex items-center justify-center shadow-xl shadow-brand-500/20">
                    ${escapeHtml(initials)}
                </div>
            </div>

            <span class="tile-hand-badge hidden">✋</span>

            <div class="tile-controls">
                <button class="tile-icon-btn tile-pin-btn" data-id="${id}" title="Pin / fullscreen">
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5M9 15v4.5M9 15H4.5M9 15l-5.5 5.5M15 15h4.5M15 15v4.5m0-4.5l5.5 5.5"/></svg>
                </button>
                <button class="tile-icon-btn tile-fullscreen-btn" data-id="${id}" title="Fullscreen">
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
                </button>
            </div>

            <div class="absolute bottom-3 left-3 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-950/75 backdrop-blur-md border border-white/10 text-white text-xs font-medium max-w-[80%]">
                <span class="truncate">${escapeHtml(displayName)}${isSelf ? ' (You)' : ''}</span>
                <span class="tile-mute-icon hidden text-rose-400">
                    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2"/></svg>
                </span>
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
        if (camOn) {
            video.classList.remove('hidden');
            fallback.classList.add('hidden');
        } else {
            video.classList.add('hidden');
            fallback.classList.remove('hidden');
        }
    }

    function setTileMicState(id, micOn) {
        const tile = document.getElementById('tile-' + id);
        if (!tile) return;
        const icon = tile.querySelector('.tile-mute-icon');
        if (icon) {
            icon.classList.toggle('hidden', micOn);
        }
    }

    function setupAudioAnalyser(stream, targetId) {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const audioCtx = new AudioContext();
            const audioTracks = stream.getAudioTracks();
            if (!audioTracks.length) return;

            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);

            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            let checkSpeaking = () => {
                if (!document.getElementById('tile-' + targetId)) return;
                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    sum += dataArray[i];
                }
                const average = sum / bufferLength;
                const tile = document.getElementById('tile-' + targetId);
                if (tile) {
                    if (average > 25) {
                        tile.classList.add('is-speaking');
                    } else {
                        tile.classList.remove('is-speaking');
                    }
                }
                requestAnimationFrame(checkSpeaking);
            };
            requestAnimationFrame(checkSpeaking);
        } catch (e) {
            console.log('Audio analyser notice:', e);
        }
    }

    // WebRTC Peer Management
    function createPeer(remoteId, peerName, isInitiator, isPeerOwner = false) {
        if (state.peers.has(remoteId)) return state.peers.get(remoteId);

        const pc = new RTCPeerConnection(CONFIG);
        state.peers.set(remoteId, pc);
        state.peerNames.set(remoteId, peerName);
        state.peerRoles.set(remoteId, isPeerOwner);

        // Add local tracks
        const currentStream = state.isScreenSharing && state.screenStream ? state.screenStream : state.localStream;
        currentStream.getTracks().forEach(track => pc.addTrack(track, currentStream));

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
            if (pc.iceConnectionState === 'connected') {
                setConnBadgeStatus(`${state.peers.size + 1} in call`, 'connected');
            }
        };

        if (isInitiator) {
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    send({ type: 'offer', to: remoteId, sdp: pc.localDescription });
                })
                .catch(console.error);
        }

        return pc;
    }

    function closePeer(remoteId) {
        const pc = state.peers.get(remoteId);
        if (pc) {
            pc.close();
            state.peers.delete(remoteId);
        }
        state.peerNames.delete(remoteId);
        state.peerRoles.delete(remoteId);
        state.peerHands.delete(remoteId);
        updateChatTargetOptions();
        removeTile(remoteId);
        updateGridLayout();
        if (state.peers.size === 0) {
            setConnBadgeStatus('Connected (Alone)', 'connected');
        }
    }

    function closeAllPeers() {
        state.peers.forEach(pc => pc.close());
        state.peers.clear();
        state.peerNames.clear();
        state.peerRoles.clear();
        state.peerHands.clear();
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
                state.isOwner = !!data.is_owner;
                state.hostSpotlightId = data.spotlight || null;

                if (state.isOwner && hostBadge) {
                    hostBadge.classList.remove('hidden');
                    hostBadge.classList.add('flex');
                }

                setConnBadgeStatus('Connected', 'connected');
                // TURN credentials are issued only after the server has authenticated
                // this WebSocket as a legitimate room participant.
                await addTurnServers(data.turn_ticket);
                data.peers.forEach(p => {
                    createPeer(p.id, p.name, true, !!p.is_owner);
                    state.peerHands.set(p.id, !!p.hand_raised);
                });

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
                createPeer(data.id, data.name, false, !!data.is_owner);
                state.peerHands.set(data.id, !!data.hand_raised);
                setConnBadgeStatus(`${state.peers.size + 1} in call`, 'connected');
                updateChatTargetOptions();
                updatePeopleList();
                break;

            case 'offer':
                createPeer(data.from, data.from_name, false);
                const pcOffer = state.peers.get(data.from);
                if (pcOffer) {
                    pcOffer.setRemoteDescription(data.sdp)
                        .then(() => pcOffer.createAnswer())
                        .then(answer => pcOffer.setLocalDescription(answer))
                        .then(() => send({ type: 'answer', to: data.from, sdp: pcOffer.localDescription }))
                        .catch(console.error);
                }
                break;

            case 'answer':
                state.peers.get(data.from)?.setRemoteDescription(data.sdp).catch(console.error);
                break;

            case 'ice-candidate':
                const pcIce = state.peers.get(data.from);
                if (pcIce && data.candidate) {
                    pcIce.addIceCandidate(data.candidate).catch(console.error);
                }
                break;

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
                alert(data.reason || 'You were removed from this room by the host.');
                sessionStorage.removeItem('meetly_room');
                window.location.href = '/index.html';
                break;

            case 'role-granted':
                // Host promoted me, OR I was auto-promoted because the room
                // creator left (see data.reason for which one happened).
                state.isOwner = true;
                if (hostBadge) {
                    hostBadge.classList.remove('hidden');
                    hostBadge.classList.add('flex');
                }
                showToast(data.reason || 'You are now a host', data.reason ? 'info' : 'success', 4000);
                updatePeopleList();
                break;

            case 'role-revoked':
                state.isOwner = false;
                if (hostBadge) {
                    hostBadge.classList.add('hidden');
                    hostBadge.classList.remove('flex');
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
                // Host muted my microphone
                if (state.micOn) {
                    setMicState(false, false);
                    showToast('Host muted your microphone', 'error', 3000);
                }
                break;

            case 'cam-force-off':
                // Host turned off my camera
                if (state.camOn) {
                    setCamState(false, false);
                    showToast('Host turned off your camera', 'error', 3000);
                }
                break;

            case 'peer-mic-state':
                setTileMicState(data.id, !!data.on);
                break;

            case 'peer-cam-state':
                setTileCameraState(data.id, !!data.on);
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
                const leavingName = state.peerNames.get(data.id) || 'A participant';
                showToast(`${leavingName} left`, 'info');
                closePeer(data.id);
                break;

            case 'peer-count':
                if (data.count <= 1) {
                    setConnBadgeStatus('Connected (Alone)', 'connected');
                } else {
                    setConnBadgeStatus(`${data.count} in call`, 'connected');
                }
                break;
        }
    }

    // Raised-hand tile badge
    function setTileHandState(id, on) {
        const tile = document.getElementById('tile-' + id);
        const badge = tile?.querySelector('.tile-hand-badge');
        if (badge) badge.classList.toggle('hidden', !on);
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
        const div = document.createElement('div');
        div.className = 'flex flex-col ' + (self ? 'items-end' : 'items-start');
        const isPrivate = !!opts.private;
        const privateTag = isPrivate
            ? `<span class="text-[9px] px-1.5 py-0.2 rounded-full bg-violet-500/20 text-violet-300 font-semibold uppercase tracking-wide">${escapeHtml(opts.label || 'Private')}</span>`
            : '';

        if (self) {
            div.innerHTML = `
                <div class="flex items-center gap-1.5 mb-1 text-[11px] text-slate-400">
                    <span class="font-medium">You</span>
                    ${privateTag}
                    <span>&bull;</span>
                    <span class="text-[10px]">${time}</span>
                </div>
                <div class="px-3.5 py-2 rounded-2xl rounded-tr-sm ${isPrivate ? 'bg-gradient-to-r from-violet-600 to-violet-500' : 'bg-gradient-to-r from-brand-600 to-brand-500'} text-white text-xs sm:text-sm max-w-[85%] break-words shadow-md">
                    ${escapeHtml(text)}
                </div>
            `;
        } else {
            div.innerHTML = `
                <div class="flex items-center gap-1.5 mb-1 text-[11px] text-slate-400">
                    <span class="font-semibold ${isPrivate ? 'text-violet-400' : 'text-cyan-400'}">${escapeHtml(fromName)}</span>
                    ${privateTag}
                    <span>&bull;</span>
                    <span class="text-[10px]">${time}</span>
                </div>
                <div class="px-3.5 py-2 rounded-2xl rounded-tl-sm ${isPrivate ? 'bg-violet-950/60 border border-violet-700/50' : 'bg-slate-800/90 border border-slate-700/60'} text-slate-100 text-xs sm:text-sm max-w-[85%] break-words shadow-md">
                    ${escapeHtml(text)}
                </div>
            `;
        }

        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        if (!state.drawerOpen || state.activeDrawerTab !== 'chat') {
            state.unreadCount++;
            if (unreadBadge) {
                unreadBadge.textContent = state.unreadCount > 9 ? '9+' : state.unreadCount;
                unreadBadge.classList.remove('hidden');
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
        const total = state.peers.size + 1;
        if (peopleCountPill) peopleCountPill.textContent = total;

        peopleList.innerHTML = `
            <!-- Self -->
            <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-800/60 border border-slate-700/50">
                <div class="flex items-center gap-2.5">
                    <div class="w-8 h-8 rounded-full bg-brand-500/20 text-brand-400 font-bold text-xs flex items-center justify-center">
                        ${(name || 'U').substring(0, 2).toUpperCase()}
                    </div>
                    <div>
                        <div class="text-xs font-semibold text-white flex items-center gap-1.5">
                            <span>${escapeHtml(name)}</span>
                            <span class="text-[10px] px-1.5 py-0.2 rounded bg-brand-500/20 text-brand-300 font-medium">You</span>
                            ${state.isOwner ? '<span class="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 font-bold">Host</span>' : ''}
                        </div>
                    </div>
                </div>
                <div class="flex items-center gap-1.5 text-xs text-slate-400">
                    <span>${state.micOn ? '🎙️' : '🔇'}</span>
                    <span>${state.camOn ? '📹' : '🚫'}</span>
                </div>
            </div>
        `;

        state.peerNames.forEach((peerName, peerId) => {
            const isPeerHost = state.peerRoles.get(peerId);
            const handUp = state.peerHands.get(peerId);
            const isSpotlit = state.hostSpotlightId === peerId;
            const item = document.createElement('div');
            item.className = 'flex items-center justify-between p-2.5 rounded-xl bg-slate-800/30 border border-slate-700/30';

            let controls = '';
            if (state.isOwner) {
                controls = `
                    <div class="flex items-center gap-1">
                        <button class="spotlight-btn p-1.5 rounded-lg ${isSpotlit ? 'text-brand-400 bg-brand-500/10' : 'text-slate-400 hover:text-brand-400 hover:bg-brand-500/10'} border border-transparent hover:border-brand-500/20 transition-colors" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="${isSpotlit ? 'Remove spotlight' : 'Spotlight for everyone'}">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9V4.5M9 9H4.5M9 9L3.5 3.5M15 9h4.5M15 9V4.5M15 9l5.5-5.5"/></svg>
                        </button>
                        ${isPeerHost ? `
                        <button class="demote-host-btn p-1.5 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 border border-transparent hover:border-amber-500/20 transition-colors" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="Remove host rights">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"/></svg>
                        </button>` : `
                        <button class="make-host-btn p-1.5 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 border border-transparent hover:border-amber-500/20 transition-colors" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="Make host">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
                        </button>`}
                        <button class="mute-mic-btn p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-colors" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="Mute microphone">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-14 0m7 7v4m-4 0h8M9 9V5a3 3 0 016 0v4"/></svg>
                        </button>
                        <button class="disable-cam-btn p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-colors" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="Turn off camera">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                        </button>
                        <button class="kick-btn p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-colors" data-id="${peerId}" data-name="${escapeHtml(peerName)}" title="Remove participant">
                            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7a4 4 0 11-8 0 4 4 0 018 0zM9 14a6 6 0 00-6 6v1h12v-1a6 6 0 00-6-6zM21 12h-6"/></svg>
                        </button>
                    </div>`;
            } else {
                controls = `<span class="w-2 h-2 rounded-full bg-emerald-400"></span>`;
            }

            item.innerHTML = `
                <div class="flex items-center gap-2.5">
                    <div class="w-8 h-8 rounded-full bg-slate-700 text-slate-200 font-bold text-xs flex items-center justify-center">
                        ${(peerName || 'P').substring(0, 2).toUpperCase()}
                    </div>
                    <div>
                        <div class="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                            <span>${escapeHtml(peerName)}</span>
                            ${handUp ? '<span title="Hand raised">✋</span>' : ''}
                            ${isPeerHost ? '<span class="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 font-bold">Host</span>' : ''}
                        </div>
                    </div>
                </div>
                <div class="flex items-center gap-1">
                    ${controls}
                </div>
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
                    if (!confirm(`Mute ${btn.dataset.name}'s microphone?`)) return;
                    send({ type: 'mute-mic', target_id: btn.dataset.id });
                    showToast(`Muted ${btn.dataset.name}`, 'info');
                });
            });
            peopleList.querySelectorAll('.disable-cam-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (!confirm(`Turn off ${btn.dataset.name}'s camera?`)) return;
                    send({ type: 'disable-cam', target_id: btn.dataset.id });
                    showToast(`Turned off ${btn.dataset.name}'s camera`, 'info');
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
        if (state.localStream) {
            state.localStream.getAudioTracks().forEach(t => t.enabled = on);
        }
        const micBtn = document.getElementById('mic-btn');
        const iconOn = document.getElementById('mic-icon-on');
        const iconOff = document.getElementById('mic-icon-off');
        if (micBtn && iconOn && iconOff) {
            if (on) {
                micBtn.className = 'dock-btn bg-slate-800 hover:bg-slate-700 text-white';
                iconOn.classList.remove('hidden');
                iconOff.classList.add('hidden');
            } else {
                micBtn.className = 'dock-btn bg-rose-500/20 border border-rose-500/40 text-rose-400';
                iconOn.classList.add('hidden');
                iconOff.classList.remove('hidden');
            }
        }
        setTileMicState('me', on);
        // Tell everyone else so their copy of my tile reflects the change too.
        // Skipped when this came from a host force-mute: the server already
        // broadcasts that to everyone on its own.
        if (announce) send({ type: 'mic-state', on });
        updatePeopleList();
    }

    function setCamState(on, announce = true) {
        state.camOn = on;
        if (state.localStream) {
            state.localStream.getVideoTracks().forEach(t => t.enabled = on);
        }
        const camBtn = document.getElementById('cam-btn');
        const iconOn = document.getElementById('cam-icon-on');
        const iconOff = document.getElementById('cam-icon-off');
        if (camBtn && iconOn && iconOff) {
            if (on) {
                camBtn.className = 'dock-btn bg-slate-800 hover:bg-slate-700 text-white';
                iconOn.classList.remove('hidden');
                iconOff.classList.add('hidden');
            } else {
                camBtn.className = 'dock-btn bg-rose-500/20 border border-rose-500/40 text-rose-400';
                iconOn.classList.add('hidden');
                iconOff.classList.remove('hidden');
            }
        }
        setTileCameraState('me', on);
        if (announce) send({ type: 'cam-state', on });
        updatePeopleList();
    }

    function toggleMic() {
        setMicState(!state.micOn);
        showToast(state.micOn ? 'Microphone unmuted' : 'Microphone muted', 'info', 1500);
    }

    function toggleCam() {
        setCamState(!state.camOn);
        showToast(state.camOn ? 'Camera turned on' : 'Camera turned off', 'info', 1500);
    }

    // Screen Sharing
    async function toggleScreenShare() {
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
            screenBtn.className = 'dock-btn bg-brand-500 text-white shadow-lg shadow-brand-500/30';
            showToast('Screen sharing started', 'success');

            const screenTrack = state.screenStream.getVideoTracks()[0];
            const myTile = document.getElementById('tile-me');
            if (myTile) {
                myTile.classList.add('screen-tile');
                const video = myTile.querySelector('video');
                video.srcObject = state.screenStream;
            }

            state.peers.forEach(pc => {
                const senders = pc.getSenders();
                const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                if (videoSender) {
                    videoSender.replaceTrack(screenTrack);
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

    function stopScreenShare() {
        if (!state.isScreenSharing) return;
        state.isScreenSharing = false;

        const screenBtn = document.getElementById('screen-btn');
        if (screenBtn) {
            screenBtn.className = 'dock-btn bg-slate-800 hover:bg-slate-700 text-white hidden sm:flex';
        }

        if (state.screenStream) {
            state.screenStream.getTracks().forEach(t => t.stop());
            state.screenStream = null;
        }

        const myTile = document.getElementById('tile-me');
        if (myTile) {
            myTile.classList.remove('screen-tile');
            const video = myTile.querySelector('video');
            video.srcObject = state.localStream;
        }

        const camTrack = state.localStream.getVideoTracks()[0];
        if (camTrack) {
            state.peers.forEach(pc => {
                const senders = pc.getSenders();
                const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                if (videoSender) {
                    videoSender.replaceTrack(camTrack);
                }
            });
        }
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
        sideDrawer.classList.remove('translate-x-full');

        const chatTab = document.getElementById('drawer-tab-chat');
        const peopleTab = document.getElementById('drawer-tab-people');
        const chatView = document.getElementById('drawer-view-chat');
        const peopleView = document.getElementById('drawer-view-people');

        if (tab === 'chat') {
            chatTab.className = 'px-3 py-1 rounded-lg text-xs font-semibold bg-slate-800 text-white shadow-sm transition-colors';
            peopleTab.className = 'px-3 py-1 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition-colors flex items-center gap-1.5';
            chatView.classList.remove('hidden');
            peopleView.classList.add('hidden');
            state.unreadCount = 0;
            if (unreadBadge) unreadBadge.classList.add('hidden');
            setTimeout(() => chatInput?.focus(), 150);
        } else {
            peopleTab.className = 'px-3 py-1 rounded-lg text-xs font-semibold bg-slate-800 text-white shadow-sm transition-colors flex items-center gap-1.5';
            chatTab.className = 'px-3 py-1 rounded-lg text-xs font-semibold text-slate-400 hover:text-white transition-colors';
            peopleView.classList.remove('hidden');
            chatView.classList.add('hidden');
            updatePeopleList();
        }
    }

    function closeDrawer() {
        state.drawerOpen = false;
        sideDrawer.classList.add('translate-x-full');
    }

    function setConnBadgeStatus(text, status = 'connected') {
        if (connStatusText) connStatusText.textContent = text;
    }

    // WebSocket Lifecycle
    function connectWebSocket() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        state.ws = new WebSocket(`${proto}://${location.host}/ws/${room}`);

        state.ws.onopen = () => {
            // If authenticated, send token; otherwise send guest_name
            if (token) {
                state.ws.send(JSON.stringify({ type: 'auth', token }));
            } else {
                state.ws.send(JSON.stringify({ type: 'auth', guest_name: name, ...(guestToken ? { guest_token: guestToken } : {}) }));
            }
        };

        state.ws.onmessage = (e) => handleMessage(JSON.parse(e.data));

        state.ws.onclose = (event) => {
            if (state.intentionalLeave) return;

            if (event.code >= 4400 && event.code < 4500) {
                setConnBadgeStatus('Access Denied');
                showToast('Unable to connect: ' + (event.reason || 'Invalid room'), 'error');
                setTimeout(() => { window.location.href = '/dashboard.html'; }, 1500);
                return;
            }

            setConnBadgeStatus('Reconnecting...');
            attemptReconnect();
        };
    }

    function attemptReconnect() {
        if (state.intentionalLeave) return;
        if (state.reconnectAttempts >= state.maxReconnectAttempts) {
            setConnBadgeStatus('Disconnected');
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
        state.peers.forEach(pc => pc.close());
        state.peers.clear();
        state.localStream?.getTracks().forEach(t => t.stop());
        state.screenStream?.getTracks().forEach(t => t.stop());
        state.ws?.close();
        sessionStorage.removeItem('meetly_room');
        window.location.href = token ? '/dashboard.html' : '/index.html';
    }

    window.addEventListener('beforeunload', () => {
        state.intentionalLeave = true;
        send({ type: 'leave' });
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
        if (e.key === 'm' || e.key === 'M') toggleMic();
        if (e.key === 'v' || e.key === 'V') toggleCam();
        if (e.key === 'c' || e.key === 'C') toggleDrawer('chat');
    });

    // Initial Chat History
    async function loadChatHistory() {
        try {
            // Guests have no account, so pass their display name to let the
            // server include DMs sent to/from them (see rooms.py filtering).
            const qs = (!token && guestToken) ? `?guest_token=${encodeURIComponent(guestToken)}` : '';
            const msgs = await apiFetch(`/rooms/${room}/messages${qs}`);
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
            // Keep a logged-in user's session rolling so they stay signed in
            // between visits (no-op for guests).
            refreshSession();
            await loadChatHistory();
            await initLocalStream();
            connectWebSocket();
        } catch (err) {
            alert('Could not initialize video call: ' + err.message);
            window.location.href = token ? '/dashboard.html' : '/index.html';
        }
    }

    // Bootstrap: check if logged in or guest
    if (!token && !name) {
        // Show guest modal to ask for display name
        if (guestModal) {
            guestModal.classList.remove('hidden');
            setTimeout(() => guestNameInput?.focus(), 150);

            document.getElementById('guest-join-btn')?.addEventListener('click', () => {
                const inputName = guestNameInput.value.trim();
                name = inputName || `Guest_${Math.floor(1000 + Math.random() * 9000)}`;
                sessionStorage.setItem('meetly_guest_name', name);
                guestModal.classList.add('hidden');
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
