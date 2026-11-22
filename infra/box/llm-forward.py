#!/usr/bin/env python3
import errno
import select
import socket
import subprocess
import threading
import time

NETWORK = "tdai-memory-stack"
PORT = 3466
TARGET = ("127.0.0.1", 3466)
CONNECT_TIMEOUT = 10
IDLE_TIMEOUT = 300
STARTUP_TIMEOUT = 60
RETRY_DELAY = 1
MAX_RETRY_DELAY = 5
MAX_CONNECTIONS = 32


def gateway_ip():
    deadline = time.monotonic() + STARTUP_TIMEOUT
    delay = RETRY_DELAY
    while True:
        now = time.monotonic()
        if now >= deadline:
            raise TimeoutError(f"Docker gateway discovery exceeded {STARTUP_TIMEOUT} seconds")
        try:
            out = subprocess.run(
                ["docker", "network", "inspect", NETWORK, "--format",
                 "{{range .IPAM.Config}}{{.Gateway}}{{end}}"],
                capture_output=True, text=True, timeout=min(10, deadline - now),
            )
        except subprocess.TimeoutExpired:
            out = None
        if out is not None:
            ip = out.stdout.strip()
            if out.returncode == 0 and ip:
                return ip
            missing = f"network {NETWORK} not found" in out.stderr
            if out.returncode != 0 and not missing:
                detail = out.stderr.strip() or out.stdout.strip() or "no error output"
                raise RuntimeError(
                    f"docker network inspect failed with exit code {out.returncode}: {detail}"
                )
        now = time.monotonic()
        if now >= deadline:
            raise TimeoutError(f"Docker gateway discovery exceeded {STARTUP_TIMEOUT} seconds")
        time.sleep(min(delay, deadline - now))
        delay = min(delay * 2, MAX_RETRY_DELAY)


def pump(client, upstream):
    try:
        while True:
            readable, _, _ = select.select([client, upstream], [], [], IDLE_TIMEOUT)
            if not readable:
                return
            for src, dst in ((client, upstream), (upstream, client)):
                if src not in readable:
                    continue
                data = src.recv(65536)
                if not data:
                    return
                dst.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (client, upstream):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass


def handle(client):
    upstream = None
    try:
        upstream = socket.create_connection(TARGET, timeout=CONNECT_TIMEOUT)
        client.settimeout(IDLE_TIMEOUT)
        upstream.settimeout(IDLE_TIMEOUT)
    except OSError:
        client.close()
        if upstream is not None:
            upstream.close()
        return
    pump(client, upstream)


def run_connection(client, slots):
    try:
        handle(client)
    finally:
        slots.release()


def main():
    ip = gateway_ip()
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        deadline = time.monotonic() + STARTUP_TIMEOUT
        delay = RETRY_DELAY
        while True:
            try:
                srv.bind((ip, PORT))
                break
            except OSError as exc:
                if exc.errno != errno.EADDRNOTAVAIL:
                    raise
                now = time.monotonic()
                if now >= deadline:
                    raise TimeoutError(
                        f"LLM forwarder bind exceeded {STARTUP_TIMEOUT} seconds"
                    ) from exc
                time.sleep(min(delay, deadline - now))
                delay = min(delay * 2, MAX_RETRY_DELAY)
        srv.listen(128)
        slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        while True:
            client, _ = srv.accept()
            if not slots.acquire(blocking=False):
                client.close()
                continue
            try:
                threading.Thread(target=run_connection, args=(client, slots), daemon=True).start()
            except Exception:
                try:
                    client.close()
                finally:
                    slots.release()
                raise
    finally:
        srv.close()


if __name__ == "__main__":
    main()
