import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');

// The tag button is one entry in the assistant action row DSH already draws. It
// receives a durable message id and nothing else, so these tests are about the
// two things that follow from that: the tag is written by message id, and the
// row's own click is the gesture that takes it off again.
async function mountAction(t, messageTags) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://tree-view.test/',
  });
  const posts = [];
  dom.window.fetch = async (url, options) => {
    if (options && options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return {
      ok: true,
      json: async () => ({
        sessionId: 'session-test',
        archiveSupport: { ok: true, read: true, hide: true, show: true, missing: [] },
        messageTags: messageTags,
        versions: [{ sessionId: 'session-test', createdAt: 1, current: true, turns: [{ turn: 1, text: 'hi', time: 2 }] }],
      }),
    };
  };
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let component;
  const slots = {
    inject(_name, register) { register(); },
    register(spec, view) {
      if (spec.name === 'conversation.chat.assistant-actions') component = view;
      return () => {};
    },
  };
  let plugin;
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      plugin = factory(name => {
        assert.equal(name, 'react');
        return React;
      });
    },
  };
  runInNewContext(bundle, {
    window: dom.window, document: dom.window.document, console, setTimeout, clearTimeout,
  }, { filename: 'lib/client.js' });
  const ctx = {
    get(name) { return name === 'slots' ? slots : undefined; },
    effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : undefined; },
  };
  ctx.inject = (deps, callback) => callback(ctx);
  plugin.apply(ctx);
  assert.equal(typeof component, 'function', 'the tag action registers into the assistant action row');
  await act(async () => root.render(React.createElement(component, { messageId: 'a1', sessionId: 'session-test' })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return { dom, posts };
}

test('clicking the button tags the turn and offers the note', async (t) => {
  const { dom, posts } = await mountAction(t, {});
  const button = dom.window.document.querySelector('.mtx-tag-act');
  assert.ok(button, 'the row carries a tag control');
  assert.equal(button.getAttribute('data-tagged'), null, 'and an untagged turn does not claim otherwise');

  await act(async () => button.click());
  assert.deepEqual(posts.at(-1), { action: 'tag', sessionId: 'session-test', messageId: 'a1', note: '' },
    'the click writes the tag against the message the row named');

  const editor = dom.window.document.querySelector('.mtx-tag-input');
  assert.ok(editor, 'and opens the note editor, because the note is optional but offered');
  // The row is a horizontal cluster: an editor that joined its layout would push
  // the row apart and cover the controls after it. It has to be a popover INSIDE
  // the wrapper, so the wrapper is what the row lays out.
  assert.equal(dom.window.document.querySelector('.mtx-tag .mtx-tag-edit') === editor.parentElement,
    true, 'the editor is a popover inside the tag wrapper, not a row item');

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(editor, '**why**');
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const save = [...dom.window.document.querySelectorAll('.mtx-tag-actions button')][0];
  await act(async () => save.click());
  assert.deepEqual(posts.at(-1), { action: 'tag', sessionId: 'session-test', messageId: 'a1', note: '**why**' },
    'saving writes the note through the same action');
});

test('the note editor is kept inside the window', async (t) => {
  // The action row sits under a message, so a message near the top of the viewport
  // pushed an editor that always opened upwards right off the page, and the note
  // could not be read while it was written.
  const { dom } = await mountAction(t, {});
  const button = dom.window.document.querySelector('.mtx-tag-act');
  await act(async () => button.click());
  const editor = dom.window.document.querySelector('.mtx-tag-edit');
  assert.ok(editor, 'the editor is open');

  // jsdom lays nothing out, so the two boxes are stated instead of measured.
  button.getBoundingClientRect = () => ({ top: 2, bottom: 26, left: 700, right: 740, width: 40, height: 24 });
  Object.defineProperty(editor, 'offsetWidth', { value: 320, configurable: true });
  Object.defineProperty(editor, 'offsetHeight', { value: 200, configurable: true });
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event('resize')); });

  const left = Number(/([-\d.]+)px/.exec(editor.style.left)[1]);
  const top = Number(/([-\d.]+)px/.exec(editor.style.top)[1]);
  assert.equal(top, 36, 'with no room above, it opens below the button: ' + editor.style.top);
  assert.equal(left, 420, 'right-aligned with the button while it fits');
  assert.ok(left >= 8 && left + 320 <= dom.window.innerWidth,
    'and inside the window horizontally: ' + editor.style.left);
  assert.ok(top >= 8 && top + 200 <= dom.window.innerHeight,
    'and vertically: ' + editor.style.top);
});

test('clicking a tagged turn takes the tag off again', async (t) => {
  const { dom, posts } = await mountAction(t, { a1: { note: 'x', time: 1 } });
  const button = dom.window.document.querySelector('.mtx-tag-act');
  assert.equal(button.getAttribute('data-tagged'), '', 'a tagged turn reads as pressed');

  await act(async () => button.click());
  assert.deepEqual(posts.at(-1), { action: 'untag', sessionId: 'session-test', messageId: 'a1' });
});
