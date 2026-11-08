'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'theme.js')).href);

test('no saved theme gives the default dark colours', async () => {
  const { cssVars, PRESETS } = await load();
  const v = cssVars(null);
  assert.strictEqual(v['--bg'], PRESETS.dark.colors.bg);
  assert.strictEqual(v['--panel'], PRESETS.dark.colors.panel);
  assert.strictEqual(v['--bg-image'], 'none');
  assert.strictEqual(v['color-scheme'], 'dark');
});

test('presets fill in colours; custom colours override them', async () => {
  const { cssVars, PRESETS } = await load();
  assert.strictEqual(cssVars({ preset: 'light' })['color-scheme'], 'light');
  assert.strictEqual(cssVars({ preset: 'crimson' })['--panel'], PRESETS.crimson.colors.panel);
  const v = cssVars({ preset: 'custom', colors: { accent: '#ff00ff' } });
  assert.strictEqual(v['--accent'], '#ff00ff');
  assert.strictEqual(v['--text'], PRESETS.dark.colors.text, 'missing colours fall back to the dark preset');
});

test('a background image makes panels see-through and the page background transparent', async () => {
  const { cssVars } = await load();
  const v = cssVars({ image: { url: 'file:///C:/x/bg.png', fit: 'tile', dim: 0.5, blur: 4 }, panelOpacity: 0.6 });
  assert.strictEqual(v['--bg'], 'transparent');
  assert.match(v['--panel'], /^rgba\(26, 29, 34, 0\.6\)$/);
  assert.strictEqual(v['--bg-image'], 'url("file:///C:/x/bg.png")');
  assert.strictEqual(v['--bg-repeat'], 'repeat');
  assert.strictEqual(v['--bg-dim'], '0.5');
  assert.strictEqual(v['--bg-blur'], '4px');
  assert.strictEqual(cssVars({ panelOpacity: 0.3 })['--panel'], cssVars(null)['--panel'], 'opacity only applies with an image');
});

test('text on the accent colour stays readable', async () => {
  const { cssVars } = await load();
  assert.strictEqual(cssVars({ colors: { accent: '#2d7ff9' } })['--on-accent'], '#ffffff');
  assert.strictEqual(cssVars({ colors: { accent: '#ffe14d' } })['--on-accent'], '#111111');
});
