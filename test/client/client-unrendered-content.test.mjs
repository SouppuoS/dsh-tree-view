import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
const text = value => ({ type: 'text', text: value });

// The bubble is this plugin's own renderer, so the failure mode under test is
// not an exception: it is an empty bubble that reads as a deleted message.
// React and the DOM are real; the host services are doubles.
async function mount(t, content) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://message-edit.test/',
  });
  dom.window.localStorage.setItem('dsh-tree-view:style', 'chatgpt');
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ versions: [] }) });
  const previous = new Map();
  const browserErrors = [];
  const warnings = [];
  dom.window.addEventListener('error', event => browserErrors.push(event.error || event.message));
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
    assert.deepEqual(browserErrors, [], 'Browser event handlers must not throw');
  });
  let component;
  const slots = {
    inject(_name, register) { register(); },
    register(spec, view) {
      if (spec.name === 'conversation.chat.node' && spec.key === 'user') component = view;
      return () => {};
    },
  };
  let plugin;
  dom.window.__ModuleLoader__ = {
    load({ id, factory }) {
      assert.equal(id, 'dsh-tree-view');
      plugin = factory(name => {
        assert.equal(name, 'react');
        return React;
      });
    },
  };
  const consoleDouble = Object.create(console);
  consoleDouble.warn = (...args) => warnings.push(args);
  runInNewContext(bundle, {
    window: dom.window, document: dom.window.document, console: consoleDouble,
    setTimeout, clearTimeout,
  }, { filename: 'lib/client.js' });
  const ctx = {
    get(name) { return name === 'slots' ? slots : name === 'sessions' ? {
      open() {},
      list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { 'session-test': { id: 'session-test' } } }) },
    } : undefined; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') return dispose; },
  };
  ctx.inject = (deps, callback) => callback(ctx);
  plugin.apply(ctx);
  assert.equal(typeof component, 'function', 'The user-message slot must register');
  await act(async () => root.render(React.createElement(component, {
    sessionId: 'session-test',
    node: { data: { content, seq: 2 }, location: { turn: { turn: 1 } } },
    renderMessageImages: undefined,
  })));
  return { doc: dom.window.document, warnings };
}

test('content in an unknown shape shows a notice instead of an empty bubble', async t => {
  const { doc, warnings } = await mount(t, [{ type: 'document', url: 'file:///spec.pdf' }]);
  const bubble = doc.querySelector('.mtx-bubble');
  assert.ok(bubble, 'The bubble must still render');
  assert.match(bubble.textContent, /cannot draw/);
  const reported = warnings.filter(args => /cannot draw/.test(String(args[0])));
  assert.equal(reported.length, 1, 'The shape is reported exactly once');
  assert.match(String(reported[0][0]), /block types: document/);
});

test('drawable content renders normally and reports nothing', async t => {
  const { doc, warnings } = await mount(t, [text('Hello')]);
  assert.equal(doc.querySelector('.mtx-bubble').textContent, 'Hello');
  assert.equal(doc.querySelector('.mtx-lost'), null);
  assert.equal(warnings.filter(args => /cannot draw/.test(String(args[0]))).length, 0);
});

test('a partly drawable message keeps the text it does have', async t => {
  const { doc, warnings } = await mount(t, [text('Kept'), { type: 'document', url: 'x' }]);
  assert.equal(doc.querySelector('.mtx-bubble').textContent, 'Kept');
  assert.equal(doc.querySelector('.mtx-lost'), null);
  assert.equal(warnings.filter(args => /cannot draw/.test(String(args[0]))).length, 0);
});

test('blocks nested one level down are recovered rather than reported', async t => {
  const { doc, warnings } = await mount(t, { blocks: [text('Recovered')] });
  assert.equal(doc.querySelector('.mtx-bubble').textContent, 'Recovered');
  assert.equal(doc.querySelector('.mtx-lost'), null);
  assert.equal(warnings.filter(args => /cannot draw/.test(String(args[0]))).length, 0);
});

test('an empty message is not treated as unreadable content', async t => {
  const { doc, warnings } = await mount(t, []);
  assert.equal(doc.querySelector('.mtx-lost'), null);
  assert.equal(warnings.filter(args => /cannot draw/.test(String(args[0]))).length, 0);
});
