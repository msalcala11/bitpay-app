import {Network} from '../../constants';
import type {Effect} from '..';
import {initializedUnsoldGiftCard, redeemedGiftCard} from './shop.actions';
import type {CardConfig, GiftCard} from './shop.models';

// Temporary catalog artwork helper. These are local regtest fixtures, never
// orders or redemption requests. A stable ID keeps one preview per brand/currency.
export const seedDevGiftCardPreview =
  (cardConfig: CardConfig): Effect =>
  (dispatch, getState) => {
    if (!__DEV__) {
      return;
    }
    const {APP, SHOP} = getState();
    if (APP.network !== Network.regtest) {
      return;
    }
    const invoiceId = `dev-gift-card-preview:${cardConfig.currency}:${cardConfig.name}`;
    const exists = SHOP.giftCards[APP.network].some(
      card => card.invoiceId === invoiceId,
    );
    const giftCard: GiftCard = {
      invoiceId,
      name: cardConfig.name,
      displayName: cardConfig.displayName,
      currency: cardConfig.currency,
      amount:
        cardConfig.supportedAmounts?.[0] ??
        Math.min(
          cardConfig.maxAmount ?? 25,
          Math.max(cardConfig.minAmount ?? 0, 25),
        ),
      date: Date.now(),
      status: 'SUCCESS',
      archived: false,
      claimCode: 'DEV-SAMPLE-NOT-REDEEMABLE',
      claimLink: 'https://example.invalid/dev-gift-card-preview',
      clientId: 'dev-gift-card-preview',
      accessKey: 'dev-gift-card-preview',
    };
    dispatch(
      exists
        ? redeemedGiftCard({giftCard, network: APP.network})
        : initializedUnsoldGiftCard({giftCard, network: APP.network}),
    );
  };
