// Disposable Android rendered-Alert entry. Never imported by index.js.
// The real controller, native Alert and AppState run unchanged. Only the URL
// boundary is modeled in no-events/reject/delayed modes; native launches it.
import React, {useEffect, useState} from 'react';
import {AppRegistry, AppState, Linking, Text, View} from 'react-native';
import RNFS from 'react-native-fs';
import BootSplash from 'react-native-bootsplash';
import i18n from 'i18next';
import translation from '../../../locales/en/translation.json';
import {vaultStartupAlert} from '../../../src/store/vault-startup-alert';

const base = RNFS.DocumentDirectoryPath;
const result = {launches: 0, retries: 0, changes: 0, blur: 0, focus: 0};
let output = Promise.resolve();
const record = () => {
  const raw = JSON.stringify(result);
  output = output.then(() =>
    RNFS.writeFile(base + '/alert-result.json', raw, 'utf8'),
  );
};
const App = () => {
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    let disposed = false;
    let dispose = () => {};
    const subscriptions = ['change', 'blur', 'focus'].map(event =>
      AppState.addEventListener(event, () => {
        result[event === 'change' ? 'changes' : event]++;
        record();
      }),
    );
    const open = Linking.openURL;
    (async () => {
      const mode = (
        await RNFS.readFile(base + '/alert-mode.txt', 'utf8')
      ).trim();
      if (!['native', 'no-events', 'reject', 'delayed'].includes(mode))
        throw Error('Unknown test mode');
      await i18n.init({
        lng: 'en',
        resources: {en: {translation}},
        interpolation: {escapeValue: false},
      });
      if (disposed) return;
      await BootSplash.hide({fade: false}); // Test screen only; production startup is unchanged.
      if (disposed) return;
      Linking.openURL = async url => {
        result.launches++;
        record();
        if (mode === 'reject') throw Error('synthetic URL failure');
        if (mode === 'native') return open.call(Linking, url);
        if (mode === 'delayed') setTimeout(() => open.call(Linking, url), 2500);
        return undefined;
      };
      dispose = vaultStartupAlert(
        new Error('synthetic startup failure'),
        () => {
          result.retries++;
          record();
          setRetried(true);
        },
      );
    })();
    return () => {
      disposed = true;
      dispose();
      Linking.openURL = open;
      subscriptions.forEach(subscription => subscription.remove());
    };
  }, []);
  return (
    <View>
      <Text>
        {retried ? 'Synthetic Retry completed' : 'Synthetic startup failure'}
      </Text>
    </View>
  );
};
AppRegistry.registerComponent('BitPay', () => App);
