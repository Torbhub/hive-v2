#!/usr/bin/env python3
import os
import pathlib
import sys
import tempfile
import tomllib

BEGIN = "# BEGIN hive-v2 question guard"
END = "# END hive-v2 question guard"
BLOCK = f"""{BEGIN}
[[hooks]]
event = "PreToolUse"
matcher = "AskUserQuestion"
command = "/opt/node22/bin/node /opt/hive-v2/question-guard.mjs"
timeout = 5
{END}
"""


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: merge-question-hook.py <path-to-config.toml>")
    file = pathlib.Path(sys.argv[1])
    raw = file.read_text() if file.exists() else ""
    if raw.strip():
        try:
            tomllib.loads(raw)
        except tomllib.TOMLDecodeError as e:
            raise SystemExit(f"config.toml is malformed; no changes written: {e}")
    start = raw.find(BEGIN)
    if start == -1:
        merged = raw.rstrip() + ("\n\n" if raw.strip() else "") + BLOCK
    else:
        end = raw.find(END, start)
        if end == -1:
            raise SystemExit("config.toml has an incomplete Hive question guard; no changes written")
        merged = raw[:start] + BLOCK + raw[end + len(END):].lstrip("\n")
    if merged == raw:
        return
    try:
        tomllib.loads(merged)
    except tomllib.TOMLDecodeError as e:
        raise SystemExit(f"the existing hooks shape is incompatible; no changes written: {e}")
    file.parent.mkdir(parents=True, exist_ok=True)
    mode = file.stat().st_mode & 0o777 if file.exists() else 0o600
    fd, tmp = tempfile.mkstemp(prefix=f".{file.name}.", dir=file.parent)
    try:
        with os.fdopen(fd, "w") as out:
            out.write(merged)
        os.chmod(tmp, mode)
        os.replace(tmp, file)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


if __name__ == "__main__":
    main()
