// INTERNAL ONLY - DO NOT MERGE. The session-log easter egg is NOT a release gate.
import React, {useEffect, useRef, useState} from 'react';
import {Alert, Modal, StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import RNRestart from 'react-native-restart';
import {
  Setting,
  SettingTitle,
  Hr,
} from '../../../../components/styled/Containers';
import Button from '../../../../components/button/Button';
import {
  createReplayArmer,
  ReplayNotice,
} from '../../../../store/internal-vault-replay-arming';

export const INTERNAL_REPLAY_WARNING =
  'Discards the current modern wallet data and attempts migration again from the legacy data currently retained on this device. Migration selects the source again. It may restore a different snapshot, fail to start, or find no wallet. Keys and wallets present only in modern storage will be lost. Unfunded test wallets only.';

let armer: ReturnType<typeof createReplayArmer> | undefined;
const getArmer = () => {
  if (armer) return armer;
  // Rendering About must not load the store/runtime or inspect replay storage.
  const {
    createInternalVaultReplay,
  }: typeof import('../../../../store/internal-vault-replay') = require('../../../../store/internal-vault-replay');
  const {
    getInternalVaultReplayAccess,
  }: typeof import('../../../../store/vault-runtime') = require('../../../../store/vault-runtime');
  const {
    suspendPersistenceForInternalVaultReplay,
  }: typeof import('../../../../store') = require('../../../../store');
  armer = createReplayArmer({
    replay: createInternalVaultReplay(() => getInternalVaultReplayAccess()),
    confirm: () =>
      new Promise(resolve =>
        Alert.alert(
          'Replay vault migration (internal)',
          INTERNAL_REPLAY_WARNING,
          [
            {text: 'Cancel', style: 'cancel', onPress: () => resolve(false)},
            {
              text: 'Discard modern wallet and restart',
              style: 'destructive',
              onPress: () => resolve(true),
            },
          ],
          {cancelable: true, onDismiss: () => resolve(false)},
        ),
      ),
    suspend: () => suspendPersistenceForInternalVaultReplay(),
    restart: () => RNRestart.restart(),
  });
  return armer;
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    padding: 32,
  },
  title: {fontSize: 22, fontWeight: '700', color: '#000000', marginBottom: 20},
  text: {fontSize: 17, color: '#000000', marginBottom: 24},
});

const InternalVaultReplay = () => {
  const navigation = useNavigation();
  const guard = useRef({pending: false, blocked: false});
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState<ReplayNotice | null>(null);
  useEffect(
    () =>
      navigation.addListener?.('beforeRemove', event => {
        if (guard.current.pending || guard.current.blocked)
          event.preventDefault();
      }),
    [navigation],
  );
  useEffect(
    () => () => {
      if (guard.current.pending) armer?.cancel();
    },
    [],
  );
  const notice = (value: ReplayNotice) => {
    if (value.kind === 'refused') {
      Alert.alert('Internal replay refused', value.message);
    } else if (value.kind === 'cancelled') {
      guard.current.blocked = false;
      setBlocked(null);
      Alert.alert('Internal replay cancelled', value.message);
    } else {
      guard.current.blocked = true;
      setBlocked(value);
    }
  };
  const request = async () => {
    if (guard.current.pending || guard.current.blocked) return;
    guard.current.pending = true;
    setPending(true);
    try {
      await getArmer().arm(notice);
    } finally {
      // This only resets the row's click guard, never the writer pauses/blocker.
      guard.current.pending = false;
      setPending(false);
    }
  };
  return (
    <>
      <Setting disabled={pending || !!blocked} onPress={request}>
        <SettingTitle>Replay vault migration (internal)</SettingTitle>
      </Setting>
      <Hr />
      <Modal visible={!!blocked} animationType="none" onRequestClose={() => {}}>
        <View style={styles.screen}>
          <Text style={styles.title}>Internal vault replay</Text>
          <Text style={styles.text}>
            {blocked?.kind === 'draining'
              ? 'Persistence is suspended. Waiting for pending wallet and backup operations to finish.'
              : blocked?.kind === 'unsafe'
              ? blocked.message
              : 'Restart requested. Persistence remains suspended. If the app does not reload, close and relaunch it. Do not continue using this session.'}
          </Text>
          {blocked?.kind === 'draining' ? (
            <Button onPress={() => getArmer().cancel()}>Cancel replay</Button>
          ) : null}
        </View>
      </Modal>
    </>
  );
};
export default InternalVaultReplay;
