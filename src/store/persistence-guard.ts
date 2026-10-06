import {AnyAction, Middleware} from 'redux';
import {PAUSE, REHYDRATE} from 'redux-persist';
import {safeVaultError} from './vault-diagnostics';

export const createRehydrationFailureMiddleware =
  (onFailure: (error: Error) => void): Middleware =>
  store =>
  next =>
  (action: AnyAction) => {
    if (
      action.type === REHYDRATE &&
      action.key === 'root' &&
      action.err != null
    ) {
      const error = safeVaultError(
        action.err,
        'PRESERVATION_FAILURE',
        'persist',
        'REHYDRATION',
        'mmkv',
      );
      store.dispatch({type: PAUSE});
      onFailure(error);
    }
    return next(action);
  };
