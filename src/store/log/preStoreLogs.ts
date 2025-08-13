import type {AddLog} from '../log/log.types';

// Simple shared pre-store log buffer
const buffer: AddLog[] = [];

export const enqueue = (log: AddLog) => {
  buffer.push(log);
};

export const drainAndDispatch = (dispatch: (action: AddLog) => void) => {
  if (buffer.length === 0) {
    return;
  }
  buffer.forEach(a => dispatch(a));
  buffer.length = 0;
};
