(function () {
  'use strict';

  var ENDPOINT = '/api/patterns';
  var DEFAULT_NAME = 'Default (existing behavior)';
  var patterns = [];
  var loaded = false;
  var readyResolve;
  var ready = new Promise(function (resolve) { readyResolve = resolve; });

  function byId(id) {
    return document.getElementById(id);
  }

  function setStatus(message, isError) {
    var status = byId('inbox-pattern-status');
    if (!status) return;
    status.textContent = message || '';
    status.className = 'field__hint';
    status.style.color = isError ? 'var(--danger-600)' : '';
  }

  function selectedPattern() {
    var hidden = byId('inbox-pattern-id');
    if (!loaded || !hidden || !hidden.value) return null;
    return patterns.find(function (pattern) { return pattern.id === hidden.value; }) || null;
  }

  function syncSelection() {
    var input = byId('inbox-pattern-search');
    var hidden = byId('inbox-pattern-id');
    if (!input || !hidden || !loaded) return;

    var text = String(input.value || '').trim();
    if (!text || text === DEFAULT_NAME) {
      input.value = DEFAULT_NAME;
      hidden.value = '';
      setStatus('Uses the existing email generation behavior.', false);
      return;
    }

    var match = patterns.find(function (pattern) { return pattern.name === text; });
    hidden.value = match ? match.id : '';
    setStatus(
      match ? (match.description || 'Selected Inbox Pattern: ' + match.name) : 'Choose a pattern from the list, or select Default.',
      !match
    );
  }

  function renderOptions() {
    var list = byId('inbox-pattern-options');
    if (!list) return;
    list.textContent = '';

    var defaultOption = document.createElement('option');
    defaultOption.value = DEFAULT_NAME;
    list.appendChild(defaultOption);

    patterns.forEach(function (pattern) {
      var option = document.createElement('option');
      option.value = pattern.name;
      list.appendChild(option);
    });
  }

  async function loadPatterns() {
    var input = byId('inbox-pattern-search');
    var hidden = byId('inbox-pattern-id');
    var retry = byId('inbox-pattern-retry');
    if (!input || !hidden) {
      readyResolve();
      return;
    }

    input.disabled = true;
    input.placeholder = 'Loading patterns…';
    if (retry) retry.hidden = true;
    setStatus('Loading Inbox Patterns…', false);

    try {
      var response = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);

      var payload = await response.json();
      patterns = Array.isArray(payload && payload.patterns) ? payload.patterns : [];
      loaded = true;
      renderOptions();

      var restored = patterns.find(function (pattern) { return pattern.id === hidden.value; });
      if (restored) input.value = restored.name;
      else {
        hidden.value = '';
        input.value = DEFAULT_NAME;
      }

      input.disabled = false;
      input.placeholder = 'Search Inbox Patterns';
      syncSelection();
    } catch (err) {
      loaded = false;
      input.disabled = true;
      input.value = '';
      input.placeholder = 'Patterns unavailable';
      if (retry) retry.hidden = false;
      setStatus('Could not load Inbox Patterns. Retry to select one; sending uses Default.', true);
    } finally {
      readyResolve();
    }
  }

  window.InboxPattern = {
    ready: ready,
    getSelectedId: function () {
      var selected = selectedPattern();
      return selected ? selected.id : '';
    },
    getSelectedName: function () {
      var selected = selectedPattern();
      return selected ? selected.name : DEFAULT_NAME;
    },
    retry: loadPatterns
  };

  window.addEventListener('DOMContentLoaded', function () {
    var input = byId('inbox-pattern-search');
    var retry = byId('inbox-pattern-retry');
    if (input) {
      input.addEventListener('input', syncSelection);
      input.addEventListener('change', syncSelection);
    }
    if (retry) retry.addEventListener('click', loadPatterns);
    loadPatterns();
  });
})();
