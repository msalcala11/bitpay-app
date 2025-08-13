import type {AddLog} from '../log/log.types';

// Simple shared pre-store log buffer
const preStoreLogs: AddLog[] = [];

export const add = (log: AddLog) => {
  preStoreLogs.push(log);
};

export const drainAndDispatch = (dispatch: (action: AddLog) => void) => {
  if (preStoreLogs.length === 0) {
    return;
  }
  preStoreLogs.forEach(action => dispatch(action));
  preStoreLogs.length = 0;
};
