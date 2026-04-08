import {NitroModules, type BoxedHybridObject} from 'react-native-nitro-modules';
import type {BwsSigner} from './specs/bwsSigner.nitro';

export type BoxedBwsSigner = BoxedHybridObject<BwsSigner>;

const BWS_SIGNER_HYBRID_OBJECT_NAME = 'BwsSigner';

export const hasBwsSignerHybridObject = () => {
  try {
    return NitroModules.hasHybridObject(BWS_SIGNER_HYBRID_OBJECT_NAME);
  } catch {
    return false;
  }
};

export const getOptionalBoxedBwsSigner = (): BoxedBwsSigner | null => {
  if (!hasBwsSignerHybridObject()) {
    return null;
  }

  try {
    const signer =
      NitroModules.createHybridObject<BwsSigner>(BWS_SIGNER_HYBRID_OBJECT_NAME);
    return NitroModules.box(signer);
  } catch {
    return null;
  }
};
