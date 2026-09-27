import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// A conversation, a photocopy of it (a fork with no turns of its own), and a
// fork that kept talking. The photocopy is what the "hide forks with no new
// content" switch is about; the layout assertions are there because a broken
// parent link is what turns the tree into a pile of overlapping cards.
const ROOT_TURNS = Array.from({ length: 16 }, (_, i) => ({ turn: i + 1, text: 'root turn ' + (i + 1), time: i + 1 }));
const COPY_TURNS = Array.from({ length: 12 }, (_, i) => ({ turn: i + 1, text: 'copied turn ' + (i + 1), time: i + 1 }));
const FORK_TURNS = Array.from({ length: 17 }, (_, i) => ({ turn: i + 1, text: 'fork turn ' + (i + 1), time: i + 1 }));

const VERSIONS = [
  { sessionId: 'session-root', createdAt: 1, current: true, turns: ROOT_TURNS },
  { sessionId: 'session-copy', parentSessionId: 'session-root', createdAt: 2, forkTurn: 12, copy: true, turns: COPY_TURNS },
  { sessionId: 'session-fork', parentSessionId: 'session-root', createdAt: 3, forkTurn: 15, turns: FORK_TURNS },
];

async function mountView(t, prefs, versions = VERSIONS, fetchImpl, viewSessionId = 'session-root', catalogue = {}, host = 'legacy') {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://tree-view.test/',
    pretendToBeVisual: true,
  });
  // These tests are about the tree's shape, not about the fold, so the stored
  // preferences switch the fold off unless a test asks for it. `'default'`
  // leaves the key out entirely, which is how a fresh install looks — that is
  // the only way to assert on the shipped default.
  const stored = Object.assign({ rememberPath: true, stopOnEdit: true, dropEmptyForks: true, foldSharedAt: 0 }, prefs);
  if (stored.foldSharedAt === 'default') delete stored.foldSharedAt;
  dom.window.localStorage.setItem('dsh-tree-view:prefs', JSON.stringify(stored));
  dom.window.fetch = fetchImpl ?? (async () => ({ ok: true, json: async () => ({ versions }) }));
  const previous = new Map();
  const browserErrors = [];
  dom.window.addEventListener('error', (event) => browserErrors.push(event.error || event.message));
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  const disposers = [];
  const opened = [];
  // 0.1.7 opens a session through the workspace service instead; a test that
  // asks for that host shape records here.
  const workspaceOpened = [];
  const tabClicks = [];
  t.after(async () => {
    await act(async () => root.unmount());
    for (const dispose of disposers.reverse()) dispose();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.deepEqual(browserErrors, [], 'Browser event handlers must not throw');
  });
  let view;
  const slots = {
    inject(_name, register) { register(); },
    register(spec, component) { if (spec.name === 'conversation.view') view = component; return () => {}; },
  };
  let plugin;
  dom.window.__ModuleLoader__ = { load({ factory }) { plugin = factory(() => React); } };
  runInNewContext(bundle, {
    window: dom.window, document: dom.window.document, console, setTimeout, clearTimeout,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  }, { filename: 'lib/client.js' });
  const ctx = {
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'uiWorkspace' && host === 'modern') {
        return { openSession: (id) => { workspaceOpened.push(id); } };
      }
      if (name === 'sessions') {
        return {
          // 0.1.7 dropped `open` from the session controller; `bare` is a host
          // that offers neither navigation route.
          ...(host === 'legacy' ? { open: (id) => { opened.push(id); } } : {}),
          list: {
            subscribe: () => () => {},
            getSnapshot: () => ({
              byId: Object.fromEntries(versions.map((v) => [v.sessionId, { id: v.sessionId }])),
              // DSH keeps a catalogue of subagents per parent session; the tree
              // reads it when the host payload cannot say (an old host half).
              subagentsByParent: catalogue ?? {},
            }),
          },
        };
      }
      return undefined;
    },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  };
  // Optional services ride on `ctx.inject`; the double hands back the same context.
  ctx.inject = (deps, callback) => callback(ctx);
  plugin.apply(ctx);
  assert.equal(typeof view, 'function');
  // The conversation area always has a Chat tab first; showChat() brings it
  // forward, and these tests watch that click land.
  const chatTab = dom.window.document.createElement('div');
  chatTab.setAttribute('role', 'tab');
  chatTab.setAttribute('aria-selected', 'false');
  chatTab.addEventListener('click', () => { tabClicks.push(true); });
  dom.window.document.body.appendChild(chatTab);
  await act(async () => { root.render(React.createElement(view, { sessionId: viewSessionId })); });
  await act(async () => { await Promise.resolve(); });
  const cardIds = () => [...dom.window.document.querySelectorAll('.mtx-card')].map((el) => el.getAttribute('data-id'));
  const offsets = () => [...dom.window.document.querySelectorAll('.mtx-card')].map((el) => el.style.transform);
  const titles = () => [...dom.window.document.querySelectorAll('.mtx-card-title')].map((el) => el.textContent);
  const links = () => [...dom.window.document.querySelectorAll('.mtx-card')]
    .map((el) => ({
      id: el.getAttribute('data-id'),
      parent: el.getAttribute('data-parent'),
      current: el.hasAttribute('data-current'),
      head: el.hasAttribute('data-head'),
    }));
  // The panel has no toolbar any more. What was a button is now a branch's own
  // right-click menu, and a fold opens its outline on hover.
  const menuItems = () => [...dom.window.document.querySelectorAll('.mtx-menu-item')];
  const openMenu = (id) => act(async () => {
    const el = dom.window.document.querySelector('.mtx-card[data-id="' + id + '"]');
    assert.ok(el, 'card ' + id + ' is drawn');
    el.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  const clickMenuItem = (label) => act(async () => {
    const item = menuItems().find((el) => el.textContent === label);
    assert.ok(item, 'menu item "' + label + '" exists');
    item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  // React implements onMouseEnter from mouseover, which is what a real hover
  // sends first.
  const clickRail = () => act(async () => {
    const button = dom.window.document.querySelector('.mtx-rail-btn');
    assert.ok(button, 'the rail button exists');
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  const hoverCard = (id) => act(async () => {
    const el = dom.window.document.querySelector('.mtx-card[data-id="' + id + '"]');
    assert.ok(el, 'card ' + id + ' is drawn');
    el.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
  });
  const outlineItems = () => [...dom.window.document.querySelectorAll('.mtx-outline-item')];
  const worldScale = () => {
    const world = dom.window.document.querySelector('.mtx-world');
    const m = world && /scale\(([\d.]+)\)/.exec(world.style.transform || '');
    return m ? Number(m[1]) : null;
  };
  const wheelOn = (selector, deltaY) => act(async () => {
    const el = dom.window.document.querySelector(selector);
    assert.ok(el, 'element ' + selector + ' exists');
    el.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: deltaY, bubbles: true, cancelable: true }));
  });
  const outlineTurns = () => outlineItems().map((el) => Number(el.getAttribute('data-turn')));
  const hoverOutlineRow = (turn) => act(async () => {
    const item = outlineItems().find((el) => el.getAttribute('data-turn') === String(turn));
    assert.ok(item, 'outline row for turn ' + turn + ' exists');
    item.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
  });
  const clickOutline = (turn) => act(async () => {
    const item = outlineItems().find((el) => el.getAttribute('data-turn') === String(turn));
    assert.ok(item, 'outline row for turn ' + turn + ' exists');
    item.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  // Cards act on pointerup, the way the canvas does: press, release, done.
  const clickCard = (id) => act(async () => {
    const el = dom.window.document.querySelector('.mtx-card[data-id="' + id + '"]');
    assert.ok(el, 'card ' + id + ' is drawn');
    el.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    el.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
  });
  const foldCard = () => dom.window.document.querySelector('.mtx-card[data-fold]');
  const confirmTitle = () => (dom.window.document.querySelector('.mtx-confirm-title') || {}).textContent ?? null;
  const confirmButtons = () => [...dom.window.document.querySelectorAll('.mtx-confirm .mtx-btn')].map((b) => b.textContent);
  const clickConfirm = (label) => act(async () => {
    const button = [...dom.window.document.querySelectorAll('.mtx-confirm .mtx-btn')].find((b) => b.textContent === label);
    assert.ok(button, 'confirm button ' + label + ' exists');
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  // A real press is pointerdown → pointerup → click. The canvas pans on the
  // first of those and captures the pointer, so an overlay that the pan handler
  // does not recognise never receives the click at all — which is exactly how
  // Cancel came to do nothing.
  const pressDown = (selector) => act(async () => {
    const el = dom.window.document.querySelector(selector);
    assert.ok(el, 'element ' + selector + ' exists');
    el.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  });
  const graphsPanning = () => {
    const graph = dom.window.document.querySelector('.mtx-graph');
    return !!graph && graph.hasAttribute('data-panning');
  };
  return {
    dom, cardIds, offsets, titles, links, clickCard, foldCard,
    menuItems, openMenu, clickMenuItem, clickRail, hoverCard, outlineItems, outlineTurns, clickOutline, hoverOutlineRow, worldScale, wheelOn,
    confirmTitle, confirmButtons, clickConfirm, pressDown, graphsPanning,
    opened, workspaceOpened, tabClicks,
  };
}

test('the switch decides whether a photocopy is drawn, and the layout stays sane', async (t) => {
  const hidden = await mountView(t, { dropEmptyForks: true });
  const hiddenIds = hidden.cardIds();
  assert.ok(!hiddenIds.some((id) => id.startsWith('session-copy')),
    'with the switch on, the copy is not on the canvas');
  assert.ok(hiddenIds.includes('session-fork#t16'),
    'while a fork that kept talking is drawn from its first own turn');
  assert.ok(!hiddenIds.includes('session-fork#t1'),
    'and never re-draws the history it copied');

  // A dangling parent link is what makes the tree a pile of cards: the layout
  // leaves the node unplaced and every transform turns into NaN.
  for (const offset of hidden.offsets()) {
    assert.ok(!/NaN|undefined/.test(offset), 'every card is placed: ' + offset);
  }
});

test('with the switch off, a photocopy is drawn as one copy node', async (t) => {
  // The stored preference object this harness writes has no schema version,
  // which is also how a pre-migration object looked: only the one key whose
  // meaning changed may be dropped, so this toggle has to arrive intact.
  const shown = await mountView(t, { dropEmptyForks: false });
  const ids = shown.cardIds();
  assert.ok(ids.includes('session-copy#fork'), 'the copy gets exactly one node');
  assert.ok(!ids.includes('session-copy#t1'), 'and does not re-draw the history it copied');
  assert.ok(shown.titles().includes('Forked copy'), 'labelled as a copy, not as an edit');
  for (const offset of shown.offsets()) {
    assert.ok(!/NaN|undefined/.test(offset), 'every card is placed: ' + offset);
  }
});

// Turn numbers are not contiguous in real logs: a turn that was interrupted or
// steered into never writes its turn/end, so a conversation can count 18 turns
// while numbering them 1..12 and 14..19. Both reported "turn N should come after
// turn N-2" cases came from chaining on `turn - 1` and falling back to the root
// when that invented node turned out not to exist.
const GAPPED_VERSIONS = [
  {
    sessionId: 'session-root',
    createdAt: 1,
    current: true,
    turns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19].map((turn) => ({ turn, text: 'root ' + turn, time: turn })),
  },
  {
    sessionId: 'session-gap-fork',
    parentSessionId: 'session-root',
    createdAt: 2,
    forkTurn: 15,
    turns: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20].map((turn) => ({ turn, text: 'fork ' + turn, time: turn })),
  },
];

test('collecting the other branches asks before stopping work', async (t) => {
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, async (url, options) => {
    if (options && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      posts.push(payload);
      if (payload.action === 'demoteOthers' && payload.stopRunning !== true) {
        return { ok: false, status: 409, json: async () => ({ error: 'busy', busy: ['session-fork'] }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ versions: VERSIONS }) };
  });

  await view.openMenu('session-root#t5');
  await view.clickMenuItem('Collect every other branch');
  assert.ok(posts.some((p) => p.action === 'demoteOthers'), 'collect asks the host');
  assert.ok(!posts.some((p) => p.stopRunning === true), 'and does not stop anything before the user says so');
  assert.ok(view.confirmTitle() !== null, 'a running branch is a question, not a silent kill');
  assert.ok(/^Running branches: 1[.]/.test(view.confirmTitle()), 'the question counts the running branches: ' + view.confirmTitle());
  assert.deepEqual(view.confirmButtons(), ['Confirm', 'Cancel']);

  await view.clickConfirm('Confirm');
  assert.ok(posts.some((p) => p.action === 'demoteOthers' && p.stopRunning === true), 'confirmed, it stops and collects');
  assert.equal(view.confirmTitle(), null, 'and the question goes away');
});

test('the question can be dismissed, and its buttons are not drag handles', async (t) => {
  // Reported: Cancel did nothing. The canvas pans on pointerdown and captures
  // the pointer, which retargets the click that follows to the canvas — so a
  // press on the dialog has to be excluded from the pan handler, or neither
  // button ever receives a click.
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, async (url, options) => {
    if (options && options.method === 'POST') {
      return { ok: false, status: 409, json: async () => ({ error: 'busy', busy: ['session-fork', 'session-copy'] }) };
    }
    return { ok: true, json: async () => ({ versions: VERSIONS }) };
  });

  await view.openMenu('session-root#t5');
  await view.clickMenuItem('Collect every other branch');
  assert.ok(/^Running branches: 2[.]/.test(view.confirmTitle()), 'both running branches are named: ' + view.confirmTitle());

  await view.pressDown('.mtx-confirm-title');
  assert.equal(view.graphsPanning(), false, 'the dialog body is excluded from panning too');
  assert.ok(view.confirmTitle() !== null, 'and the press alone leaves the question standing');

  await view.pressDown('.mtx-confirm .mtx-btn:last-child');
  assert.equal(view.graphsPanning(), false, 'pressing Cancel must not start a pan under the dialog');

  await view.clickConfirm('Cancel');
  assert.equal(view.confirmTitle(), null, 'Cancel closes the question');
});

test('a host that cannot hide sessions turns that action off and says so', async (t) => {
  const degraded = {
    versions: VERSIONS,
    archiveSupport: { ok: false, read: true, hide: false, show: false, missing: ['workspaceRegistry.archiveSession'] },
  };
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, async () => ({
    ok: true,
    json: async () => degraded,
  }));

  await view.openMenu('session-root#t5');
  const collect = view.menuItems().find((el) => el.textContent === 'Collect every other branch');
  assert.ok(collect, 'the branch menu still offers it');
  assert.equal(collect.disabled, true, 'but it is off rather than failing at click time');
  assert.ok((collect.getAttribute('title') || '').length > 0, 'and it says why on hover');

  const notice = view.dom.window.document.querySelector('.mtx-notice');
  assert.ok(notice, 'the panel states the degradation once, in place');
  assert.ok(notice.textContent.includes('workspaceRegistry.archiveSession'),
    'naming the missing piece: ' + notice.textContent);
});

test('reading a branch makes the shared history read as the same line', async (t) => {
  // Opening the fork: the turns it shares with its parent are that fork's
  // history, so they are highlighted exactly like the turns it adds. What stays
  // plain is the parent's own later turns — the other branch.
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-fork');
  const links = view.links();
  const byId = new Map(links.map((link) => [link.id, link]));

  assert.equal(byId.get('session-root#t1').current, true, 'the shared history is on the line');
  assert.equal(byId.get('session-root#t15').current, true, 'including the turn the fork left from');
  assert.equal(byId.get('session-root#root').current, true, 'and the conversation it started from');
  assert.equal(byId.get('session-fork#t17').current, true, 'the fork owns the turns it added');
  assert.equal(byId.get('session-root#t16').current, false,
    'the parent\'s own later turn belongs to the other branch and stays plain');
  assert.equal(links.filter((link) => link.head).length, 1, 'exactly one node marks where you are');
  assert.equal(links.find((link) => link.head).id, 'session-fork#t17');
});

test('a gap in the turn numbering does not orphan the chain', async (t) => {
  const shown = await mountView(t, { dropEmptyForks: true }, GAPPED_VERSIONS);
  const links = shown.links();
  const parentOf = (id) => (links.find((link) => link.id === id) || {}).parent;

  assert.equal(parentOf('session-root#t14'), 'session-root#t12',
    'turn 14 follows turn 12 — the turn that actually exists before it');
  assert.equal(parentOf('session-root#t15'), 'session-root#t14');
  assert.equal(parentOf('session-gap-fork#t16'), 'session-root#t15',
    'a fork starts on the turn it forked from, not on the root');
  assert.equal(parentOf('session-gap-fork#t20'), 'session-gap-fork#t18',
    'and turn 20 follows turn 18, not the root');

  const ids = new Set(links.map((link) => link.id));
  for (const link of links) {
    if (!link.parent) continue;
    assert.ok(link.parent === 'session-root#root' || ids.has(link.parent),
      'no dangling parent: ' + link.id + ' -> ' + link.parent);
  }
  assert.deepEqual(links.filter((link) => link.parent === 'session-root#root').map((link) => link.id),
    ['session-root#t1'],
    'only the conversation\'s own first turn hangs off the root — the fork hangs off turn 15');
});

test('a threshold that was only ever v2 default follows the new one', async (t) => {
  // Eight was v2's shipped value, so a stored eight is what everyone got rather
  // than a decision, and v3 moves it with the default. A five-turn run never
  // folds at eight and always does at two, which is what makes the move visible.
  const line = Array.from({ length: 6 }, (_, i) => ({ turn: i + 1, text: 'turn ' + (i + 1), time: i + 1 }));
  const view = await mountView(t, { v: 2, foldSharedAt: 8, dropEmptyForks: true },
    [{ sessionId: 'session-root', createdAt: 1, current: true, turns: line }]);
  assert.ok(view.foldCard(), 'the stored old default moved with the new one');
  assert.ok(!view.cardIds().includes('session-root#t1'), 'so the shared stretch folds');
});

test('a long shared history is drawn as one node', async (t) => {
  // With empty forks hidden, this family's branches share turns 1..14 and part
  // at turn 15 — a stretch that is the same reading in every branch. The shipped
  // default folds it into one card.
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' });

  const card = view.foldCard();
  assert.ok(card, 'the trunk is folded into one card');
  assert.ok(card.textContent.includes('14 shared turns'),
    'the card says how much it hides: ' + card.textContent);
  assert.ok(!view.cardIds().includes('session-root#t5'), 'the turns it hides are off the canvas');
  assert.ok(view.cardIds().includes('session-root#root'), 'the conversation itself stays');
  assert.ok(view.cardIds().includes('session-root#t15'), 'and so does the turn where the branches part');

  const links = view.links();
  const foldId = card.getAttribute('data-id');
  assert.equal((links.find((l) => l.id === foldId) || {}).parent, 'session-root#root',
    'the fold hangs from the conversation');
  assert.equal((links.find((l) => l.id === 'session-root#t15') || {}).parent, foldId,
    'and the branch point hangs from the fold');
  for (const offset of view.offsets()) {
    assert.ok(!/NaN|undefined/.test(offset), 'every card is placed: ' + offset);
  }
});

test('a fold opens its outline on hover, and clicking it changes nothing', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' });
  const foldId = view.foldCard().getAttribute('data-id');

  // Clicking used to redraw the whole canvas. It must leave the fold alone now:
  // the outline is how the turns inside it are read, not a drawer to open.
  await view.clickCard(foldId);
  assert.ok(view.foldCard(), 'clicking a fold leaves it folded');
  assert.ok(!view.cardIds().includes('session-root#t5'), 'and the turns it hides stay off the canvas');
  assert.equal(view.outlineItems().length, 0, 'and nothing was opened');

  await view.hoverCard(foldId);
  assert.deepEqual(view.outlineTurns(), Array.from({ length: 14 }, (_, i) => i + 1),
    'hovering lists the turns it hides, in order');

  // The rail is the conversation view's shape: one short rule per hidden turn and
  // nothing else. What a rule stands for is stated in ONE block beside the rail,
  // not lined up with the rule it describes.
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-outline-bar').length, 14,
    'every hidden turn gets a rule');
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-outline-info').length, 1,
    'and a single block says what the open turn was');

  const activeTurn = () => {
    const active = view.dom.window.document.querySelectorAll('.mtx-outline-item[data-active]');
    return active.length === 1 ? Number(active[0].getAttribute('data-turn')) : null;
  };
  const info = () => view.dom.window.document.querySelector('.mtx-outline-info').textContent;
  assert.ok(!/Turn\s*\d/.test(info()), 'the turn number is not repeated in the block: ' + info());

  assert.equal(activeTurn(), 1, 'the first rule is open before the pointer picks one');
  assert.match(info(), /root turn 1/, 'and the block already says what it was: ' + info());

  await view.hoverOutlineRow(5);
  assert.equal(activeTurn(), 5, 'pointing at a rule opens exactly that one');
  assert.match(info(), /root turn 5/, 'and the block follows it: ' + info());

  // It is placed in the panel's own coordinates rather than the canvas's, so it
  // does not travel with a pan or shrink with a zoom.
  const outline = view.dom.window.document.querySelector('.mtx-outline');
  assert.ok(outline.style.left, 'the outline is placed beside the pointer: ' + outline.style.left);
  assert.equal(outline.style.transform, '', 'and not by the canvas transform');

  // A wheel over the outline belongs to the outline. It used to bubble to the
  // canvas and zoom the tree out from under the reader.
  const before = view.worldScale();
  await view.wheelOn('.mtx-outline', 240);
  assert.equal(view.worldScale(), before, 'scrolling the outline must not zoom the canvas');

  await view.wheelOn('.mtx-graph', 240);
  assert.notEqual(view.worldScale(), before, 'while a wheel on the canvas still zooms it');

  // Picking a row reaches that turn. It belongs to the version already on screen,
  // so the panel only sends the chat there rather than switching anything.
  await view.clickOutline(3);
  assert.ok(view.tabClicks.length > 0, 'choosing a row goes back to the Chat tab');
  assert.equal(view.outlineItems().length, 0, 'and the outline closes behind it');
});

