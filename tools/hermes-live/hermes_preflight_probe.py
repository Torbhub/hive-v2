import hashlib
import ipaddress
import json
import os
from pathlib import Path
import sqlite3
import sys

import psutil

from hermes_cli.config import load_config
from hermes_cli.gateway_runtime_discovery import query_identify
from hermes_cli.gateway_session_store import session_store
from hermes_cli.plugins import VALID_HOOKS, iter_hook_callbacks
from hermes_cli.version_info import get_version_info
from model_tools import get_tool_definitions
from pm.paths import install_stamp_path, repo_root

RUNTIME_DESCRIBE_FIELDS = {"instance_id", "profile_id", "authority_epoch", "capabilities", "session_create", "skin"}

SCENARIOS = {
    "P01": "t01-read", "P02": None, "P03": None, "P04": "t01-read", "P05": None,
    "P06": "t01-local", "P07": None, "P08": "t01-sleep", "P09": None, "P10": None,
    "P11": None, "P12": None,
}


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def loopback(address):
    return ipaddress.ip_address(address).is_loopback


def listener_state(scenario, tool_names):
    described = session_store().call("runtime.describe")
    if not isinstance(described, dict) or set(described) != RUNTIME_DESCRIBE_FIELDS:
        raise RuntimeError("runtime.describe schema mismatch")
    identified = query_identify(Path(os.environ["HERMES_HOME"]), timeout=5)
    pid = identified.get("pid")
    if not isinstance(pid, int):
        raise RuntimeError("gateway process identity is unavailable")
    process = psutil.Process(pid)
    children = process.children(recursive=True)
    connections = process.connections(kind="inet") + [
        connection for child in children for connection in child.connections(kind="inet")
    ]
    external_connections = [item for item in connections if item.raddr and not loopback(item.raddr.ip)]
    external_listeners = [item for item in connections if item.status == "LISTEN" and not loopback(item.laddr.ip)]
    external_mcp = bool(external_connections) or any(
        "mcp" in " ".join(child.cmdline()).lower()
        and any(transport in " ".join(child.cmdline()).lower() for transport in ["http", "sse", "websocket"])
        for child in children
    )
    home = Path(os.environ["HERMES_HOME"])
    database = sqlite3.connect(f"file:{home / 'state.db'}?mode=ro", uri=True)
    try:
        child_count = database.execute("SELECT count(*) FROM sessions WHERE parent_session_id IS NOT NULL").fetchone()[0]
    finally:
        database.close()
    approved_hooks = {"P06": ["t01_observer", "t01_pre_tool"], "P08": ["t01_observer"]}.get(scenario, [])
    hooks = sorted({
        getattr(callback, "__name__", type(callback).__name__)
        for event in sorted(VALID_HOOKS)
        for callback in iter_hook_callbacks(event)
    })
    return {
        "observed": True,
        "source": "hermes-runtime",
        "hooks": hooks,
        "delegation": child_count > 0 or "delegate_task" in tool_names,
        "a2a": bool(external_listeners),
        "messaging": bool(external_listeners),
        "externalMcp": external_mcp,
        "mcpResources": any(name.endswith("_resources") for name in tool_names),
        "mcpPrompts": any(name.endswith("_prompts") for name in tool_names),
        "mcpEvents": any(name.endswith("_events") for name in tool_names),
        "unapprovedHooks": sorted(set(hooks) - set(approved_hooks)),
        "childSessionCount": child_count,
        "deniedNetworkAttempts": len(external_connections),
    }


def native_session(session_id):
    home = Path(os.environ["HERMES_HOME"])
    sidecar_path = home / "t01-sessions" / f"{hashlib.sha256(session_id.encode()).hexdigest()}.json"
    sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
    database = sqlite3.connect(f"file:{home / 'state.db'}?mode=ro", uri=True)
    try:
        columns = {row[1] for row in database.execute("PRAGMA table_info(sessions)")}
        if not columns:
            return {"status": "missing"}
        selected = ["id"] + sorted(column for column in ["ended_at", "model", "provider", "base_url", "toolsets"] if column in columns)
        row = database.execute(f"SELECT {', '.join(selected)} FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            return {"status": "missing"}
        native = dict(zip(selected, row))
        row_count = database.execute("SELECT count(*) FROM messages WHERE session_id = ?", (session_id,)).fetchone()[0]
        child_count = database.execute("SELECT count(*) FROM sessions WHERE parent_session_id = ?", (session_id,)).fetchone()[0]
        schema_version = database.execute("PRAGMA user_version").fetchone()[0]
        ended_at = native.get("ended_at")
        return {
            "status": "present",
            "sessionId": native["id"],
            "admissionId": sidecar.get("admissionId"),
            "routeHash": sidecar.get("routeHash"),
            "policyHash": sidecar.get("policyHash"),
            "generation": sidecar.get("generation"),
            "schemaVersion": schema_version,
            "rowCount": row_count,
            "state": "finalized" if ended_at is not None else "open",
            "childSessionCount": child_count,
            "updatedAt": str(ended_at) if ended_at is not None else None,
        }
    finally:
        database.close()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--session-id":
        print(json.dumps(native_session(sys.argv[2]), separators=(",", ":"), sort_keys=True))
        return
    identity = get_version_info()
    if identity.dirty:
        raise RuntimeError("dirty Hermes checkout")
    stamp = json.loads(install_stamp_path(repo_root()).read_text(encoding="utf-8"))
    artifact_hash = stamp.get("artifactSha256")
    lock_path = Path(repo_root()) / "uv.lock"
    scenarios = {}
    load_config()
    for scenario, toolset in SCENARIOS.items():
        enabled = [toolset] if toolset else []
        definitions = get_tool_definitions(enabled_toolsets=enabled, quiet_mode=True, skip_tool_search_assembly=True)
        tool_names = sorted(item["function"]["name"] for item in definitions)
        scenarios[scenario] = {
            "tools": tool_names,
            "listeners": listener_state(scenario, tool_names),
        }
    print(json.dumps({
        "version": identity.base_version,
        "commit": identity.commit,
        "artifactHash": artifact_hash,
        "lockedDependenciesHash": file_hash(lock_path),
        "scenarios": scenarios,
    }, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
