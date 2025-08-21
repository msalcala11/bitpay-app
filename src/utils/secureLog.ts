import {Platform} from 'react-native';
import sodium from 'react-native-libsodium';
import {LOG_PUBLIC_KEY, LOG_UPLOAD_URL, LOG_INGEST_TOKEN, assertLogConfig} from './config';

let inited = false;
let recipientPk: Uint8Array | null = null;

async function init() {
  if (inited) {
    return;
  }
  await sodium.ready;
  try {
    if (!LOG_PUBLIC_KEY || !LOG_UPLOAD_URL) {
      inited = true;
      return;
    }
    // Expect base64 without padding by default; accept with padding as well
    try {
      recipientPk = sodium.from_base64(
        LOG_PUBLIC_KEY,
        sodium.base64_variants.ORIGINAL_NO_PADDING,
      );
    } catch (_e) {
      recipientPk = sodium.from_base64(LOG_PUBLIC_KEY, sodium.base64_variants.ORIGINAL);
    }
  } finally {
    inited = true;
  }
}

export async function encryptAndUploadLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  extra?: Record<string, any>,
) {
  try {
    if (!assertLogConfig()) {
      return; // remote logging disabled if no config
    }
    await init();
    if (!recipientPk) {
      return;
    }
    const payload = {
      ts: Date.now(),
      level,
      message,
      platform: Platform.OS,
      ...extra,
    };
    const json = JSON.stringify(payload);
    const msg = new TextEncoder().encode(json);
    const ct = sodium.crypto_box_seal(msg, recipientPk);
    const ctB64 = sodium.to_base64(ct, sodium.base64_variants.ORIGINAL_NO_PADDING);
    // fire-and-forget
    fetch(LOG_UPLOAD_URL + '/api/logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(LOG_INGEST_TOKEN ? {'X-Log-Token': LOG_INGEST_TOKEN} : {}),
      },
      body: JSON.stringify({
        ct: ctB64,
        ts: payload.ts,
        level: payload.level,
        platform: payload.platform,
      }),
    }).catch((e) => console.error('Failed fetch to encrypt and upload log to', LOG_UPLOAD_URL, e));
  } catch (_e) {
    // Never throw from logging
  }
}