test('a run below the threshold is never folded', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 20 });
  assert.equal(view.foldCard(), null, 'a shared stretch below the threshold is left alone');
  assert.ok(view.cardIds().includes('session-root#t5'), 'so its turns are on the canvas');
});

test('a subagent conversation is marked as one', async (t) => {
  // It shares the family (same cwd, parent session) but is not a version of the
  // reader's message, so its cards have to say what they are.
  const withDelegate = VERSIONS.concat([{
    sessionId: 'session-delegate',
    parentSessionId: 'session-root',
    createdAt: 5,
    subagent: true,
    turns: [{ turn: 1, text: 'delegate one', time: 5 }],
  }]);
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 0 }, withDelegate, undefined, 'session-root');

  const card = view.dom.window.document.querySelector('.mtx-card[data-id="session-delegate#t1"]');
  assert.ok(card, 'the subagent conversation is drawn');
  assert.equal(card.hasAttribute('data-subagent'), true, 'and carries the flag in the open');
  assert.ok(card.textContent.includes('subagent'), 'the card says so: ' + card.textContent);
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-card[data-subagent]').length, 1,
    'only the subagent conversation is marked');
});

test('and marks one the host half has not learned about yet', async (t) => {
  // The host half is loaded by the DSH server, so its new payload field only
  // arrives after a restart. The app's own subagent catalogue is already in the
  // client, so a refresh is enough — this is what the reader reported missing.
  const catalogue = { 'session-root': { entries: [{ kind: 'child', id: 'session-delegate' }] } };
  const withDelegate = VERSIONS.concat([{
    sessionId: 'session-delegate',
    parentSessionId: 'session-root',
    createdAt: 5,
    turns: [{ turn: 1, text: 'delegate one', time: 5 }],
  }]);
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 0 }, withDelegate, undefined, 'session-root', catalogue);

  const card = view.dom.window.document.querySelector('.mtx-card[data-id="session-delegate#t1"]');
  assert.ok(card, 'the subagent conversation is drawn');
  assert.equal(card.hasAttribute('data-subagent'), true, 'the client catalogue is enough to mark it');
  assert.ok(card.textContent.includes('subagent'), 'tag and subtitle: ' + card.textContent);
});

