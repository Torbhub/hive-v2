---
name: cleanup
description: Quarantine what hive created for a project and reclaim verified expired trash with separate owner approval.
---

# Cleanup

Cleanup acts only on the project's `.hive/manifest.jsonl`. It moves lanes into
quarantine instead of deleting them. Records are checked at act time. Cleanup
retains lanes with dirty, untracked, unpublished, ambiguous, live, or shared
state. A proven external lane can use the same recoverable quarantine path.
Cleanup checks actual content diffs, ignored files, and fresh remote state. It
writes pending recovery metadata before it moves a lane.

Always show the dry run first:

```bash
hive cleanup <project> --dry-run
```

Then, on the owner's word:

```bash
hive cleanup <project>
```

Trash lands in `.hive/trash/<date>/`. The manifest retains the original path,
quarantine path, expiry, and content identity. Failed deregistration keeps this
metadata so cleanup can retry.

Reclamation is a separate operation. Show its dry run first:

```bash
hive cleanup <project> --dry-run --reclaim-trash
```

Then reclaim only with the owner's approval:

```bash
hive cleanup <project> --reclaim-trash --owner-approved
```

Reclamation deletes only verified expired quarantine. It stages the recorded
path under a unique name and checks the content again before deletion. Added
paths, changed content, and ambiguous identity block deletion. Historical
unverified trash remains in place.
