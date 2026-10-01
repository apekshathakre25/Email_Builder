'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const VIEW = fs.readFileSync(path.join(ROOT, 'views', 'index.ejs'), 'utf8');
const PATTERN_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'inbox-pattern.js'), 'utf8');
const FORM_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'form-persistence.js'), 'utf8');
const SEQUENCER_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'campaign-sequencer.js'), 'utf8');

const PATTERNS = [
  { id: 'pattern-1', name: 'Pattern 1', description: 'First safe profile' },
  { id: 'pattern-2', name: 'Pattern 2', description: 'Second safe profile' }
];

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: () => Promise.resolve(payload)
  };
}

function patternPage() {
  return `<!doctype html><html><body>
    <form id="email-form">
      <input id="inbox-pattern-search" list="inbox-pattern-options" disabled />
      <datalist id="inbox-pattern-options"></datalist>
      <input type="hidden" id="inbox-pattern-id" name="inbox-pattern-id" value="" />
      <span id="inbox-pattern-status"></span>
      <button type="button" id="inbox-pattern-retry" hidden>Retry</button>
    </form>
  </body></html>`;
}

async function bootPattern(fetchImpl) {
  const dom = new JSDOM(patternPage(), {
    url: 'https://localhost/interface',
    runScripts: 'outside-only'
  });
  const win = dom.window;
  win.fetch = fetchImpl;
  win.eval(PATTERN_SOURCE);
  await win.InboxPattern.ready;
  await tick();
  return { dom, win, byId: (id) => win.document.getElementById(id) };
}

test('retained interface includes the searchable Inbox Pattern controls and loader', () => {
  assert.match(VIEW, /for="inbox-pattern-search">Inbox Pattern</);
  assert.match(VIEW, /list="inbox-pattern-options"/);
  assert.match(VIEW, /id="inbox-pattern-id" name="inbox-pattern-id"/);
  assert.match(VIEW, /src="\/js\/inbox-pattern\.js"/);
});

test('pattern loader starts at Default and maps only returned names to IDs', async () => {
  const h = await bootPattern(() => Promise.resolve(response({ patterns: PATTERNS })));
  try {
    const input = h.byId('inbox-pattern-search');
    const hidden = h.byId('inbox-pattern-id');

    assert.equal(input.disabled, false);
    assert.equal(input.value, 'Default (existing behavior)');
    assert.equal(hidden.value, '');
    assert.deepEqual(
      Array.from(h.byId('inbox-pattern-options').options, (option) => option.value),
      ['Default (existing behavior)', 'Pattern 1', 'Pattern 2']
    );

    input.value = 'Pattern 2';
    input.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    assert.equal(hidden.value, 'pattern-2');
    assert.equal(h.win.InboxPattern.getSelectedName(), 'Pattern 2');

    input.value = 'not issued by the backend';
    input.dispatchEvent(new h.win.Event('input', { bubbles: true }));
    assert.equal(hidden.value, '');
    assert.equal(h.win.InboxPattern.getSelectedId(), '');
    assert.match(h.byId('inbox-pattern-status').textContent, /Choose a pattern/);
  } finally {
    h.dom.window.close();
  }
});

test('pattern loader exposes failure and retry states', async () => {
  let attempts = 0;
  const h = await bootPattern(() => {
    attempts += 1;
    return Promise.resolve(
      attempts === 1
        ? response({}, { ok: false, status: 503 })
        : response({ patterns: PATTERNS })
    );
  });

  try {
    assert.equal(h.byId('inbox-pattern-search').disabled, true);
    assert.equal(h.byId('inbox-pattern-retry').hidden, false);
    assert.match(h.byId('inbox-pattern-status').textContent, /Could not load/);

    h.byId('inbox-pattern-retry').click();
    await tick();

    assert.equal(attempts, 2);
    assert.equal(h.byId('inbox-pattern-search').disabled, false);
    assert.equal(h.byId('inbox-pattern-retry').hidden, true);
    assert.equal(h.byId('inbox-pattern-search').value, 'Default (existing behavior)');
  } finally {
    h.dom.window.close();
  }
});

