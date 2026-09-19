// Builds a throwaway directory tree for tests:
//
//   <tmp>/
//     outside/secret.txt          ← must NEVER be reachable
//     root/                       ← FILE_ROOT
//       hello.txt
//       big.bin                   (> 1 MB)
//       binary.dat                (contains NUL bytes)
//       .env                      (deny-listed)
//       <img src=x onerror=alert(1)>.txt   (hostile file name)
//       sub/nested.txt
//       home/me/.ssh/id_ed25519   (deny-listed)
//       link-in   → sub           (symlink staying inside root: allowed)
//       link-out  → ../outside    (symlink escaping root: blocked)
//       link-ssh  → home/me/.ssh  (symlink to a denied path: blocked)

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A legal file name that is also an HTML injection attempt. */
export const XSS_NAME = "<img src=x onerror=alert(1)>.txt";

export interface Fixture {
  root: string;
  cleanup: () => Promise<void>;
}

export async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), "sac-test-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");

  await mkdir(path.join(root, "sub"), { recursive: true });
  await mkdir(path.join(root, "home/me/.ssh"), { recursive: true });
  await mkdir(outside);

  await writeFile(path.join(outside, "secret.txt"), "TOP SECRET");
  await writeFile(path.join(root, "hello.txt"), "hello world\n");
  await writeFile(path.join(root, "sub/nested.txt"), "nested\n");
  await writeFile(path.join(root, ".env"), "API_KEY=abc");
  await writeFile(path.join(root, "home/me/.ssh/id_ed25519"), "PRIVATE KEY");
  await writeFile(path.join(root, "big.bin"), Buffer.alloc(1024 * 1024 + 1, "a"));
  await writeFile(path.join(root, "binary.dat"), Buffer.from([0x89, 0x50, 0x00, 0x00, 0x01]));
  await writeFile(path.join(root, XSS_NAME), "xss");

  await symlink("sub", path.join(root, "link-in"));
  await symlink("../outside", path.join(root, "link-out"));
  await symlink("home/me/.ssh", path.join(root, "link-ssh"));

  return { root, cleanup: () => rm(base, { recursive: true, force: true }) };
}
