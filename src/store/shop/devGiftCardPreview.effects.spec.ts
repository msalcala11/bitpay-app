import {Network} from '../../constants';
import {seedDevGiftCardPreview} from './devGiftCardPreview.effects';
import {ClaimCodeType, type CardConfig, type GiftCard} from './shop.models';
import {initialShopState, shopReducer} from './shop.reducer';
import type {ShopActionType} from './shop.types';

const config: CardConfig = {
  name: 'Example Brand',
  displayName: 'Example Brand Gift Card',
  currency: 'USD',
  minAmount: 5,
  maxAmount: 100,
  cardImage: 'card.png',
  logo: 'logo.svg',
  icon: 'icon.svg',
  logoBackgroundColor: '#ffffff',
  defaultClaimCodeType: ClaimCodeType.code,
  description: '',
  emailRequired: false,
  terms: '',
  website: '',
};
const originalDev = __DEV__;
beforeEach(() => {
  (global as any).__DEV__ = true;
  jest.spyOn(Date, 'now').mockReturnValue(1000);
});
afterEach(() => {
  (global as any).__DEV__ = originalDev;
  jest.restoreAllMocks();
});

const harness = (network = Network.regtest) => {
  const state = {APP: {network}, SHOP: initialShopState};
  const dispatch = jest.fn((action: ShopActionType) => {
    state.SHOP = shopReducer(state.SHOP, action);
    return action;
  });
  const visit = (cardConfig = config) =>
    (seedDevGiftCardPreview(cardConfig) as any)(dispatch, () => state);
  return {state, dispatch, visit};
};

it('adds a completed local card with the catalog brand identity and currency', () => {
  const h = harness();
  h.visit();
  expect(h.state.SHOP.giftCards.regtest).toEqual([
    expect.objectContaining({
      name: config.name,
      displayName: config.displayName,
      currency: 'USD',
      amount: 25,
      status: 'SUCCESS',
      archived: false,
      claimCode: 'DEV-SAMPLE-NOT-REDEEMABLE',
      date: 1000,
    }),
  ]);
  expect(h.state.SHOP.giftCards.livenet).toEqual([]);
});

it.each([
  [{supportedAmounts: [10, 50, 100]}, 10],
  [{minAmount: 100, maxAmount: 500}, 100],
  [{minAmount: 1, maxAmount: 10}, 10],
])('uses a supported sample amount for %j', (overrides, expected) => {
  const h = harness();
  h.visit({...config, ...overrides});
  expect(h.state.SHOP.giftCards.regtest[0].amount).toBe(expected);
});

it('refreshes one preview per brand, restores it from the archive, and preserves other cards', () => {
  const h = harness();
  h.visit();
  const preview = h.state.SHOP.giftCards.regtest[0] as GiftCard;
  const realCard = {
    ...preview,
    invoiceId: 'existing-order',
    claimCode: 'existing-code',
  };
  h.state.SHOP = {
    ...h.state.SHOP,
    giftCards: {
      ...h.state.SHOP.giftCards,
      regtest: [realCard, {...preview, archived: true}],
    },
  };
  jest.mocked(Date.now).mockReturnValue(2000);
  h.visit();
  expect(h.state.SHOP.giftCards.regtest).toHaveLength(2);
  expect(h.state.SHOP.giftCards.regtest[0]).toBe(realCard);
  expect(h.state.SHOP.giftCards.regtest[1]).toMatchObject({
    archived: false,
    date: 2000,
  });
  h.visit({...config, name: 'Another Brand'});
  expect(h.state.SHOP.giftCards.regtest).toHaveLength(3);
});

it.each([Network.mainnet, Network.testnet])(
  'does not seed cards on %s',
  network => {
    const h = harness(network);
    h.visit();
    expect(h.dispatch).not.toHaveBeenCalled();
  },
);

it('does not seed cards in a release build, even on regtest', () => {
  (global as any).__DEV__ = false;
  const h = harness();
  h.visit();
  expect(h.dispatch).not.toHaveBeenCalled();
});