// 30 turns on the conversation with one small fork at turn 5: the shared history
// is turns 1..4, and turns 6..29 are an unbranched run. Long enough that folding
// it changes how much there is to see.
const LONG_LINE = [
  {
    sessionId: 'session-root',
    createdAt: 1,
    current: true,
    turns: Array.from({ length: 30 }, (_, i) => ({ turn: i + 1, text: 'root ' + (i + 1), time: i + 1 })),
  },
  {
    sessionId: 'session-short-fork',
    parentSessionId: 'session-root',
    createdAt: 2,
    forkTurn: 5,
    turns: [1, 2, 3, 4, 5, 6, 7].map((turn) => ({ turn, text: 'fork ' + turn, time: turn })),
  },
];

test('a coincidental repeat does not drag a fork down the parent line', async (t) => {
  // Reported: the branch named "readme" was attached after the current session
  // instead of at its fork point. Real cause: the shared-turn check kept the LAST
  // prompt that matched, and the same "1" had been sent on both sides at turn 42 —
  // so the branch was hung from turn 42, not from the turn 38 it left.
  const versions = [
    {
      sessionId: 'session-root',
      createdAt: 1,
      current: true,
      turns: [1, 2, 3, 4, 5, 6].map((n) => ({ turn: n, text: n <= 4 ? 'shared ' + n : 'root ' + n, time: n })),
    },
    {
      sessionId: 'session-fork',
      parentSessionId: 'session-root',
      createdAt: 2,
      forkTurn: 4,
      turns: [
        ...[1, 2, 3, 4].map((n) => ({ turn: n, text: 'shared ' + n, time: n })),
        { turn: 5, text: 'fork five', time: 5 },
        { turn: 6, text: 'root 6', time: 6 },
      ],
    },
  ];
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 0 }, versions);
  const byId = new Map(view.links().map((l) => [l.id, l]));

  assert.equal((byId.get('session-fork#t5') || {}).parent, 'session-root#t4',
    'the fork hangs off the turn it left from: ' + JSON.stringify(view.links().map((l) => l.id + '<' + l.parent)));
  assert.equal((byId.get('session-fork#t6') || {}).parent, 'session-fork#t5',
    'and its own later turn keeps following it, even though its text repeats the parent\'s');
});

