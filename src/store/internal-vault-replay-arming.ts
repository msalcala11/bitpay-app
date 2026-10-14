// INTERNAL ONLY - DO NOT MERGE. Arming never deletes wallet or backup data.
import type {createInternalVaultReplay} from './internal-vault-replay';
import type {ReplayPause} from './internal-vault-replay-writes';

export type ReplayNotice =
  | {kind: 'draining' | 'restarting'}
  | {kind: 'refused' | 'cancelled' | 'unsafe'; message: string};
type ArmingIO = {
  replay: ReturnType<typeof createInternalVaultReplay>;
  confirm(): Promise<boolean>;
  suspend(): ReplayPause;
  restart(): void;
};

export const createReplayArmer = (io: ArmingIO) => {
  let busy = false;
  let abort = false;
  let restartRequested = false;
  return {
    cancel() {
      if (busy && !restartRequested) abort = true;
    },
    async arm(notify: (notice: ReplayNotice) => void) {
      if (busy) {
        notify({
          kind: 'refused',
          message: 'An internal replay attempt is already in progress.',
        });
        return;
      }
      busy = true;
      abort = false;
      let pause: ReplayPause | undefined;
      try {
        if (io.replay.state.read() !== null) {
          notify({
            kind: 'refused',
            message:
              'A replay request is already pending. Close and relaunch the app.',
          });
          busy = false;
          return;
        }
        const result = await io.replay.eligibility();
        if (result.kind !== 'passes') {
          notify({
            kind: 'refused',
            message: `${
              result.kind === 'unknown'
                ? 'Could not determine eligibility'
                : 'Replay is not eligible'
            }: ${result.condition}.`,
          });
          busy = false;
          return;
        }
        if (abort) {
          busy = false;
          return;
        }
        const confirmed = await io.confirm();
        if (!confirmed || abort) {
          busy = false;
          return;
        }
        pause = io.suspend();
        notify({kind: 'draining'});
        await pause.drained;
        if (abort) throw new Error('Arming was aborted');
        io.replay.state.write('armed');
        notify({kind: 'restarting'});
        restartRequested = true;
        io.restart();
        // Returning from restart is not an acknowledgement. Keep both gates shut.
      } catch {
        if (!pause) {
          busy = false;
          notify({
            kind: 'refused',
            message:
              'Could not determine replay state or eligibility. Nothing was cleared.',
          });
          return;
        }
        try {
          io.replay.state.clear();
        } catch {
          notify({
            kind: 'unsafe',
            message:
              'Replay cancellation could not be verified and may still be armed. Persistence remains suspended. Close and relaunch the app; do not continue using it.',
          });
          return;
        }
        try {
          pause.release();
        } catch {
          notify({
            kind: 'unsafe',
            message:
              'The replay request was cleared, but persistence could not be safely restored. Close and relaunch the app.',
          });
          return;
        }
        restartRequested = false;
        busy = false;
        notify({
          kind: 'cancelled',
          message:
            'Replay was cancelled after verifying that the request was cleared. Only the replay pause was released.',
        });
      }
    },
  };
};
