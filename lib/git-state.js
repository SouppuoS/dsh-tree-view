// Where the code stood when a turn was tagged.
//
// A tag is the reader saying "this is the good one". For that to be useful later
// it has to say what the tree looked like AT THAT MOMENT, because the working
// directory keeps moving: the commit recorded here is the one to check out to see
// the code the tag was about.
//
// `.git` is read directly rather than shelling out to git. That keeps this
// synchronous and cheap, needs no PATH, cannot be affected by a hook or an alias,
// and still handles the shapes a real checkout has: a ref file, a packed ref, a
// detached HEAD, and the `gitdir:` pointer a worktree or a submodule uses.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Directories that never hold a repository worth recording. */
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'venv', '__pycache__', '.cache']);
/** How deep and how many, so a tag on a huge workspace still answers at once. */
const MAX_DEPTH = 3;
const MAX_REPOS = 12;

function readText(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (error) {
    return undefined;
  }
}

/** A branch that has never been repacked lives in its own file. */
function looseRef(gitDir, name) {
  const text = readText(join(gitDir, ...name.split('/')));
  return text !== undefined && /^[0-9a-f]{7,40}$/.test(text) ? text : undefined;
}

/** After a repack the same branch is a line of packed-refs. */
function packedRef(gitDir, name) {
  const text = readText(join(gitDir, 'packed-refs'));
  if (text === undefined) return undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.charAt(0) === '#' || line.charAt(0) === '^') continue;
    const space = line.indexOf(' ');
    if (space === -1) continue;
    if (line.slice(space + 1) === name) return line.slice(0, space);
  }
  return undefined;
}

/**
 * The commit a working tree is sitting on, or undefined when it is not one.
 * @param repo - directory that may hold a `.git`.
 * @returns `{ head, branch? }`, with no branch for a detached HEAD.
 */
export function headOf(repo) {
  const dotGit = join(repo, '.git');
  let stat;
  try {
    stat = statSync(dotGit);
  } catch (error) {
    return undefined;
  }
  let gitDir = dotGit;
  if (stat.isFile()) {
    // A worktree or a submodule keeps its git directory elsewhere and says so.
    const pointer = readText(dotGit);
    const match = pointer === undefined ? null : /^gitdir:\s*(.+)$/m.exec(pointer);
    if (match === null) return undefined;
    gitDir = resolve(repo, match[1].trim());
  }
  const head = readText(join(gitDir, 'HEAD'));
  if (head === undefined || head === '') return undefined;
  const ref = /^ref:\s*(.+)$/.exec(head);
  if (ref === null) {
    return /^[0-9a-f]{7,40}$/.test(head) ? { head: head } : undefined;
  }
  const name = ref[1].trim();
  const sha = looseRef(gitDir, name) ?? packedRef(gitDir, name);
  if (sha === undefined) return undefined;
  return { head: sha, branch: name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name };
}

/**
 * Every repository at or under `root`, nearest first, with its HEAD commit.
 *
 * The root itself is included when it is a repository, and the walk continues
 * into its subdirectories, because a workspace can hold a checkout of its own
 * beside the repositories it is made of — and a tag should name both.
 * @param root - absolute directory, normally the Session's working directory.
 * @returns `[{ path, head, branch? }]`, `path` relative to `root`; empty when none.
 */
export function scanHeadCommits(root) {
  if (typeof root !== 'string' || root.length === 0) return [];
  const repos = [];
  const walk = (dir, depth, relative) => {
    if (repos.length >= MAX_REPOS) return;
    const found = headOf(dir);
    if (found !== undefined) {
      repos.push({ path: relative === '' ? '.' : relative, head: found.head, ...found.branch === undefined ? {} : { branch: found.branch } });
    }
    if (depth >= MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1, relative === '' ? entry.name : relative + '/' + entry.name);
    }
  };
  walk(root, 0, '');
  return repos;
}