test('a long run on one branch folds too, not only the shared history', async (t) => {
  // 30 turns on the conversation with one small fork at turn 5: the shared
  // history is turns 1..4, and turns 6..29 are the unbranched run that only this
  // line continues on. Neither decides anything, so with the default threshold of
  // two — the smallest run a fold can hide — both fold, and what stays drawn is
  // the origin, the fork point and the head.
  const longLine = LONG_LINE;
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' }, longLine);
  const cards = () => [...view.dom.window.document.querySelectorAll('.mtx-card[data-fold]')];
  const titles = () => cards().map((c) => c.querySelector('.mtx-card-title').textContent);

  assert.equal(cards().length, 2, 'both stretches fold: ' + titles().join(' / '));
  assert.ok(titles().includes('4 shared turns'), 'the shared history above the fork: ' + titles().join(' / '));
  assert.ok(titles().includes('24 turns in a row'), 'the run this branch continues on: ' + titles().join(' / '));

  const ids = view.cardIds();
  assert.ok(ids.includes('session-root#t30'), 'the turn you are at stays drawn');
  assert.ok(!ids.includes('session-root#t20'), 'the middle of the long run is hidden');
  assert.ok(ids.includes('session-root#t5'), 'while the turn the branches part at stays');
  assert.ok(!ids.includes('session-root#t1'), 'and so is the middle of the shared history');

  const links = view.links();
  const runFold = cards()[1].getAttribute('data-id');
  assert.equal((links.find((l) => l.id === runFold) || {}).parent, 'session-root#t5',
    'the run fold hangs off the turn before it');
  assert.equal((links.find((l) => l.id === 'session-root#t30') || {}).head, true,
    'the head of the line is never hidden inside a fold');

  // There is no in-place unfold to toggle any more: what matters is that both
  // stretches are drawn as folds at the default threshold, and that the head and
  // the fork point survive them.
  assert.ok(!view.cardIds().includes('session-root#t1'), 'the shared run stays folded');
  assert.ok(!view.cardIds().includes('session-root#t20'), 'and so does the long run');
});

