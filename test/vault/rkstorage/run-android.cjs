// Run only against a disposable emulator containing the instrumentation APK.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const C = require('crypto-js');
const fixture = require('../fixtures/legacy-14.32.json');
const [serial, output, selection = 'all'] = process.argv.slice(2);
if (!/^emulator-\d+$/.test(serial || '') || !output)
  throw Error('Pass disposable emulator serial and scratch output directory');
fs.mkdirSync(output, {recursive: true});
const adb =
  process.env.ADB ||
  path.join(process.env.HOME, 'Library/Android/sdk/platform-tools/adb');
const adbRun = args =>
  cp.spawnSync(adb, ['-s', serial, ...args], {
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120000,
  });
const check = (ok, label) => {
  if (!ok) throw Error(label);
};
const instrument = (operation, options = {}, killed = false) => {
  const args = [
    'shell',
    'am',
    'instrument',
    '-w',
    '-r',
    '-e',
    'operation',
    operation,
  ];
  for (const [name, value] of Object.entries(options))
    args.push('-e', name, value);
  args.push(
    'com.bitpay.wallet.test/com.bitpay.wallet.rkstorage.RKStorageTestRunner',
  );
  const run = adbRun(args);
  const text = run.stdout.toString();
  if (killed) {
    check(
      text.includes('Process crashed') ||
        text.includes('INSTRUMENTATION_FAILED'),
      'kill-control-did-not-terminate',
    );
    return {
      terminated: true,
      phases: [
        ...text.matchAll(/INSTRUMENTATION_STATUS: sqlitePhase=(\S+)/g),
      ].map(m => m[1]),
    };
  }
  const match = text.match(/INSTRUMENTATION_RESULT: results=(\{.*\})/);
  if (!match || !text.includes('INSTRUMENTATION_CODE: -1')) {
    fs.writeFileSync(path.join(output, 'instrument-failure.txt'), text);
    throw Error('Android assertion failed; see scratch instrument-failure.txt');
  }
  return JSON.parse(match[1]);
};
const scan = label => {
  const rows = [];
  for (const suffix of ['', '-wal', '-journal', '-shm']) {
    const file = 'RKStorage' + suffix;
    const exists = adbRun([
      'shell',
      'run-as',
      'com.bitpay.wallet',
      'test',
      '-e',
      'databases/' + file,
    ]);
    if (exists.status !== 0) continue;
    const read = adbRun([
      'exec-out',
      'run-as',
      'com.bitpay.wallet',
      'cat',
      'databases/' + file,
    ]);
    check(read.status === 0, 'raw-file-unreadable');
    const data = read.stdout;
    fs.writeFileSync(path.join(output, label + '-' + file), data, {
      mode: 0o600,
    });
    const text = data.toString('latin1').replace(/\\+\//g, '/');
    const candidates = text.match(/U2FsdGVkX1[A-Za-z0-9+/=]+/g) || [];
    let decryptable = 0;
    for (const candidate of candidates) {
      try {
        if (
          C.AES.decrypt(candidate, 'synthetic-legacy-fixture-key').toString(
            C.enc.Utf8,
          ).length
        )
          decryptable++;
      } catch {}
    }
    const eddsa =
      fixture.cases.plain.state.WALLET.keys.fixture.properties.xPrivKeyEDDSA;
    const opaque = JSON.parse(
      fixture.cases.constructorPassword.state.WALLET.keys.fixture.properties
        .xPrivKeyEDDSAEncrypted,
    ).ct;
    // Full candidates plus known ciphertext windows detect retained SQLite fragments.
    const known = new Set();
    for (const f of Object.values(fixture.cases)) {
      for (const ct of f.raw.match(/U2FsdGVkX1[A-Za-z0-9+/=]+/g) || []) {
        for (let i = 16; i + 64 <= ct.length; i += 32)
          known.add(ct.slice(i, i + 64));
      }
    }
    rows.push({
      fileClass: suffix || 'main',
      bytes: data.length,
      decryptableCandidates: decryptable,
      knownCiphertextFragments: [...known].filter(part => text.includes(part))
        .length,
      bareEddsa: text.split(eddsa).length - 1,
      opaqueEddsa: text.split(opaque).length - 1,
    });
  }
  return rows;
};
const clean = files =>
  files.every(
    f =>
      !f.decryptableCandidates &&
      !f.knownCiphertextFragments &&
      !f.bareEddsa &&
      !f.opaqueEddsa,
  );
const results = {
  serial,
  environment:
    'Android instrumentation / actual app native helper and patched AsyncStorage Java provider',
  osPageSize: Number(adbRun(['shell', 'getconf', 'PAGE_SIZE']).stdout),
  cases: [],
};
const save = () =>
  fs.writeFileSync(
    path.join(output, 'results.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
try {
  const cases =
    selection === 'extra'
      ? []
      : selection === 'all'
      ? ['default', 'delete', 'truncate', 'persist', 'wal']
      : [selection];
  for (const mode of cases) {
    const seed = instrument('seed', {mode});
    const before = scan(mode + '-before');
    check(
      before.some(f => f.decryptableCandidates > 0),
      'red-control-has-no-decryptable-ciphertext',
    );
    check(!clean(before), 'red-control-has-no-residue');
    const maintenance = instrument('clean');
    const after = scan(mode + '-after');
    check(clean(after), 'retained-historical-residue');
    const reopen = instrument('verify');
    const reopened = scan(mode + '-reopened');
    check(clean(reopened), 'reopened-historical-residue');
    results.cases.push({
      mode,
      seed,
      before,
      maintenance,
      after,
      reopen,
      reopened,
    });
    save();
  }
  if (selection === 'all') {
    for (const operation of ['absent', 'orphan', 'corrupt', 'live']) {
      const value = instrument(operation);
      check(
        value.status ===
          {
            absent: 'ABSENT',
            orphan: 'UNSUPPORTED',
            corrupt: 'CORRUPT',
            live: 'LIVE_SOURCE',
          }[operation],
        'wrong-safe-outcome',
      );
      results.cases.push({operation, result: value});
      save();
    }
    for (const phase of [
      'opened',
      'locked',
      'before-vacuum',
      'vacuumed',
      'verified',
      'closed',
      'reopened',
    ]) {
      instrument('seed');
      instrument('kill', {phase}, true);
      const recovery = instrument('verify');
      const retry = instrument('clean');
      const after = scan('kill-' + phase);
      check(clean(after), 'retry-residue');
      results.cases.push({operation: 'kill', phase, recovery, retry, after});
      save();
    }
    for (const phase of [
      'opened',
      'locked',
      'before-vacuum',
      'vacuumed',
      'verified',
      'closed',
      'reopened',
    ]) {
      const failure = instrument('fault', {phase});
      const recovery = instrument('verify');
      const retry = instrument('clean');
      check(clean(scan('fault-' + phase)), 'fault-retry-residue');
      results.cases.push({
        operation: 'injected-exception',
        phase,
        failure,
        recovery,
        retry,
      });
      save();
    }
    instrument('seed', {page: '16384', mode: 'persist'});
    const before = scan('page16-before');
    check(!clean(before), 'page16-red-control');
    const maintenance = instrument('clean');
    const after = scan('page16-after');
    check(clean(after), 'page16-residue');
    results.cases.push({
      operation: 'sqlite-page-16384',
      before,
      maintenance,
      after,
    });
    save();
  }
  if (selection === 'all' || selection === 'extra') {
    for (const mode of ['default', 'wal', 'persist', 'truncate', 'delete']) {
      const result = instrument('normal', {mode});
      const after = scan('same-process-' + mode);
      check(clean(after), 'same-process-residue');
      results.cases.push({operation: 'same-process', mode, result, after});
      save();
    }
    for (const operation of [
      'large',
      'empty',
      'concurrent',
      'late-live',
      'queue-timeout',
      'denied',
      'busy-checkpoint',
      'unsupported-lock',
      'unsupported-mode',
      'full',
    ]) {
      const result = instrument(operation);
      const retry = ['denied', 'busy-checkpoint', 'full'].includes(operation)
        ? instrument('clean')
        : undefined;
      results.cases.push({operation, result, retry});
      save();
    }
    instrument('hot', {}, true);
    const recoveredLive = instrument('clean-live');
    check(recoveredLive.status === 'LIVE_SOURCE', 'hot-journal-root-erased');
    results.cases.push({
      operation: 'hot-journal-recovery',
      result: recoveredLive,
    });
    save();
    instrument('seed', {fixture: 'constructorPassword', mode: 'persist'});
    const before = scan('opaque-before');
    check(
      before.some(f => f.opaqueEddsa > 0),
      'opaque-red-control-missing',
    );
    const result = instrument('clean');
    const after = scan('opaque-after');
    check(clean(after), 'opaque-residue');
    results.cases.push({operation: 'opaque-eddsa', before, result, after});
    save();
    for (const delay of ['1', '3', '10']) {
      instrument('seed', {large: 'true'});
      const killed = instrument(
        'kill',
        {phase: 'timed-vacuum', delay, large: 'true'},
        true,
      );
      const recovery = instrument('verify', {large: 'true'});
      const retry = instrument('clean', {large: 'true'});
      check(clean(scan('timed-' + delay)), 'timed-kill-retry-residue');
      results.cases.push({
        operation: 'timed-vacuum-kill',
        delay,
        killed,
        recovery,
        retry,
      });
      save();
    }
  }
  console.log(JSON.stringify({cases: results.cases.length, passed: true}));
} catch (error) {
  results.failure = error.message;
  save();
  throw error;
}
