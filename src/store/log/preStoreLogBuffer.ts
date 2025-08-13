import type {AddLog} from './log.types';

let buffer: AddLog[] = [];

export function enqueue(log: AddLog) {
  buffer.push(log);
}

export function peek(): ReadonlyArray<AddLog> {
  return buffer;
}

export function clear() {
  buffer = [];
}

export function drainAndDispatch(dispatch: (action: any) => void) {
  if (buffer.length === 0) {
    return;
  }
  buffer.forEach(a => dispatch(a as any));
  buffer = [];
}

// For tests only
export function resetForTesting() {
  buffer = [];
}
