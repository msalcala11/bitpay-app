import {populateLoopRunning} from '../sharedState';

export function kickPopulateLoopIfIdle(): boolean {
  if (populateLoopRunning.value) {
    return false;
  }
  populateLoopRunning.value = true;
  return true;
}

export function stopPopulateLoopForTesting(): void {
  populateLoopRunning.value = false;
}
