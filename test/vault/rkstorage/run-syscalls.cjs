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
const cases = [];
const instrument = (operation, label) => {
  const r = cp.spawnSync(
    adb,
    [
      '-s',
      serial,
      'shell',
      'am',
      'instrument',
      '-w',
      '-r',
      '-e',
      'operation',
      operation,
      'com.bitpay.wallet.test/com.bitpay.wallet.rkstorage.RKStorageTestRunner',
    ],
    {encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024},
  );
  fs.writeFileSync(path.join(output, label + '.log'), r.stdout || '');
  const match = (r.stdout || '').match(
    /INSTRUMENTATION_RESULT: results=(\{.*\})/,
  );
  if (
    r.status !== 0 ||
    !match ||
    !r.stdout.includes('INSTRUMENTATION_CODE: -1')
  )
    throw Error('Native fault assertion failed; see scratch log');
  return JSON.parse(match[1]);
};
for (const operation of ['sync', 'write', 'truncate', 'checkpoint']) {
  const failed = instrument('syscall-' + operation, operation);
  if (
    failed.status === 'CLEANED' ||
    !['main', 'wal', 'journal'].includes(failed.injectedFileClass)
  )
    throw Error('Fault did not reach RKStorage');
  const recovery = instrument('verify', operation + '-recovery');
  const retry = instrument('clean', operation + '-retry');
  if (retry.status !== 'CLEANED') throw Error('Retry failed');
  cases.push({operation, failed, recovery, retry});
  fs.writeFileSync(
    path.join(output, 'results.json'),
    JSON.stringify({serial, cases}, null, 2) + '\n',
  );
}
console.log(JSON.stringify({cases: cases.length, passed: true}));
