import {Middleware} from 'redux';
import {encryptAndUploadLog} from '../../utils/secureLog';
import {LogActionTypes} from './log.types';
import {LogLevel, LogEntry} from './log.models';

// Intercept all log actions and forward them to the remote log server
export const logUploadMiddleware: Middleware = _store => next => action => {
  const result = next(action);

  try {
    if (
      action &&
      (action.type === LogActionTypes.ADD_LOG ||
        action.type === LogActionTypes.ADD_PERSISTED_LOG)
    ) {
      const payload: LogEntry | undefined = action.payload;
      if (payload && typeof payload.message === 'string') {
        const enumName = LogLevel[payload.level] as
          | 'Debug'
          | 'Info'
          | 'Warn'
          | 'Error'
          | undefined;
        const level = (enumName ? enumName.toLowerCase() : 'info') as
          | 'debug'
          | 'info'
          | 'warn'
          | 'error';
        void encryptAndUploadLog(level, payload.message, {
          ts: new Date(payload.timestamp).getTime(),
        });
      }
    }
  } catch (_e) {
    // Never throw from middleware; logging must not break app
  }

  return result;
};
