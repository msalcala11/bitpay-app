import type {HybridObject} from 'react-native-nitro-modules';

export interface BwsSigner extends HybridObject<{ios: 'c++'; android: 'c++'}> {
  deriveRequestPubKey(requestPrivKeyHex: string): string;
  signBwsGetRequest(
    requestPath: string,
    requestPrivKeyHex: string,
  ): string;
}
