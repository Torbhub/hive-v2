#!/usr/bin/env python3
import json
import sys
import tomllib


def main() -> None:
    config_path, alias = sys.argv[1:3]
    try:
        with open(config_path, "rb") as config_file:
            config = tomllib.load(config_file)
        models = config.get("models")
        if not isinstance(models, dict):
            raise ValueError("models must be a table")
        entry = models.get(alias)
        default_model = config.get("default_model")
        result = {
            "configured": isinstance(entry, dict),
            "default_model": default_model if isinstance(default_model, str) else None,
            "provider": entry.get("provider") if isinstance(entry, dict) else None,
            "model": entry.get("model") if isinstance(entry, dict) else None,
        }
        json.dump(result, sys.stdout)
    except (OSError, tomllib.TOMLDecodeError, ValueError) as error:
        print(f"{config_path} is malformed or unreadable: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
