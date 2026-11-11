// CopilotKit costs about 355 packages to adopt. Most of that is weight, which is annoying but honest;
// a few of those packages are the kind of thing that should never surprise us six months from now. This
// file pins the state that was *measured* at adoption, so a change in it is a change someone has to
// explain.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');

const manifestOf = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
};

// Every installed copy of a package, hoisted or nested: [dir, version].
function copiesOf(name) {
  const found = [];
  const queue = [NM];
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('@')) {
        let scoped;
        try { scoped = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
        for (const child of scoped) {
          if (!child.isDirectory() || child.name === 'node_modules') continue;
          const pkgDir = path.join(full, child.name);
          const manifest = manifestOf(pkgDir);
          if (manifest && manifest.name === name) found.push([pkgDir, manifest.version]);
          queue.push(path.join(pkgDir, 'node_modules'));
        }
        continue;
      }
      const manifest = manifestOf(full);
      if (manifest && manifest.name === name) found.push([full, manifest.version]);
      queue.push(path.join(full, 'node_modules'));
    }
  }
  return found;
}

// What the app itself resolves, as opposed to what some dependency resolves out of its own subtree.
// Resolving `<name>/package.json` gives the copy that a require from `fromDir` would actually get.
function resolvedIn(name, fromDir) {
  return require.resolve(`${name}/package.json`, { paths: [fromDir] });
}
const versionOfResolution = (name, fromDir) => JSON.parse(fs.readFileSync(resolvedIn(name, fromDir), 'utf8')).version;

// Which shipped CopilotKit files actually load a package. A call pattern is matched rather than the bare
// name because a bundled copy of the manifest mentions every dependency as text.
function scanForLoad(names) {
  const escape = (value) => value.replace(/[\\/^$.]/g, '\\$&');
  const patterns = names.map((name) => new RegExp(`require\\(["']${escape(name)}["']\\)|from\\s+["']${escape(name)}["']`));
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(cjs|mjs|js)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      patterns.forEach((pattern, index) => {
        if (pattern.test(source)) hits.push(`${path.relative(ROOT, full)} loads ${names[index]}`);
      });
    }
  };
  for (const name of ['runtime', 'react-core', 'shared', 'core']) {
    const dist = path.join(NM, '@copilotkit', name, 'dist');
    if (fs.existsSync(dist)) walk(dist);
  }
  return hits;
}

test('no install-time script is approved for anything CopilotKit brought in', () => {
  // @scarf/scarf — the analytics package CopilotKit depends on — phones home from a postinstall hook in
  // whatever package installs it. npm's allowScripts gate is what stopped it here, and this assertion is
  // what stops the next `npm install` from being answered with a yes.
  const allowScripts = manifestOf(ROOT).allowScripts || {};
  const granted = Object.keys(allowScripts).filter((key) => allowScripts[key] === true);
  assert.deepEqual(granted.sort(), ['better-sqlite3@13.0.3', 'esbuild@0.28.2', 'fsevents@2.3.3'],
    'an install script was approved; review allowScripts before accepting a new one');
  assert.ok(!granted.some((key) => /scarf|copilotkit|segment/i.test(key)), `telemetry-capable package approved: ${granted.join(', ')}`);
});

test('the analytics packages CopilotKit ships stay unarmed', () => {
  // @scarf/scarf phones home from an install-time script in whatever package declares it. npm's
  // allowScripts gate refused it here, so first: no CopilotKit package may declare such a script at all.
  for (const name of ['runtime', 'react-core', 'shared', 'core', 'a2ui-renderer', 'license-verifier']) {
    const dir = path.join(NM, '@copilotkit', name);
    if (!fs.existsSync(dir)) continue;
    const manifest = manifestOf(dir);
    const installHooks = Object.keys(manifest.scripts || {}).filter((script) => /^(pre|post)?install$|^prepare$|^prepack$/.test(script));
    assert.deepEqual(installHooks, [], `@copilotkit/${name} now declares install-time scripts: ${installHooks.join(', ')}`);
  }

  // Second: scarf must not be reachable from shipped code either. Matched as a call, not as a bare name
  // — dist/package.cjs embeds a copy of the manifest, so package names appear in shipped files as text
  // while being required nowhere.
  const scarfed = scanForLoad(['@scarf/scarf']);
  assert.deepEqual(scarfed, [], scarfed.join('; '));

  // @segment/analytics-node, by contrast, IS loaded — by @copilotkit/shared's own telemetry client, which
  // builds an Analytics instance around a hardcoded write key. Recorded here because it is the reason the
  // kill switch is not optional: the guard in that constructor (isTelemetryDisabled() → return before
  // `new Analytics`) is the only thing standing between this app and a second, batched, always-on sink.
  // test/telemetry.test.js is what proves the guard holds and that neither sink is reached.
  const segmentLoaded = scanForLoad(['@segment/analytics-node']);
  assert.ok(segmentLoaded.length > 0, 'the Segment client vanished from shared; update this note');
  assert.ok(segmentLoaded.every((line) => line.includes('telemetry')), `Segment is required from outside the telemetry client: ${segmentLoaded.join('; ')}`);
});

