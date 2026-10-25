sed -i 's/args.length % 2 !== 0/args.length % 2 === 0/' src/gate.ts
grep -q 'args.length % 2 === 0' src/gate.ts || { echo 'setup drifted: gate-parse-pairs' >&2; exit 1; }
