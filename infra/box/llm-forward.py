#!/usr/bin/env python3
# Loopback bridge for the memory stack: the memory-core container lives on
# the tdai-memory-stack docker network, and teamkimi binds host loopback
# only. This listens on the network's gateway address so containers can
# reach teamkimi without widening teamkimi's own bind.
import socket
import subprocess
import threading
import time

NETWORK = "tdai-memory-stack"
PORT = 3466
TARGET = ("127.0.0.1", 3466)


def gateway_ip():
    while True:
        try:
            out = subprocess.run(
                ["docker", "network", "inspect", NETWORK, "--format",
                 "{{range .IPAM.Config}}{{.Gateway}}{{end}}"],
                capture_output=True, text=True, timeout=10,
            )
            ip = out.stdout.strip()
            if out.returncode == 0 and ip:
                return ip
        except Exception:
            pass
        time.sleep(5)


def pump(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s, how in ((src, socket.SHUT_RD), (dst, socket.SHUT_WR)):
            try:
                s.shutdown(how)
            except OSError:
                pass


def handle(client):
    try:
        upstream = socket.create_connection(TARGET, timeout=10)
        # create_connection leaves the 10s connect timeout on the socket;
        # a slow LLM response would read as a dead peer and get torn down.
        upstream.settimeout(None)
    except OSError:
        client.close()
        return
    threading.Thread(target=pump, args=(upstream, client), daemon=True).start()
    pump(client, upstream)


def main():
    ip = gateway_ip()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    while True:
        try:
            srv.bind((ip, PORT))
            break
        except OSError:
            # Gateway address appears with the docker bridge; wait for it.
            time.sleep(5)
    srv.listen(128)
    while True:
        client, _ = srv.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
