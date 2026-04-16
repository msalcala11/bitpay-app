export type BwsConfig = {
  /** e.g. "/bws/api" (proxied) or "https://bws.bitpay.com/bws/api" */
  baseUrl: string;
  timeoutMs?: number;
};

export const DEFAULT_BWS_CONFIG: BwsConfig = {
  baseUrl: '/bws/api',
  timeoutMs: 100000,
};
