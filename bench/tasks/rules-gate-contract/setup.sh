sed -i '/Nothing lands without a green gate/d; /hive gate-verify log/d' rules/RULES.md
! grep -q 'Nothing lands without a green gate' rules/RULES.md || { echo 'setup drifted: rules-gate-contract' >&2; exit 1; }
