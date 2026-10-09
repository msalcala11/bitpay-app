// Alternate Metro entry for a dedicated test build. Uses only synthetic files
// in its own cache directory; never imports the application store or wallet.
import React, {useEffect, useState} from 'react';
import {AppRegistry, Text, TurboModuleRegistry} from 'react-native';
import RNFS from 'react-native-fs';
import {MMKV} from 'react-native-mmkv';
import {name as appName} from '../../app.json';

const path = RNFS.CachesDirectoryPath + '/bip02-native-lifecycle-proof';
const marker = path + '/phase';
const data = path + '/mmkv.default';
const crc = data + '.crc';
const check = condition => {
  if (!condition) throw new Error('Native lifecycle assertion failed');
};
const phase = async name => RNFS.writeFile(marker, name, 'utf8');
const openLegacy = () => new MMKV({id: 'mmkv.default', path});

async function run() {
  await RNFS.mkdir(path);
  const stage = (await RNFS.exists(marker))
    ? await RNFS.readFile(marker, 'utf8')
    : 'new';
  const modern = new MMKV({id: 'bitpay.wallet.v2', path});
  const claim = () =>
    TurboModuleRegistry.getEnforcing('MmkvCxx').claimLegacyRetirement();
  if (stage === 'new') {
    const old = openLegacy();
    old.set('synthetic', 'unfunded fixture');
    modern.set('synthetic', 'modern fixture');
    await RNFS.writeFile(path + '/unrelated', 'preserve', 'utf8');
    check(!claim());
    await phase('warm');
    return 'Warm refusal passed. Reload JavaScript without terminating the app.';
  }
  if (stage === 'warm') {
    check(!claim());
    check(await RNFS.exists(data));
    check(await RNFS.exists(crc));
    await phase('cold');
    return 'JS reload refusal passed. Terminate the native process and relaunch.';
  }
  check(claim());
  check(modern.getString('synthetic') === 'modern fixture');
  if (stage === 'cold') {
    check(await RNFS.exists(data));
    check(await RNFS.exists(crc));
    await RNFS.unlink(data);
    await phase('partial');
    return 'First unlink passed. Terminate the native process and relaunch.';
  }
  if (stage === 'partial') {
    check(!(await RNFS.exists(data)));
    check(await RNFS.exists(crc));
    await RNFS.unlink(crc);
  }
  let rejected = false;
  try {
    openLegacy();
  } catch {
    rejected = true;
  }
  check(rejected);
  check(!(await RNFS.exists(data)) && !(await RNFS.exists(crc)));
  check((await RNFS.readFile(path + '/unrelated', 'utf8')) === 'preserve');
  await phase('passed');
  return 'Cold reopen, partial removal, sealed old opens and unrelated-file preservation passed.';
}

const execution = run();
function Probe() {
  const [result, setResult] = useState('Running native lifecycle probe…');
  useEffect(() => {
    execution.then(setResult, () =>
      setResult('FAILED: native lifecycle assertion'),
    );
  }, []);
  return <Text accessibilityLabel="native-lifecycle-result">{result}</Text>;
}
AppRegistry.registerComponent(appName, () => Probe);
