import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

export async function writeNoFollow(file: string, text: string, root: string): Promise<void> {
  const parent = path.dirname(file);
  const relative = path.relative(root, parent);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`hive: refusing to follow ${file} outside ${root}`);
  }
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    });
    if (stat?.isSymbolicLink()) throw new Error(`hive: refusing to follow parent symlink ${current}`);
  }
  await fs.mkdir(parent, { recursive: true });
  const [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(parent)]);
  const resolved = path.relative(realRoot, realParent);
  if (resolved.startsWith(`..${path.sep}`) || resolved === '..' || path.isAbsolute(resolved)) {
    throw new Error(`hive: refusing to follow ${file} outside ${root}`);
  }
  const directory = await fs.open(realParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const handle = await fs.open(
      `/proc/self/fd/${directory.fd}/${path.basename(file)}`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    ).catch((e: unknown) => {
      throw new Error(`hive: refusing to follow ${file}: ${e instanceof Error ? e.message : e}`);
    });
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
  } finally {
    await directory.close();
  }
}
