"""Drive a real Ghost newsletter send through the Admin API: owner, integration, 2 members, publish with email."""
import base64, hashlib, hmac, json, secrets, sys, time, urllib.request, http.cookiejar

base = sys.argv[1].rstrip("/")
api = base + "/ghost/api/admin"
PASSWORD = secrets.token_urlsafe(24)  # Ghost rejects weak or dictionary-like passwords
jar = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
# Ghost checks Origin against its own configured url, which differs from the host-mapped port.
ghost_origin = sys.argv[2].rstrip("/") if len(sys.argv) > 2 else base
H = {"Content-Type": "application/json", "Origin": ghost_origin, "Accept-Version": "v6.0"}


def call(method, path, body=None, headers=None, opener=jar):
    req = urllib.request.Request(api + path, method=method, headers={**H, **(headers or {})},
                                 data=json.dumps(body).encode() if body is not None else None)
    with opener.open(req) as resp:
        raw = resp.read()
        try:
            return json.loads(raw) if raw else None
        except ValueError:  # e.g. POST /session/ answers with plain text
            return None


# "Ghost is running" is logged before the Admin API finishes booting; wait for it.
for _ in range(120):
    try:
        with urllib.request.urlopen(api + "/site/") as resp:
            if resp.status == 200:
                break
    except Exception:
        pass
    time.sleep(1)
else:
    sys.exit("Ghost Admin API never became ready")

call("POST", "/authentication/setup/", {"setup": [{"name": "Integration Owner", "email": "owner@example.test",
                                                   "password": PASSWORD, "blogTitle": "Adapter test"}]})
call("POST", "/session/", {"username": "owner@example.test", "password": PASSWORD})
key = [k for k in call("POST", "/integrations/?include=api_keys", {"integrations": [{"name": "t"}]})["integrations"][0]["api_keys"]
       if k["type"] == "admin"][0]
full = key["secret"] if ":" in key["secret"] else f"{key['id']}:{key['secret']}"
kid, secret = full.split(":")


def token():
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
    iat = int(time.time())
    h = b64(json.dumps({"alg": "HS256", "typ": "JWT", "kid": kid}).encode())
    p = b64(json.dumps({"iat": iat, "exp": iat + 300, "aud": "/admin/"}).encode())
    return f"{h}.{p}." + b64(hmac.new(bytes.fromhex(secret), f"{h}.{p}".encode(), hashlib.sha256).digest())


plain = urllib.request.build_opener()
auth = lambda: {"Authorization": "Ghost " + token()}
newsletter = call("GET", "/newsletters/", headers=auth(), opener=plain)["newsletters"][0]
for email in ("reader-one@example.test", "reader-two@example.test"):
    call("POST", "/members/", {"members": [{"email": email, "name": email.split("@")[0],
                                            "newsletters": [{"id": newsletter["id"]}]}]}, headers=auth(), opener=plain)
post = call("POST", "/posts/", {"posts": [{"title": "Adapter integration post", "status": "draft",
                                           "lexical": json.dumps({"root": {"children": [{"type": "markdown", "version": 1, "markdown": "Hello **reader**."}],
                                                                           "direction": None, "format": "", "indent": 0, "type": "root", "version": 1}})}]},
            headers=auth(), opener=plain)["posts"][0]
published = call("PUT", f"/posts/{post['id']}/?newsletter={newsletter['slug']}&email_segment=all",
                 {"posts": [{"status": "published", "updated_at": post["updated_at"]}]}, headers=auth(), opener=plain)["posts"][0]
print(json.dumps({"post_status": published["status"], "newsletter": newsletter["slug"]}))
for _ in range(90):
    email = call("GET", f"/posts/{post['id']}/?include=email", headers=auth(), opener=plain)["posts"][0].get("email")
    if email and email["status"] in ("submitted", "failed"):
        print(json.dumps({"email_status": email["status"], "email_count": email["email_count"],
                          "error": email.get("error")}))
        sys.exit(0 if email["status"] == "submitted" else 1)
    time.sleep(1)
print("email never reached submitted/failed", file=sys.stderr)
sys.exit(1)
