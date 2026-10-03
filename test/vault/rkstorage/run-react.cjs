const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const [serial, output] = process.argv.slice(2);
if (!/^emulator-\d+$/.test(serial || '') || !output)
  throw Error('Pass disposable emulator and scratch output');
const adb =
  process.env.ADB ||
  path.join(process.env.HOME, 'Library/Android/sdk/platform-tools/adb');
fs.mkdirSync(output, {recursive: true});
const run = args => {
  const result = cp.spawnSync(adb, ['-s', serial, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) throw Error('ADB test operation failed');
  return result.stdout;
};
const cases = [];
for (const seed of [
  'react-seed',
  'react-base-only',
  'react-async-only',
  'react-empty-import',
  'react-fresh-start',
  'react-eddsa-seed',
]) {
  run(['shell', 'pm', 'clear', 'com.bitpay.wallet']); // disposable app only
  const rows = [];
  const operations =
    seed === 'react-fresh-start'
      ? [
          seed,
          'react-fresh-retry',
          'react-fresh-retry',
          'react-fresh-save',
          'react-clean',
          'react-clean',
        ]
      : seed === 'react-eddsa-seed'
      ? [seed, 'react-eddsa-upgrade', 'react-eddsa-retry', 'react-eddsa-verify']
      : [seed, 'react-clean', 'react-clean'];
  for (const operation of operations) {
    const text = run([
      'shell',
      'am',
      'instrument',
      '-w',
      '-r',
      '-e',
      'operation',
      operation,
      'com.bitpay.wallet.test/com.bitpay.wallet.rkstorage.RKStorageTestRunner',
    ]);
    fs.writeFileSync(
      path.join(output, seed + '-' + rows.length + '.log'),
      text,
    );
    const match = text.match(/INSTRUMENTATION_RESULT: results=(\{.*\})/);
    if (!match || !text.includes('INSTRUMENTATION_CODE: -1'))
      throw Error('Real-runtime assertion failed; see scratch log');
    rows.push(JSON.parse(match[1]));
  }
  if (rows[rows.length - 1].nativeCalls !== 0)
    throw Error('Completed launch repeated native maintenance');
  cases.push({seed, rows});
  fs.writeFileSync(
    path.join(output, 'results.json'),
    JSON.stringify({serial, cases}, null, 2) + '\n',
  );
}
console.log(
  JSON.stringify({
    cases: cases.length,
    launches: cases.reduce((total, entry) => total + entry.rows.length, 0),
    passed: true,
  }),
);