// A tag is the reader saying "this turn matters". A fold is the tree saying
// "these turns decide nothing". The tag wins: a tagged turn is never hidden
// inside a fold, and it is drawn with the note that was written on it.
const TAGGED_LINE = Array.from({ length: 30 }, (_, i) => (i + 1 === 12
  ? { turn: i + 1, text: 'line turn ' + (i + 1), time: i + 1, tag: { note: '**the good one**', time: 99 } }
  : { turn: i + 1, text: 'line turn ' + (i + 1), time: i + 1 }));

test('a tagged turn is drawn on its own, with its note, and splits the fold', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' },
    [{ sessionId: 'session-root', createdAt: 1, current: true, turns: TAGGED_LINE }]);

  const ids = view.cardIds();
  assert.ok(ids.includes('session-root#t12'), 'the tagged turn is never hidden: ' + ids.join(','));
  assert.ok(ids.includes('session-root#t30'), 'and the head still stays drawn');
  assert.ok(!ids.includes('session-root#t20'), 'while the untagged middle is folded');

  const cards = [...view.dom.window.document.querySelectorAll('.mtx-card[data-tag]')];
  assert.equal(cards.length, 1, 'exactly the tagged turn carries the mark');
  assert.equal(cards[0].getAttribute('data-id'), 'session-root#t12');
  assert.equal(cards[0].querySelector('.mtx-card-mark').textContent, 'tag', 'the badge says what it is');
  assert.equal(cards[0].querySelector('.mtx-card-note strong').textContent, 'the good one',
    'and the note is drawn as the Markdown it was written in');

  const folds = [...view.dom.window.document.querySelectorAll('.mtx-card[data-fold]')];
  assert.equal(folds.length, 2, 'the tag splits the run into a fold on each side');
});