test('the two zod majors stay in their own subtrees', () => {
  // The repo is on zod 4; @copilotkit/runtime, @copilotkit/shared, @ag-ui/client and a2ui each carry a
  // nested zod 3.25.76. That is survivable while neither reaches into the other's schemas — a hoist would
  // make it a runtime type error deep inside the library instead.
  const appZod = versionOfResolution('zod', ROOT);
  assert.match(appZod, /^4\./, `the app should resolve zod 4, got ${appZod}`);
  const runtimeZod = versionOfResolution('zod', path.join(NM, '@copilotkit', 'runtime'));
  assert.match(runtimeZod, /^3\./, `the runtime should keep its own zod 3, got ${runtimeZod}`);
});

test('express 4 still serves the app despite the express 5 copies', () => {
  // src/app.js depends on Express 4 syntax (app.get('*')), and the runtime ships a handler typed for both.
  // Two express 5 copies sit in the tree — @modelcontextprotocol/sdk's predates this migration — and a
  // hoist would break the catch-all with a "path params" TypeError at startup.
  const nested = copiesOf('express').filter(([, version]) => version.startsWith('5'));
  assert.ok(nested.length > 0, 'the express 5 copies are gone; this test is guarding nothing');
  assert.equal(versionOfResolution('express', ROOT).split('.')[0], '4', 'the app must keep resolving express 4: app.get("*") is invalid in express 5');
});

test('packages that break when duplicated are not duplicated', () => {
  // react: two copies means two reconcilers and "Invalid hook call" in the chat UI.
  // better-sqlite3: two native modules opening the same data/portfolio.sqlite means two page caches.
  // recharts: the whole reason the summary page renders; a second copy is ~100 KB of bundle for nothing.
  for (const name of ['react', 'react-dom', 'recharts', 'better-sqlite3']) {
    const copies = copiesOf(name);
    assert.equal(copies.length, 1, `${name} has ${copies.length} copies: ${copies.map(([dir, version]) => `${dir}@${version}`).join(', ')}`);
  }
});

test('rxjs is resolved from the package that subscribes to it', () => {
  // CopilotKit brought a genuinely awkward tree: @ag-ui/client and four @copilotkit packages pin rxjs at
  // *exactly* 7.8.1 and therefore each carry their own nested copy, while the `^7.8.1` dependents share a
  // hoisted 7.8.2. Seven copies, and that part is correct — it is what the pins ask for. What it makes a
  // trap is a test importing rxjs to drive one of those libraries: `require('rxjs')` from the repo root
  // gets 7.8.2, while @ag-ui/client's own operators run on its nested 7.8.1, so the Observable handed to
  // `verifyEvents` is built by a different copy than the one subscribing to it.
  //
  // test/aguiBridge.test.js resolves it through the requiring package for exactly this reason. Asserted
  // here because the two copies becoming one is the sign that the workaround should be deleted, not kept.
  const copies = copiesOf('rxjs');
  assert.ok(copies.length > 1, `rxjs flattened to one copy (${copies[0][1]}); the bridge test's resolution can go back to require('rxjs')`);
  // …and the hoisted one is 7.8.2 while the nested ones are 7.8.1, which is the actual hazard.
  const versions = new Map(copies);
  assert.notEqual(
    versions.get(path.join(NM, 'rxjs')),
    versions.get(path.join(NM, '@ag-ui', 'client', 'node_modules', 'rxjs')),
    'root and client copies are now the same version, so a cross-copy observable would be harmless',
  );

  const viaClient = require.resolve('rxjs', { paths: [require.resolve('@ag-ui/client')] });
  const viaRoot = require.resolve('rxjs');
  assert.notEqual(viaClient, viaRoot, 'the client copy and the root copy are now the same file; use a plain require');
  assert.ok(viaClient.includes(path.join('@ag-ui', 'client', 'node_modules', 'rxjs')), `the bridge test would no longer be importing the client's own copy: ${viaClient}`);

  // And it stays nobody's direct dependency: adding it to package.json looks like tidying this up and can
  // instead change which copy wins.
  const manifest = manifestOf(ROOT);
  for (const field of ['dependencies', 'devDependencies']) {
    assert.ok(!('rxjs' in (manifest[field] || {})), `rxjs was added to ${field}; the bridge test resolves it from @ag-ui/client instead`);
  }
});

test('the runtime shares our LangChain instead of bringing its own', () => {
  // @copilotkit/runtime lists @langchain/core, @langchain/openai and langchain as *peer* dependencies:
  // it expects to run against the model layer the app already has. That is the arrangement the migration
  // depends on — agent.js builds the LangChain agent, checks instances, and streams its messages, and a
  // second copy of the library would make those checks fail in the middle of a run.
  const runtimeManifest = manifestOf(path.join(NM, '@copilotkit', 'runtime'));
  for (const name of ['@langchain/core', '@langchain/openai', 'langchain']) {
    assert.ok(!(name in (runtimeManifest.dependencies || {})), `${name} became a hard dependency of the runtime`);
    assert.ok(name in (runtimeManifest.peerDependencies || {}), `${name} is no longer a peer; the assumption above changed`);
  }
  const runtimeDir = path.join(NM, '@copilotkit', 'runtime');
  for (const name of ['@langchain/core', 'langchain']) {
    assert.equal(resolvedIn(name, runtimeDir), resolvedIn(name, ROOT), `${name} resolves to two different copies`);
  }
});
