"""Minimal stand-in for Mailtrap's POST /api/batch: records each request body and answers success."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = "/tmp/requests.jsonl"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        with open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "auth": self.headers.get("Authorization"),
                                "agent": self.headers.get("User-Agent"), "body": body}) + "\n")
        requests = body.get("requests", [])
        out = json.dumps({"success": True, "responses": [
            {"success": True, "message_ids": [f"fake-{i}"]} for i, _ in enumerate(requests)]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
