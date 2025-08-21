// @ts-ignore
import {LOG_PUBLIC_KEY as ENV_LOG_PUBLIC_KEY, LOG_UPLOAD_URL as ENV_LOG_UPLOAD_URL, LOG_INGEST_TOKEN as ENV_LOG_INGEST_TOKEN} from '@env';

// Expose logging-related config values from environment
// Ensure these are set in your .env or CI environment
export const LOG_PUBLIC_KEY = ENV_LOG_PUBLIC_KEY || '';
export const LOG_UPLOAD_URL = ENV_LOG_UPLOAD_URL || '';
export const LOG_INGEST_TOKEN = ENV_LOG_INGEST_TOKEN || '';

export function assertLogConfig() {
  if (!LOG_PUBLIC_KEY) {
    // Do not throw in production; just skip remote logging if unset
    return false;
  }
  if (!LOG_UPLOAD_URL) {
    return false;
  }
  return true;
}
