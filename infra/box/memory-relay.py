#!/usr/bin/env python3
# Auth relay for the memory core. The core's data plane wants two
# credentials: the instance Bearer key (root-only in memory.env) and a
# scoped user key (lanes hold this one). Lanes call this relay with only
# their user key; the relay swaps in the instance key and forwards to the
# core on 8420. The instance key never leaves root-owned files.
#
# Auth note: lanes run as the ubuntu user, which is in the docker group, so
# a determined lane can read the memory volume directly regardless. This
# relay keeps the API surface honest; it is not a hard boundary.
import http.server
import http.client
import re

LISTEN = ("127.0.0.1", 8421)
UPSTREAM = ("127.0.0.1", 8420)


def instance_key():
    with open("/etc/hive-v2/memory.env") as f:
        for line in f:
            m = re.match(r"^TDAI_GATEWAY_API_KEY=(.*)$", line.strip())
            if m:
                return m.group(1)
    raise SystemExit("TDAI_GATEWAY_API_KEY missing in /etc/hive-v2/memory.env")


KEY = instance_key()


class Relay(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _forward(self, method):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None
        conn = http.client.HTTPConnection(*UPSTREAM, timeout=30)
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ("authorization", "host", "content-length",
                                        "connection", "transfer-encoding", "te",
                                        "keep-alive")}
        headers["authorization"] = f"Bearer {KEY}"
        conn.request(method, self.path, body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() == "content-type":
                self.send_header(k, v)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        conn.close()

    def do_GET(self):
        self._forward("GET")

    def do_POST(self):
        self._forward("POST")

    def do_DELETE(self):
        self._forward("DELETE")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(LISTEN, Relay).serve_forever()