test('retained Inbox Pattern selection survives same-tab draft restore', async () => {
  const dom = new JSDOM(patternPage(), {
    url: 'https://localhost/interface',
    runScripts: 'outside-only'
  });
  const win = dom.window;
  win.document.body.setAttribute('data-user-email', 'operator@example.com');
  win.sessionStorage.setItem('opterite:campaign-form', JSON.stringify({
    version: 1,
    user: 'operator@example.com',
    fields: { inboxPatternId: 'pattern-2' }
  }));
  win.fetch = (url) => Promise.resolve(
    String(url) === '/email-config'
      ? response({ success: true, hasSmtpPass: false })
      : response({ patterns: PATTERNS })
  );

  try {
    win.eval(FORM_SOURCE);
    win.eval(PATTERN_SOURCE);
    await win.InboxPattern.ready;
    await tick();

    assert.equal(win.document.getElementById('inbox-pattern-id').value, 'pattern-2');
    assert.equal(win.document.getElementById('inbox-pattern-search').value, 'Pattern 2');

    const input = win.document.getElementById('inbox-pattern-search');
    input.value = 'Pattern 1';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));

    const draft = JSON.parse(win.sessionStorage.getItem('opterite:campaign-form'));
    assert.equal(draft.fields.inboxPatternId, 'pattern-1');
  } finally {
    dom.window.close();
  }
});

function sequencerPage(patternId) {
  return `<!doctype html><html><body>
    <form id="email-form">
      <input id="file-ids" value="campaign-1" />
      <input id="limit" value="20" />
      <input type="radio" id="bulk" checked />
      <input type="hidden" id="inbox-pattern-id" value="${patternId}" />
      <div><button type="submit" id="send-email">Send Email</button></div>
    </form>
  </body></html>`;
}

function bootSequencer({ initialLane, polledLane, patternId = 'pattern-2', reload = false }) {
  const dom = new JSDOM(sequencerPage(patternId), {
    url: 'https://localhost/interface',
    runScripts: 'outside-only'
  });
  const win = dom.window;
  const calls = [];
  win.InboxPattern = {
    ready: Promise.resolve(),
    getSelectedId: () => patternId
  };
  win.fetch = (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method, body });

    if (String(url) === '/campaign-lane/claim') return Promise.resolve(response(initialLane));
    if (String(url).startsWith('/campaign-lane?')) return Promise.resolve(response(polledLane));
    if (String(url) === '/campaign-lane/start') return Promise.resolve(response({ success: true }));
    return Promise.resolve(response({ success: true }));
  };

  if (reload) win.sessionStorage.setItem('opterite:lane-waiting', 'campaign-1');
  win.document.getElementById('email-form').requestSubmit = () => {};
  win.eval(SEQUENCER_SOURCE);

  return { dom, win, calls };
}

function startCalls(h) {
  return h.calls.filter((call) => call.url === '/campaign-lane/start');
}

test('immediate retained-interface lane start carries the selected pattern ID', async () => {
  const h = bootSequencer({
    initialLane: { state: 'QUEUED', position: 0, cleared: true }
  });
  try {
    assert.equal(await h.win.CampaignSequencer.requestSend(), true);
    assert.deepEqual(startCalls(h).map((call) => call.body), [
      { campaignId: 'campaign-1', inboxPatternId: 'pattern-2' }
    ]);
  } finally {
    h.dom.window.close();
  }
});

test('queued retained-interface lane start retains the selected pattern ID', async () => {
  const h = bootSequencer({
    initialLane: { state: 'WAITING', position: 2, cleared: false },
    polledLane: { state: 'QUEUED', position: 0, cleared: true }
  });
  try {
    assert.equal(await h.win.CampaignSequencer.requestSend(), true);
    assert.deepEqual(startCalls(h).map((call) => call.body), [
      { campaignId: 'campaign-1', inboxPatternId: 'pattern-2' }
    ]);
  } finally {
    h.dom.window.close();
  }
});

test('reload recovery lane start retains the persisted selected pattern ID', async () => {
  const h = bootSequencer({
    initialLane: { state: 'QUEUED', position: 0, cleared: true },
    patternId: 'pattern-1',
    reload: true
  });
  try {
    await tick();

    assert.deepEqual(startCalls(h).map((call) => call.body), [
      { campaignId: 'campaign-1', inboxPatternId: 'pattern-1' }
    ]);
  } finally {
    h.dom.window.close();
  }
});