// The swap rule, in the form it was asked for: bringing a version that is
// collected in the tree back out puts the one you were reading away; a version
// that is already in the main chat just opens; a node of the version on screen
// only returns to the Chat tab.
function withArchived(sessionIds) {
  return VERSIONS.map((v) => (sessionIds.includes(v.sessionId) ? Object.assign({}, v, { archived: true }) : v));
}
function recording(posts, versions) {
  return async (url, options) => {
    if (options && options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ versions }) };
  };
}

test('bringing a collected version back out puts the current one away', async (t) => {
  const posts = [];
  const versions = withArchived(['session-root']);
  const view = await mountView(t, { dropEmptyForks: true }, versions, recording(posts, versions), 'session-fork');

  await view.clickCard('session-root#root');
  assert.ok(posts.some((p) => p.action === 'demote' && p.sessionId === 'session-fork'),
    'the version you were reading goes back into the tree: ' + JSON.stringify(posts));
  assert.ok(posts.some((p) => p.action === 'activate' && p.sessionId === 'session-root'),
    'and the one you clicked is brought out of it');
  assert.ok(view.opened.includes('session-root'), 'then it is opened');
});

test('a version already in the main chat just opens — nothing is put away', async (t) => {
  // Reported: a node that had been moved to the main chat still collected the
  // current conversation. It must not: that node is there on purpose.
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, recording(posts, VERSIONS), 'session-fork');

  await view.clickCard('session-root#root');
  assert.deepEqual(posts, [], 'no archiving, no unarchiving');
  assert.ok(view.opened.includes('session-root'), 'it just opens');
});

