import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { headOf, scanHeadCommits } from '../../lib/git-state.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'tree-view-git-'));
const SHA = (c) => c.repeat(40);

test('a branch that has never been repacked is read from its own file', () => {
  const root = scratch();
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), SHA('a') + '\n');
  assert.deepEqual(headOf(root), { head: SHA('a'), branch: 'main' });
});

test('a repacked branch is read out of packed-refs', () => {
  const root = scratch();
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'packed-refs'),
    '# pack-refs with: peeled fully-peeled sorted\n' + SHA('b') + ' refs/heads/main\n' + SHA('c') + ' refs/heads/other\n');
  assert.deepEqual(headOf(root), { head: SHA('b'), branch: 'main' }, 'the branch asked for, not the first line');
});

test('a detached HEAD is the commit itself, with no branch', () => {
  const root = scratch();
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), SHA('d') + '\n');
  assert.deepEqual(headOf(root), { head: SHA('d') });
});

test('a worktree or submodule points at its git directory', () => {
  const root = scratch();
  const gitDir = join(root, 'elsewhere');
  mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/wt\n');
  writeFileSync(join(gitDir, 'refs', 'heads', 'wt'), SHA('e') + '\n');
  writeFileSync(join(root, '.git'), 'gitdir: ' + gitDir + '\n');
  assert.deepEqual(headOf(root), { head: SHA('e'), branch: 'wt' });
});

test('a directory that is not a repository says so, and so does a broken one', () => {
  assert.equal(headOf(scratch()), undefined, 'no .git at all');
  const broken = scratch();
  mkdirSync(join(broken, '.git'), { recursive: true });
  writeFileSync(join(broken, '.git', 'HEAD'), 'ref: refs/heads/gone\n');
  assert.equal(headOf(broken), undefined, 'HEAD names a ref that does not exist');
});

test('the root and the repositories under it are both reported, nearest first', () => {
  const root = scratch();
  const repo = (dir, branch, sha) => {
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/' + branch + '\n');
    writeFileSync(join(dir, '.git', 'refs', 'heads', branch), sha + '\n');
  };
  repo(root, 'main', SHA('f'));
  repo(join(root, 'packages', 'inner'), 'dev', SHA('1'));
  mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true });
  repo(join(root, 'node_modules', 'ignored'), 'main', SHA('2'));
  const found = scanHeadCommits(root);
  assert.deepEqual(found.map((r) => r.path), ['.', 'packages/inner'],
    'the root, then the nested checkout — and nothing out of node_modules');
  assert.equal(found[1].branch, 'dev');
  assert.deepEqual(scanHeadCommits(undefined), [], 'a Session with no working directory has nothing to record');
});
