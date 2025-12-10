import {EntityRef, Timeframe} from './portfolio.types';

export const buildEntityScope = (entity: EntityRef): string => {
  switch (entity.type) {
    case 'wallet':
      if (!entity.id) {
        throw new Error('Wallet entity requires id');
      }
      return `wallet:${entity.id}`;
    case 'key':
      if (!entity.id) {
        throw new Error('Key entity requires id');
      }
      return `key:${entity.id}`;
    case 'account':
      if (!entity.accountAddress || !entity.accountKeyId) {
        throw new Error('Account entity requires accountAddress and accountKeyId');
      }
      return `account:${entity.accountKeyId}:${entity.accountAddress}`;
    case 'portfolio':
      return 'portfolio';
    default:
      throw new Error(`Unsupported entity type ${(entity as any)?.type}`);
  }
};

export const buildSeriesKey = (
  entity: EntityRef,
  timeframe: Timeframe,
  quoteCurrency: string,
) => `${buildEntityScope(entity)}::${timeframe}::${quoteCurrency.toUpperCase()}`;