test('a node of the version on screen only goes back to the Chat tab', async (t) => {
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, recording(posts, VERSIONS), 'session-fork');

  await view.clickCard('session-fork#t17');
  assert.deepEqual(posts, [], 'nothing is archived and nothing is brought out');
  assert.deepEqual(view.opened, [], 'and the app is not asked to navigate anywhere');
  assert.equal(view.tabClicks.length, 1, 'the Chat tab is brought forward instead');
});

test('a version that is still generating a reply is left alone', async (t) => {
  const versions = withArchived(['session-root'])
    .map((v) => (v.sessionId === 'session-fork' ? Object.assign({}, v, { running: true }) : v));
  const posts = [];
  const view = await mountView(t, { dropEmptyForks: true }, versions, recording(posts, versions), 'session-fork');

  await view.clickCard('session-root#root');
  assert.ok(!posts.some((p) => p.action === 'demote'),
    'archiving mid-turn would hide work that is still arriving, so it is skipped');
  assert.ok(posts.some((p) => p.action === 'activate' && p.sessionId === 'session-root'),
    'the version you clicked is still brought out');
});

test('a family with nothing worth folding draws no fold and no outline', async (t) => {
  // Two turns and no branches: the only thing a fold could hide is one turn,
  // which trades a card for a card.
  const flat = [{
    sessionId: 'session-only',
    createdAt: 1,
    current: true,
    turns: [
      { turn: 1, text: 'one', time: 1 },
      { turn: 2, text: 'two', time: 2 },
    ],
  }];
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' }, flat, undefined, 'session-only');
  assert.equal(view.foldCard(), null, 'nothing is folded');
  await view.hoverCard('session-only#t1');
  assert.equal(view.outlineItems().length, 0, 'and a plain card opens no outline at all');
});

test('the outline shows the files the open turn produced, as names', async (t) => {
  const line = Array.from({ length: 6 }, (_, i) => (i + 1 === 2
    ? { turn: 2, text: 'write it', time: 2, files: ['/repo/src/alpha.ts', '/repo/src/beta.ts'] }
    : { turn: i + 1, text: 'turn ' + (i + 1), time: i + 1 }));
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' },
    [{ sessionId: 'session-root', createdAt: 1, current: true, turns: line }]);

  await view.hoverCard(view.foldCard().getAttribute('data-id'));
  const chips = () => [...view.dom.window.document.querySelectorAll('.mtx-outline-file')];
  assert.equal(chips().length, 0, 'the first turn wrote nothing, so nothing is listed');

  await view.hoverOutlineRow(2);
  assert.deepEqual(chips().map((el) => el.textContent), ['alpha.ts', 'beta.ts'],
    'the names are shown, not the whole path');
  assert.equal(chips()[0].getAttribute('title'), '/repo/src/alpha.ts',
    'and the full path is on hand for the curious');
});

test('a turn fed from outside the family says where the material came from', async (t) => {
  const turns = Array.from({ length: 4 }, (_, i) => ({ turn: i + 1, text: 'turn ' + (i + 1), time: i + 1 }));
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 0 }, [{
    sessionId: 'session-root', createdAt: 1, current: true, turns: turns,
    incoming: [{ senderSessionId: 'child-outside-1234', kind: 'subagent-settled', summary: 'it settled', feedsTurn: 2 }],
  }]);

  const chips = [...view.dom.window.document.querySelectorAll('.mtx-card-ref')];
  assert.equal(chips.length, 1, 'the sender is named on the turn it fed');
  assert.equal(chips[0].textContent, '⇠ child-ou', 'by a short handle, not a wall of uuid');
  assert.equal(chips[0].getAttribute('title'), 'it settled', 'with the runtime account on hand');
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-edge-ref').length, 0,
    'and no arrow, because there is nothing on this canvas to point at');
});

test('material from a conversation on the canvas is drawn as a dashed arrow', async (t) => {
  const rootTurns = Array.from({ length: 4 }, (_, i) => ({ turn: i + 1, text: 'root ' + (i + 1), time: i + 1 }));
  const childTurns = Array.from({ length: 2 }, (_, i) => ({ turn: i + 1, text: 'child ' + (i + 1), time: 10 + i }));
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 0 }, [
    { sessionId: 'session-root', createdAt: 1, current: true, turns: rootTurns,
      incoming: [{ senderSessionId: 'session-child', kind: 'subagent-settled', summary: 'done', feedsTurn: 3 }] },
    { sessionId: 'session-child', parentSessionId: 'session-root', createdAt: 2, subagent: true, forkTurn: 0, turns: childTurns },
  ]);

  assert.equal(view.dom.window.document.querySelectorAll('.mtx-edge-ref').length, 1,
    'one dashed arrow, from the sender to the turn it fed');
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-card-ref').length, 0,
    'and no chip, because the sender is already on the canvas');
});

