import type {AddLog} from './log.types';

const preStoreLogs: AddLog[] = [];

export function enqueue(log: AddLog) {
  preStoreLogs.push(log);
}

export function drainAndDispatch(dispatch: (action: any) => void) {
  if (preStoreLogs.length === 0) {
    return;
  }
  preStoreLogs.forEach(a => dispatch(a as any));
  preStoreLogs.length = 0;
}
