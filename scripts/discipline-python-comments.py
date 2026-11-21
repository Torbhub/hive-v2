import io
import json
import sys
import token
import tokenize

first_line = int(sys.argv[1]) if len(sys.argv) > 1 else 1
source = sys.stdin.read()
lines = set()
try:
    tokens = tokenize.generate_tokens(io.StringIO(source).readline)
    for item in tokens:
        if item.type != token.COMMENT:
            continue
        line = item.start[0] + first_line - 1
        if line == first_line and item.string.startswith("#!"):
            continue
        lines.add(line)
except (tokenize.TokenError, IndentationError, SyntaxError) as error:
    print(f"python tokenize failed: {error}", file=sys.stderr)
    sys.exit(1)
json.dump(sorted(lines), sys.stdout, separators=(",", ":"))