test('a tagged turn carries the commit every repository was on', async (t) => {
  const line = Array.from({ length: 6 }, (_, i) => (i + 1 === 2
    ? { turn: 2, text: 'write it', time: 2, tag: { note: '', time: 9, repos: [
        { path: '.', head: 'abcdef1234567890', branch: 'main' },
        { path: 'packages/inner', head: '1234567890abcdef' },
      ] } }
    : { turn: i + 1, text: 'turn ' + (i + 1), time: i + 1 }));
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' },
    [{ sessionId: 'session-root', createdAt: 1, current: true, turns: line }]);

  // A tagged turn is never folded, so the record cannot be read out of the fold
  // outline — it belongs to the turn's own card, next to its note.
  const card = view.dom.window.document.querySelector('.mtx-card[data-id="session-root#t2"]');
  assert.ok(card, 'the tagged turn is drawn on its own');
  const chips = [...card.querySelectorAll('.mtx-card-commit')];
  assert.deepEqual(chips.map((el) => el.textContent), ['abcdef1 .', '1234567 packages/inner'],
    'each repository is a short commit and its path');
  assert.equal(chips[0].getAttribute('title'), '. @ abcdef1234567890 (main)',
    'with the full commit and the branch on hand');
});

test('the left rail decides whether the cross-session layer is drawn', async (t) => {
  const rootTurns = Array.from({ length: 4 }, (_, i) => ({ turn: i + 1, text: 'root ' + (i + 1), time: i + 1 }));
  const childTurns = Array.from({ length: 2 }, (_, i) => ({ turn: i + 1, text: 'child ' + (i + 1), time: 10 + i }));
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 0 }, [
    { sessionId: 'session-root', createdAt: 1, current: true, turns: rootTurns,
      incoming: [
        { senderSessionId: 'session-child', kind: 'subagent-settled', summary: 'done', feedsTurn: 3 },
        { senderSessionId: 'outside-1234', kind: 'agent-message', summary: 'hi', feedsTurn: 2 },
      ] },
    { sessionId: 'session-child', parentSessionId: 'session-root', createdAt: 2, subagent: true, forkTurn: 0, turns: childTurns },
  ]);

  const rail = view.dom.window.document.querySelector('.mtx-rail-btn');
  assert.ok(rail, 'the panel keeps one control, standing on the left');
  assert.equal(rail.hasAttribute('data-on'), true, 'and it starts on, so nothing is hidden by default');
  assert.equal(rail.textContent.trim(), '', 'the control carries no words');
  assert.ok(rail.querySelector('svg'), 'only the glyph');
  assert.ok(rail.getAttribute('aria-label'), 'named for assistive technology even so');
  assert.match(rail.getAttribute('title'), /cross-session references/, 'and the tooltip says what it does');
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-edge-ref').length, 1, 'with the arrow drawn');
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-card-ref').length, 1, 'and the mark beside it');

  await view.clickRail();
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-edge-ref').length, 0,
    'turning it off takes the cross-session arrows away');
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-card-ref').length, 0,
    'and the marks that stood in for the senders it could not point at');
  assert.equal(rail.hasAttribute('data-on'), false, 'and the control says so');
  assert.equal(JSON.parse(view.dom.window.localStorage.getItem('dsh-tree-view:prefs')).showReferences, false,
    'the choice outlives the panel');

  await view.clickRail();
  assert.equal(view.dom.window.document.querySelectorAll('.mtx-edge-ref').length, 1, 'and back on again');
});

test('turning the layer off folds the turns it was holding open', async (t) => {
  // Six turns, and the second one took material from outside. While that layer is
  // drawn the turn is a landmark; with it hidden there is nothing left to keep the
  // canvas open for, so it folds with the rest of the stretch.
  const line = Array.from({ length: 6 }, (_, i) => ({ turn: i + 1, text: 'turn ' + (i + 1), time: i + 1 }));
  const view = await mountView(t, { dropEmptyForks: true, foldSharedAt: 'default' },
    [{ sessionId: 'session-root', createdAt: 1, current: true, turns: line,
       incoming: [{ senderSessionId: 'outside-1', kind: 'agent-message', summary: 'x', feedsTurn: 2 }] }]);

  assert.ok(view.cardIds().includes('session-root#t2'), 'the fed turn is drawn while the layer is on');
  await view.clickRail();
  assert.ok(!view.cardIds().includes('session-root#t2'), 'and folds away once the layer is off');
  assert.deepEqual(
    [...view.dom.window.document.querySelectorAll('.mtx-card[data-fold] .mtx-card-title')].map((el) => el.textContent),
    ['5 shared turns'], 'one fold now covers the whole stretch');
});

test('a 0.1.7 host opens a version through uiWorkspace, not the removed sessions.open', async (t) => {
  // 0.1.7 moved "show this session in the main view" off the session controller
  // and onto the workspace service. The client used to require `sessions.open`
  // and throw without it, and DSH Desktop deselects a plugin whose client half
  // fails to boot — that is how the whole plugin went missing on 0.1.7.
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root', {}, 'modern');
  await view.clickCard('session-fork#t16');
  assert.deepEqual(view.workspaceOpened, ['session-fork'], 'the workspace service opens the version');
  assert.deepEqual(view.opened, [], 'the removed sessions.open is never called');
});

test('a host with no navigation service still boots, read-only, instead of failing', async (t) => {
  const view = await mountView(t, { dropEmptyForks: true }, VERSIONS, undefined, 'session-root', {}, 'bare');
  assert.ok(view.cardIds().length > 0, 'the tree is still drawn');
  await view.clickCard('session-fork#t16');
  assert.deepEqual(view.opened, []);
  assert.deepEqual(view.workspaceOpened, []);
});
