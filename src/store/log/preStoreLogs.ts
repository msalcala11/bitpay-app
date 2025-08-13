import type {AddLog} from '../log/log.types';

// Log array used for storing logs before the store is initialized
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
