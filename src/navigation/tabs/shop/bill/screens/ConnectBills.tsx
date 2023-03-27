import React, {useState} from 'react';
import {StackScreenProps} from '@react-navigation/stack';
import {BillStackParamList} from '../BillStack';
import WebView from 'react-native-webview';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

const ConnectBills = ({
  navigation,
}: //   route,
//   navigation,
StackScreenProps<BillStackParamList, 'ConnectBills'>) => {
  const insets = useSafeAreaInsets();
  const props = {
    token: 'pk_elem_7P9NFNcmTpAfXV6RtWn8N8WRCeK3Fz37',
    onExit: () => {
      navigation.pop();
    },
  } as any;
  const [isWebViewShown, setIsWebViewShown] = useState(true);
  const noop = () => {};
  const {
    token,
    env = 'dev',
    onOpen = noop,
    onError = noop,
    onExit = noop,
    onSuccess = noop,
    onEvent = noop,
  } = props;

  const handleNavigationStateChange = (event: any) => {
    if (event.url.startsWith('methodelements://')) {
      const searchParams = new URLSearchParams(`?${event.url.split('?')[1]}`);
      const params = Object.fromEntries(searchParams);
      const op = searchParams.get('op');
      let response = {...params};

      if (params.accounts) {
        response.accounts = JSON.parse(params.accounts);
      }

      switch (op) {
        case 'open':
          onOpen(response);
          break;
        case 'error':
          onError(response);
          break;
        case 'exit':
          onExit(response);
          break;
        case 'success':
          onSuccess(response);
          break;
        default:
      }

      if (onEvent) {
        onEvent(event);
      }

      return false;
    }

    return true;
  };
  return (
    <>
      {isWebViewShown ? (
        <WebView
          style={{marginTop: insets.top}}
          source={{uri: `https://elements.${env}.methodfi.com/?token=${token}`}}
          originWhitelist={['https://*', 'methodelements://*']}
          onShouldStartLoadWithRequest={handleNavigationStateChange}
          onError={_ => {
            setIsWebViewShown(false);
            setTimeout(() => {
              setIsWebViewShown(true);
            }, 1000);
          }}
        />
      ) : null}
    </>
  );
};

export default ConnectBills;
