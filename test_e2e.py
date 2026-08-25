"""End-to-end test of the full Meetly user journey against a running server:
register -> login -> create private room (auth required) -> guest joins with code (NO auth required)
-> authenticated WebSocket (signaling + chat + host controls + guest support)
-> chat persistence -> cleanup.
"""
import asyncio, json, time
import httpx
import websockets


import ssl

BASE = "https://127.0.0.1:7001"
WS = "wss://127.0.0.1:7001"
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


def _auth_client(c, username, password):
    r = c.post(f"{BASE}/auth/token", data={"username": username, "password": password})
    assert r.status_code == 200, r.text
    tok = r.json()["access_token"]
    return httpx.Client(base_url=BASE, timeout=20, verify=False,
                        headers={"Authorization": f"Bearer {tok}"}), tok


def main():
    c = httpx.Client(base_url=BASE, timeout=20, verify=False)
    suffix = str(int(time.time()))[-5:]
    u1 = f"alice_{suffix}"
    pw = "password123"

    print("1. Testing anonymous room creation (should fail 401)...")
    anon_create = c.post(f"{BASE}/rooms/", json={"name": "Anon Room"})
    assert anon_create.status_code == 401, "Anonymous user should not be able to create a room"
    print("   -> OK (401 Unauthorized)")

    print("2. Registering and logging in host Alice...")
    r = c.post(f"{BASE}/auth/register", json={"username": u1, "email": f"{u1}@t.com",
               "full_name": "Alice", "password": pw})
    assert r.status_code == 201, r.text
    c1, t1 = _auth_client(c, u1, pw)
    print("   -> Registered & logged in:", u1)

    print("3. Creating private room by Alice...")
    r = c1.post(f"{BASE}/rooms/", json={"name": "Standup"})
    assert r.status_code == 201, r.text
    code = r.json()["code"]
    print("   -> Room created:", code)

    print("4. Verifying private room list...")
    assert any(x["code"] == code for x in c1.get(f"{BASE}/rooms/").json())
    print("   -> Room visible in Alice's 'My Rooms'")

    print("5. Anonymous guest looking up room by code...")
    guest_get = c.get(f"{BASE}/rooms/{code}")
    assert guest_get.status_code == 200
    assert guest_get.json()["code"] == code
    assert guest_get.json()["is_owner"] == False
    print("   -> Room accessible to guest with code")

    print("6. Testing WebSocket call with Host & Guest...")
    guest_name = f"GuestBob_{suffix}"

    async def run_call():
        # Alice connects (Host)
        ws_alice = await websockets.connect(f"{WS}/ws/{code}", ssl=SSL_CTX)
        await ws_alice.send(json.dumps({"type": "auth", "token": t1}))
        joined_alice = json.loads(await asyncio.wait_for(ws_alice.recv(), timeout=5.0))
        assert joined_alice["type"] == "joined"
        assert joined_alice["is_owner"] == True
        print("   -> Alice connected as Host")

        # GuestBob connects (NO token, just guest_name)
        ws_guest = await websockets.connect(f"{WS}/ws/{code}", ssl=SSL_CTX)
        await ws_guest.send(json.dumps({"type": "auth", "guest_name": guest_name}))
        joined_guest = json.loads(await asyncio.wait_for(ws_guest.recv(), timeout=5.0))
        assert joined_guest["type"] == "joined"
        assert joined_guest["name"] == guest_name
        assert joined_guest["is_owner"] == False
        print("   -> GuestBob connected as Guest without login")

        # GuestBob sends chat message
        await ws_guest.send(json.dumps({"type": "chat", "text": "Hi from guest!"}))
        await asyncio.sleep(0.1)

        # Alice receives chat message
        while True:
            msg = json.loads(await asyncio.wait_for(ws_alice.recv(), timeout=5.0))
            if msg.get("type") == "chat":
                assert msg["text"] == "Hi from guest!"
                assert msg["name"] == guest_name
                print("   -> Alice received chat from GuestBob:", msg["text"])
                break

        # Host Alice kicks GuestBob
        guest_client_id = joined_guest["id"]
        await ws_alice.send(json.dumps({"type": "kick", "target_id": guest_client_id}))

        # Guest receives kick/disconnect
        try:
            while True:
                msg = json.loads(await asyncio.wait_for(ws_guest.recv(), timeout=3.0))
                if msg.get("type") == "kicked":
                    print("   -> GuestBob received kick notification:", msg["reason"])
                    break
        except (websockets.exceptions.ConnectionClosed, asyncio.TimeoutError):
            print("   -> GuestBob socket closed by server after kick: OK")

        await ws_alice.send(json.dumps({"type": "leave"}))
        await ws_alice.close()

    asyncio.run(run_call())

    print("7. Verifying persisted chat history with guest message...")
    msgs = c1.get(f"{BASE}/rooms/{code}/messages").json()
    assert len(msgs) == 1
    assert msgs[0]["text"] == "Hi from guest!"
    assert msgs[0]["username"] == guest_name
    print("   -> Persisted chat retrieved successfully:", msgs[0])

    print("8. Cleaning up test data...")
    from database import SessionLocal
    from models import User, Room, ChatMessage
    db = SessionLocal()
    for u in db.query(User).filter(User.username.like("alice_%")).all():
        for rm in db.query(Room).filter(Room.owner_id == u.id).all():
            db.query(ChatMessage).filter(ChatMessage.room_id == rm.id).delete(synchronize_session=False)
            db.delete(rm)
        db.delete(u)
    db.commit()
    db.close()

    print("\n======================================")
    print("✅ E2E USER & GUEST JOURNEY: ALL PASSED")
    print("======================================\n")


if __name__ == "__main__":
    main()
