"""In-process auth check for the backend (no control loop is started).

    Get-Content scripts/auth-check.py | docker exec -i \
      -e SENTINEL_ADMIN_PASSWORD=test-password-123 -e SENTINEL_SESSION_SECRET=test-secret \
      so-backend python -
"""

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import app

c = TestClient(app)
results: list[tuple[str, bool]] = []


def check(name: str, ok: bool) -> None:
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name)


check("healthz is public", c.get("/api/healthz").status_code == 200)
check("state requires sign-in", c.get("/api/state").status_code == 401)
check("me is 401 signed out", c.get("/api/auth/me").status_code == 401)
check("docs disabled", c.get("/docs").status_code == 404)
check("reset requires sign-in", c.post("/api/system/reset").status_code == 401)
check(
    "foreign origin rejected",
    c.post("/api/auth/login", json={"username": "admin", "password": "x"},
           headers={"origin": "https://evil.example"}).status_code == 403,
)

try:
    with c.websocket_connect("/ws") as ws:
        ws.receive_text()
    check("ws rejected signed out", False)
except WebSocketDisconnect as e:
    check("ws rejected signed out (4401)", e.code == 4401)

check("wrong password 401", c.post("/api/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 401)
r = c.post("/api/auth/login", json={"username": "admin", "password": "test-password-123"})
cookie = r.headers.get("set-cookie", "")
check("login ok", r.status_code == 200)
check("cookie HttpOnly + SameSite=strict", "HttpOnly" in cookie and "samesite=strict" in cookie.lower())
check("me returns user", c.get("/api/auth/me").json().get("user") == "admin")
check("state readable signed in", c.get("/api/state").status_code == 200)

c.cookies.set("sentinel_session", c.cookies.get("sentinel_session", "") + "tampered")
check("tampered cookie rejected", c.get("/api/state").status_code == 401)

c.post("/api/auth/logout")
c.cookies.clear()
check("signed out after logout", c.get("/api/state").status_code == 401)

for _ in range(5):
    c.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
check("rate limited after 5 failures", c.post(
    "/api/auth/login", json={"username": "admin", "password": "test-password-123"}).status_code == 429)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
raise SystemExit(1 if failed else 0)
