import {PriceAlertsError, priceAlertsError} from '../../api/price-alerts';
import type {PriceAlertsApi} from '../../api/price-alerts';
import type {
  PriceAlert,
  PriceAlertPreferences,
  PriceAlertSelector,
  PriceAlertsResponse,
  PriceAlertThreshold,
} from '../../api/price-alerts/price-alerts.types';
import {alertCurrency, selectorKey, type CoinCatalog} from './coins';
import {
  emptyAlertContext,
  type AlertContextState,
  type WatchlistCoin,
  type WatchlistState,
} from './watchlist.models';

export interface AlertEnvironment {
  // Undefined until persistence and signing identity are ready.
  context?: string;
  externalUserId?: string;
  pushEnabled: boolean | undefined;
  currency: string;
}

export interface AlertQueueDependencies {
  read: () => WatchlistState;
  write: (state: WatchlistState) => void;
  environment: () => AlertEnvironment;
  catalog: () => CoinCatalog;
  api: () => Pick<PriceAlertsApi, 'list' | 'register' | 'save' | 'remove'>;
  now?: () => number;
}

type Ticket = {key: string; generation: number};

// One instance per Redux store. Every network call, including nested recovery
// work, runs inside a context's serial tail. State is reread at each await.
export class PriceAlertQueue {
  private tails = new Map<string, Promise<unknown>>();
  private probes = new Set<string>();
  private initialized = new Set<string>();
  private syncing = new Map<string, Promise<void>>();
  private generation = 0;
  private active?: string;
  private desiredEnabled = new Map<string, boolean>();
  private pendingUserOrders = new Set<number>();
  private targets = new Map<number, {key: string; coin: WatchlistCoin}>();
  private catalogSnapshot?: CoinCatalog;
  private permissionWaiters = new Set<{ticket: Ticket; resolve: () => void}>();

  constructor(private readonly deps: AlertQueueDependencies) {}

  permissionChanged() {
    for (const waiter of this.permissionWaiters) {
      if (
        !this.current(waiter.ticket) ||
        this.context(waiter.ticket).disabled ||
        this.deps.environment().pushEnabled !== undefined
      ) {
        this.permissionWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  private enqueueAfterPermission<T>(
    ticket: Ticket,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    if (
      this.deps.environment().pushEnabled !== undefined ||
      !this.current(ticket) ||
      this.context(ticket).disabled
    ) {
      return this.enqueue(ticket, task);
    }
    // Never hold the serial tail while waiting: launch list/recovery work must
    // still run. The caller has already recorded its original user order.
    return new Promise<void>(resolve =>
      this.permissionWaiters.add({ticket, resolve}),
    ).then(() => this.enqueue(ticket, task));
  }

  private matchStored(coin: WatchlistCoin) {
    const catalog = this.deps.catalog();
    return (
      catalog.fromSelector(coin.selector) ||
      catalog.byId.get(coin.id) ||
      coin.assets.map(asset => catalog.match(asset)).find(Boolean)
    );
  }

  // Re-key local state without treating registry metadata as a server response.
  // Request targets are mutable references so their original order/ticket stays
  // attached to the same row across awaits, even when its old ID still exists.
  private refreshCatalog() {
    const state = this.deps.read();
    const catalog = this.deps.catalog();
    const rows = new Map<string, WatchlistCoin>();
    const items: WatchlistCoin[] = [];
    for (const item of state.items) {
      const matched = this.matchStored(item);
      const latest = matched ? {...matched, selector: item.selector} : item;
      rows.set(item.id, latest);
      if (!items.some(existing => existing.id === latest.id))
        items.push(latest);
    }
    const idFor = (id: string, selector?: PriceAlertSelector) => {
      const previous = this.catalogSnapshot?.byId.get(id);
      return (
        rows.get(id)?.id ||
        (selector && catalog.fromSelector(selector)?.id) ||
        (previous && this.matchStored(previous)?.id) ||
        id
      );
    };
    const targetIds = new Map<string, Map<string, string>>();
    for (const target of this.targets.values()) {
      const oldId = target.coin.id;
      const matched = rows.get(oldId) || this.matchStored(target.coin);
      if (matched) target.coin = {...matched, selector: target.coin.selector};
      const ids = targetIds.get(target.key) || new Map<string, string>();
      ids.set(oldId, target.coin.id);
      targetIds.set(target.key, ids);
    }
    let order = state.order;
    const contexts = Object.fromEntries(
      Object.entries(state.contexts).map(([key, context]) => {
        const ids = new Map(targetIds.get(key));
        const pendingRemovals = Object.fromEntries(
          Object.entries(context.pendingRemovals).map(([selector, removal]) => {
            const itemId = idFor(removal.itemId, removal.selector);
            if (!ids.has(removal.itemId)) ids.set(removal.itemId, itemId);
            return [
              selector,
              {
                ...removal,
                itemId,
                scope:
                  removal.scope ??
                  (context.intents[removal.itemId]?.kind === 'remove'
                    ? ('coin' as const)
                    : ('selector' as const)),
              },
            ];
          }),
        );
        const grouped = new Map<
          string,
          Array<AlertContextState['alerts'][string]>
        >();
        for (const [id, mirrored] of Object.entries(context.alerts)) {
          const nextId = idFor(id, mirrored.alert);
          if (!ids.has(id)) ids.set(id, nextId);
          grouped.set(nextId, [...(grouped.get(nextId) || []), mirrored]);
        }
        const alerts: AlertContextState['alerts'] = {};
        for (const [id, candidates] of grouped) {
          const preferred = items.find(item => item.id === id)?.selector;
          const kept =
            candidates.find(
              value =>
                preferred &&
                selectorKey(value.alert) === selectorKey(preferred),
            ) || candidates[0];
          alerts[id] = {
            ...kept,
            ...(candidates.some(value => value.unknown) ? {unknown: true} : {}),
          };
          for (const value of candidates) {
            const selector = selectorKey(value.alert);
            if (
              selector !== selectorKey(kept.alert) &&
              !pendingRemovals[selector]
            ) {
              pendingRemovals[selector] = {
                itemId: id,
                selector: value.alert,
                order: ++order,
                scope: 'selector',
              };
            }
          }
        }
        const intents: AlertContextState['intents'] = {};
        for (const [id, intent] of Object.entries(context.intents)) {
          const nextId = rows.get(id)?.id || ids.get(id) || idFor(id);
          if (!intents[nextId] || intents[nextId].order < intent.order)
            intents[nextId] = intent;
        }
        return [key, {...context, alerts, intents, pendingRemovals}];
      }),
    );
    const sheet = state.alertSheet;
    const sheetCoin =
      sheet && (rows.get(sheet.coin.id) || this.matchStored(sheet.coin));
    this.deps.write({
      ...state,
      items,
      contexts,
      order,
      ...(sheet && sheetCoin
        ? {
            alertSheet: {
              ...sheet,
              coin: items.find(item => item.id === sheetCoin.id) || {
                ...sheetCoin,
                selector: sheet.coin.selector,
              },
            },
          }
        : {}),
      ...(state.lastAdded
        ? {lastAdded: {...state.lastAdded, id: idFor(state.lastAdded.id)}}
        : {}),
    });
    this.catalogSnapshot = catalog;
    return rows;
  }

  private captureTarget(ticket: Ticket, coin: WatchlistCoin) {
    const rows = this.refreshCatalog();
    const matched = rows.get(coin.id) || this.matchStored(coin) || coin;
    const stored = this.deps.read().items.find(item => item.id === matched.id);
    return {
      key: ticket.key,
      coin: {
        ...matched,
        selector:
          this.context(ticket).alerts[matched.id]?.alert ||
          stored?.selector ||
          coin.selector,
      },
    };
  }

  private activate(): Ticket | undefined {
    const key = this.deps.environment().context;
    if (key !== this.active) {
      this.active = key;
      this.generation++;
    }
    this.permissionChanged();
    if (!key) {
      return undefined;
    }
    const state = this.deps.read();
    if (!this.initialized.has(key)) {
      this.initialized.add(key);
      const context = {
        ...emptyAlertContext(),
        ...state.contexts[key],
        disabled: false,
      };
      context.pendingRemovals = Object.fromEntries(
        Object.entries(context.pendingRemovals).map(([selector, removal]) => [
          selector,
          {
            ...removal,
            scope:
              removal.scope ??
              (context.intents[removal.itemId]?.kind === 'remove'
                ? 'coin'
                : 'selector'),
          },
        ]),
      );
      this.deps.write({
        ...state,
        activeContext: key,
        contexts: {
          ...state.contexts,
          [key]: context,
        },
      });
    } else if (state.activeContext !== key) {
      this.deps.write({...state, activeContext: key});
    }
    return {key, generation: this.generation};
  }

  private current(ticket: Ticket) {
    return (
      this.deps.environment().context === ticket.key &&
      this.active === ticket.key &&
      this.generation === ticket.generation
    );
  }

  private context(ticket: Ticket) {
    return this.deps.read().contexts[ticket.key];
  }

  private patch(
    ticket: Ticket,
    update: (
      context: AlertContextState,
      state: WatchlistState,
    ) => Partial<AlertContextState>,
    items?: WatchlistCoin[],
  ) {
    if (!this.current(ticket)) {
      return;
    }
    const state = this.deps.read();
    this.deps.write({
      ...state,
      ...(items ? {items} : {}),
      contexts: {
        ...state.contexts,
        [ticket.key]: {
          ...state.contexts[ticket.key],
          ...update(state.contexts[ticket.key], state),
        },
      },
    });
  }

  private enqueue<T>(
    ticket: Ticket,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    const result = (this.tails.get(ticket.key) || Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (!this.current(ticket) || this.context(ticket).disabled) {
          return undefined;
        }
        return task();
      });
    this.tails.set(
      ticket.key,
      result.catch(() => {}),
    );
    return result;
  }

  private async call<T>(
    ticket: Ticket,
    request: () => Promise<T>,
    selector?: PriceAlertSelector,
  ): Promise<T> {
    try {
      return await request();
    } catch (cause) {
      const error = priceAlertsError(cause);
      this.patch(ticket, context => ({
        ...(error.code === 'PRICE_ALERTS_DISABLED' ? {disabled: true} : {}),
        ...(error.outcomeUnknown && selector
          ? {
              unknownSelectors: {
                ...context.unknownSelectors,
                [selectorKey(selector)]: true,
              },
            }
          : {}),
      }));
      this.permissionChanged();
      throw error;
    }
  }

  private intent(
    ticket: Ticket,
    itemId: string,
    kind: 'save' | 'off' | 'remove',
  ) {
    const state = this.deps.read();
    const order = state.order + 1;
    this.deps.write({
      ...state,
      order,
      contexts: {
        ...state.contexts,
        [ticket.key]: {
          ...state.contexts[ticket.key],
          intents: {
            ...state.contexts[ticket.key].intents,
            [itemId]: {order, kind},
          },
        },
      },
    });
    return order;
  }

  private wanted(ticket: Ticket, id: string, order: number) {
    return (
      this.current(ticket) && this.context(ticket).intents[id]?.order === order
    );
  }

  private async registration(ticket: Ticket) {
    if (
      !this.current(ticket) ||
      this.deps.environment().pushEnabled === undefined
    ) {
      return;
    }
    let context = this.context(ticket);
    if (!context.attemptedSave && !context.registration?.registered) {
      return;
    }
    if (context.registrationUnknown) {
      await this.list(ticket);
      if (!this.current(ticket)) {
        return;
      }
      context = this.context(ticket);
    }
    const env = this.deps.environment();
    if (env.pushEnabled === undefined) {
      return;
    }
    if (!env.externalUserId) {
      throw new PriceAlertsError('MISSING_BRAZE_ID');
    }
    const values: PriceAlertPreferences = {
      externalUserId: env.externalUserId,
      priceAlertsEnabled:
        this.desiredEnabled.get(ticket.key) ??
        this.deps.read().priceAlertsEnabled,
      pushEnabled: env.pushEnabled,
    };
    const acknowledged = context.registration?.registered
      ? context.registration
      : undefined;
    const changes: Partial<PriceAlertPreferences> = {};
    for (const key of Object.keys(values) as (keyof PriceAlertPreferences)[]) {
      if (!acknowledged || values[key] !== acknowledged[key]) {
        Object.assign(changes, {[key]: values[key]});
      }
    }
    if (!Object.keys(changes).length) {
      return;
    }
    try {
      const registration = await this.call(ticket, () =>
        this.deps.api().register(changes),
      );
      this.patch(ticket, () => ({registration, registrationUnknown: false}));
    } catch (error) {
      if (priceAlertsError(error).outcomeUnknown) {
        this.patch(ticket, () => ({registrationUnknown: true}));
      }
      throw error;
    }
  }

  private async removals(ticket: Ticket) {
    const pending = Object.values(this.context(ticket).pendingRemovals).sort(
      (a, b) => a.order - b.order,
    );
    for (const removal of pending) {
      if (!this.current(ticket) || this.context(ticket).disabled) {
        return;
      }
      const key = selectorKey(removal.selector);
      if (this.context(ticket).pendingRemovals[key]?.order !== removal.order) {
        continue;
      }
      try {
        await this.call(
          ticket,
          () => this.deps.api().remove(removal.selector),
          removal.selector,
        );
        this.patch(ticket, context => {
          const pendingRemovals = {...context.pendingRemovals};
          const unknownSelectors = {...context.unknownSelectors};
          if (pendingRemovals[key]?.order === removal.order) {
            delete pendingRemovals[key];
            delete unknownSelectors[key];
          }
          return {pendingRemovals, unknownSelectors};
        });
      } catch {
        /* Retain the exact selector and retry on the next sync. */
      }
    }
  }

  private reconcile(
    ticket: Ticket,
    response: PriceAlertsResponse,
    requestOrder: number,
    backendSnapshot = true,
  ) {
    if (!this.current(ticket)) {
      return;
    }
    this.refreshCatalog();
    const state = this.deps.read();
    const context = this.context(ticket);
    const catalog = this.deps.catalog();
    const items = [...state.items];
    const alerts: AlertContextState['alerts'] = backendSnapshot
      ? {}
      : {...context.alerts};
    const pendingRemovals = {...context.pendingRemovals};
    const unresolved: PriceAlert[] = [];
    let order = state.order;
    // Preserve UI state changed since this list started, even without a badge.
    for (const [id, value] of Object.entries(context.alerts)) {
      if (
        context.intents[id]?.order > requestOrder ||
        this.pendingUserOrders.has(context.intents[id]?.order)
      ) {
        alerts[id] = value;
      }
    }
    const groups = new Map<
      string,
      {coin: WatchlistCoin; alerts: PriceAlert[]}
    >();
    for (const alert of response.alerts) {
      if (pendingRemovals[selectorKey(alert)]) {
        continue;
      }
      const coin =
        catalog.fromSelector(alert) ||
        items.find(item => selectorKey(item.selector) === selectorKey(alert));
      if (!coin) {
        unresolved.push(alert);
        continue;
      }
      const intent = context.intents[coin.id];
      const removalOrder = Math.max(
        intent?.kind === 'remove' ? intent.order : -1,
        ...Object.values(pendingRemovals)
          .filter(
            removal => removal.itemId === coin.id && removal.scope === 'coin',
          )
          .map(removal => removal.order),
      );
      if (removalOrder >= 0) {
        pendingRemovals[selectorKey(alert)] = {
          itemId: coin.id,
          selector: alert,
          order: removalOrder,
          scope: 'coin',
        };
        continue;
      }
      if (
        intent?.order > requestOrder ||
        this.pendingUserOrders.has(intent?.order)
      ) {
        continue;
      }
      const group = groups.get(coin.id) || {coin, alerts: []};
      group.alerts.push(alert);
      groups.set(coin.id, group);
    }
    for (const [id, group] of groups) {
      const previous =
        context.alerts[id]?.alert ||
        items.find(item => item.id === id)?.selector;
      const kept =
        group.alerts.find(
          alert => previous && selectorKey(previous) === selectorKey(alert),
        ) || group.alerts[0];
      alerts[id] = {
        ...(!backendSnapshot ? context.alerts[id] : {}),
        alert: kept,
      };
      const index = items.findIndex(item => item.id === id);
      const item = {
        ...group.coin,
        selector:
          'coin' in kept
            ? {coin: kept.coin}
            : {chain: kept.chain, tokenAddress: kept.tokenAddress},
      };
      if (index < 0) {
        items.push(item);
      } else {
        items[index] = item;
      }
      for (const duplicate of group.alerts) {
        if (duplicate === kept) {
          continue;
        }
        pendingRemovals[selectorKey(duplicate)] = {
          itemId: id,
          selector: duplicate,
          order: ++order,
          scope: 'selector',
        };
      }
    }
    // A list settles outcomes at its snapshot time only. Timed-out requests
    // might still arrive at the server later; no server ordering is assumed.
    const unknownSelectors = {...context.unknownSelectors};
    for (const key of Object.keys(unknownSelectors)) {
      if (backendSnapshot && !pendingRemovals[key]) {
        delete unknownSelectors[key];
      }
    }
    const intents = backendSnapshot
      ? Object.fromEntries(
          Object.entries(context.intents).filter(
            ([, intent]) =>
              intent.order > requestOrder ||
              this.pendingUserOrders.has(intent.order),
          ),
        )
      : context.intents;
    this.deps.write({
      ...state,
      order,
      items,
      contexts: {
        ...state.contexts,
        [ticket.key]: {
          ...context,
          alerts,
          pendingRemovals,
          unresolved,
          unresolvedOrder: backendSnapshot
            ? requestOrder
            : context.unresolvedOrder,
          unknownSelectors,
          intents,
          ...(backendSnapshot
            ? {
                registration: response.registration,
                registrationUnknown: false,
                attemptedSave:
                  context.attemptedSave || response.registration.registered,
              }
            : {}),
        },
      },
    });
  }

  private async list(ticket: Ticket) {
    const order = this.deps.read().order;
    const response = await this.call(ticket, () => this.deps.api().list());
    this.reconcile(ticket, response, order);
  }

  private async currencies(ticket: Ticket) {
    for (const [previousId, previous] of Object.entries(
      this.context(ticket).alerts,
    )) {
      if (!this.current(ticket) || this.context(ticket).disabled) {
        return;
      }
      const context = this.context(ticket);
      const id =
        this.deps.catalog().fromSelector(previous.alert)?.id || previousId;
      const mirrored = context.alerts[id];
      if (
        !mirrored ||
        selectorKey(mirrored.alert) !== selectorKey(previous.alert)
      ) {
        continue;
      }
      const key = selectorKey(mirrored.alert);
      const intent = context.intents[id];
      const code = alertCurrency(this.deps.environment().currency);
      if (
        context.pendingRemovals[key] ||
        context.unknownSelectors[key] ||
        this.pendingUserOrders.has(intent?.order) ||
        (intent && intent.kind !== 'save') ||
        mirrored.alert.code === code
      ) {
        continue;
      }
      const order = this.deps.read().order;
      try {
        const saved = await this.call(
          ticket,
          () =>
            this.deps
              .api()
              .save(mirrored.alert, mirrored.alert.thresholdPct, code),
          mirrored.alert,
        );
        const currentId =
          this.deps.catalog().fromSelector(mirrored.alert)?.id || id;
        const latest = this.context(ticket);
        if (
          !this.current(ticket) ||
          latest.intents[currentId]?.order > order ||
          !latest.alerts[currentId] ||
          selectorKey(latest.alerts[currentId].alert) !== key ||
          latest.pendingRemovals[key]
        ) {
          continue;
        }
        this.patch(ticket, current => ({
          alerts: {...current.alerts, [currentId]: {alert: saved}},
        }));
      } catch {
        /* Background failures retry at sync. */
      }
    }
  }

  add(coin: WatchlistCoin) {
    const rows = this.refreshCatalog();
    coin = {
      ...(rows.get(coin.id) || this.matchStored(coin) || coin),
      selector: coin.selector,
    };
    const state = this.deps.read();
    if (state.items.some(item => item.id === coin.id)) {
      return false;
    }
    if (state.items.length >= 20) {
      throw new PriceAlertsError('WATCHLIST_FULL');
    }
    this.deps.write({...state, items: [...state.items, coin]});
    return true;
  }

  reorder(id: string, to: number) {
    const state = this.deps.read();
    const from = state.items.findIndex(item => item.id === id);
    const target = Math.max(0, Math.min(to, state.items.length - 1));
    if (from < 0 || target === from) {
      return undefined;
    }
    const items = [...state.items];
    const [item] = items.splice(from, 1);
    items.splice(target, 0, item);
    this.deps.write({...state, items});
    return {
      coin: item.symbol.toLowerCase(),
      from_position: from + 1,
      to_position: target + 1,
      moved_into_top_5: from >= 5 && target < 5,
    };
  }

  remove(coin: WatchlistCoin) {
    const ticket = this.activate();
    const rows = this.refreshCatalog();
    coin = rows.get(coin.id) || this.matchStored(coin) || coin;
    const state = this.deps.read();
    const context = ticket ? this.context(ticket) : undefined;
    const alert = context?.alerts[coin.id]?.alert;
    const order = state.order + 1;
    const items = state.items.filter(item => item.id !== coin.id);
    const contexts = {...state.contexts};
    if (ticket && context) {
      const alerts = {...context.alerts};
      delete alerts[coin.id];
      const selector =
        alert ||
        state.items.find(item => item.id === coin.id)?.selector ||
        coin.selector;
      const pendingRemovals = Object.fromEntries(
        Object.entries(context.pendingRemovals).map(([key, removal]) => [
          key,
          removal.itemId === coin.id
            ? {...removal, order, scope: 'coin' as const}
            : removal,
        ]),
      );
      contexts[ticket.key] = {
        ...context,
        alerts,
        intents: {...context.intents, [coin.id]: {order, kind: 'remove'}},
        pendingRemovals: {
          ...pendingRemovals,
          ...(context.attemptedSave || context.registration?.registered
            ? {
                [selectorKey(selector)]: {
                  itemId: coin.id,
                  selector,
                  order,
                  scope: 'coin' as const,
                },
              }
            : {}),
        },
      };
    }
    this.deps.write({...state, items, order, contexts});
    if (ticket) {
      void this.enqueue(ticket, () => this.removals(ticket)).catch(() => {});
    }
    return alert;
  }

  save(coin: WatchlistCoin, threshold: PriceAlertThreshold) {
    const ticket = this.activate();
    if (!ticket) {
      return Promise.reject(new PriceAlertsError('NOT_READY'));
    }
    const target = this.captureTarget(ticket, coin);
    coin = target.coin;
    const state = this.deps.read();
    if (
      !state.items.some(item => item.id === coin.id) &&
      state.items.length >= 20
    ) {
      return Promise.reject(new PriceAlertsError('WATCHLIST_FULL'));
    }
    const order = this.intent(ticket, coin.id, 'save');
    this.targets.set(order, target);
    this.pendingUserOrders.add(order);
    this.patch(ticket, () => ({attemptedSave: true}));
    return this.enqueueAfterPermission(ticket, async () => {
      if (!this.wanted(ticket, target.coin.id, order)) {
        return;
      }
      await this.registration(ticket);
      // A recovery list can settle the save's original intent. Preserve a
      // genuinely newer user action, but continue this still-wanted save.
      if (
        this.current(ticket) &&
        !this.context(ticket).intents[target.coin.id]
      ) {
        this.patch(ticket, current => ({
          intents: {
            ...current.intents,
            [target.coin.id]: {order, kind: 'save'},
          },
        }));
      }
      if (!this.wanted(ticket, target.coin.id, order)) {
        return;
      }
      await this.removals(ticket);
      if (!this.wanted(ticket, target.coin.id, order)) {
        return;
      }
      const beforeSave = this.deps.read();
      if (
        !beforeSave.items.some(item => item.id === target.coin.id) &&
        beforeSave.items.length >= 20
      ) {
        throw new PriceAlertsError('WATCHLIST_FULL');
      }
      const context = this.context(ticket);
      const selector =
        context.alerts[target.coin.id]?.alert ||
        this.deps.read().items.find(item => item.id === target.coin.id)
          ?.selector ||
        target.coin.selector;
      const saved = await this.call(
        ticket,
        () =>
          this.deps
            .api()
            .save(
              selector,
              threshold,
              alertCurrency(this.deps.environment().currency),
            ),
        selector,
      );
      if (!this.wanted(ticket, target.coin.id, order)) {
        return;
      }
      const latest = this.deps.read();
      const items = latest.items.some(item => item.id === target.coin.id)
        ? latest.items.map(item =>
            item.id === target.coin.id ? {...item, selector} : item,
          )
        : [...latest.items, {...target.coin, selector}];
      this.patch(
        ticket,
        current => {
          const pendingRemovals = {...current.pendingRemovals};
          for (const [pendingKey, removal] of Object.entries(pendingRemovals)) {
            if (
              removal.itemId === target.coin.id &&
              removal.order < order &&
              removal.scope === 'coin'
            ) {
              pendingRemovals[pendingKey] = {...removal, scope: 'selector'};
            }
          }
          const key = selectorKey(selector);
          if (pendingRemovals[key]?.order < order) {
            delete pendingRemovals[key];
          }
          const unknownSelectors = {...current.unknownSelectors};
          delete unknownSelectors[key];
          return {
            alerts: {...current.alerts, [target.coin.id]: {alert: saved}},
            pendingRemovals,
            unknownSelectors,
          };
        },
        items,
      );
      return saved;
    }).finally(() => {
      this.pendingUserOrders.delete(order);
      this.targets.delete(order);
    });
  }

  turnOff(coin: WatchlistCoin) {
    const ticket = this.activate();
    if (!ticket) {
      return Promise.reject(new PriceAlertsError('NOT_READY'));
    }
    const target = this.captureTarget(ticket, coin);
    coin = target.coin;
    const order = this.intent(ticket, coin.id, 'off');
    this.targets.set(order, target);
    this.pendingUserOrders.add(order);
    return this.enqueue(ticket, async () => {
      if (!this.wanted(ticket, target.coin.id, order)) {
        return;
      }
      const alert = this.context(ticket).alerts[target.coin.id]?.alert;
      if (!alert) {
        return;
      }
      await this.call(ticket, () => this.deps.api().remove(alert), alert);
      if (!this.wanted(ticket, target.coin.id, order)) {
        return;
      }
      this.patch(ticket, context => {
        const alerts = {...context.alerts};
        const unknownSelectors = {...context.unknownSelectors};
        delete alerts[target.coin.id];
        delete unknownSelectors[selectorKey(alert)];
        return {alerts, unknownSelectors};
      });
      return alert;
    }).finally(() => {
      this.pendingUserOrders.delete(order);
      this.targets.delete(order);
    });
  }

  sync(): Promise<void> {
    const ticket = this.activate();
    if (!ticket || this.context(ticket).disabled) {
      return Promise.resolve();
    }
    if (this.syncing.has(ticket.key)) {
      return this.syncing.get(ticket.key)!;
    }
    const first = !this.probes.has(ticket.key);
    const context = this.context(ticket);
    const now = this.deps.now?.() ?? Date.now();
    if (
      !first &&
      ((!context.attemptedSave && !context.registration?.registered) ||
        now - (context.lastSync ?? -Infinity) < 60000)
    ) {
      return Promise.resolve();
    }
    this.probes.add(ticket.key);
    const work = this.enqueue(ticket, async () => {
      this.patch(ticket, () => ({lastSync: this.deps.now?.() ?? Date.now()}));
      await this.removals(ticket);
      if (!this.current(ticket) || this.context(ticket).disabled) {
        return;
      }
      await this.list(ticket);
      if (!this.current(ticket)) {
        return;
      }
      await this.registration(ticket);
      if (!this.current(ticket)) {
        return;
      }
      await this.currencies(ticket);
    })
      .catch(() => {})
      .then(() => {
        this.syncing.delete(ticket.key);
      });
    this.syncing.set(ticket.key, work);
    return work;
  }

  preferencesChanged() {
    const ticket = this.activate();
    if (!ticket || this.deps.environment().pushEnabled === undefined) {
      return Promise.resolve();
    }
    return this.enqueue(ticket, async () => {
      await this.registration(ticket);
      if (this.current(ticket)) {
        await this.currencies(ticket);
      }
    }).catch(() => {});
  }

  async setEnabled(enabled: boolean) {
    const ticket = this.activate();
    if (!ticket || !this.context(ticket).registration?.registered) {
      this.deps.write({...this.deps.read(), priceAlertsEnabled: enabled});
      return;
    }
    this.desiredEnabled.set(ticket.key, enabled);
    try {
      await this.enqueueAfterPermission(ticket, () =>
        this.registration(ticket),
      );
      if (
        this.current(ticket) &&
        this.context(ticket).registration?.registered
      ) {
        const acknowledged = this.context(ticket).registration;
        if (
          acknowledged?.registered &&
          acknowledged.priceAlertsEnabled === enabled
        ) {
          this.deps.write({...this.deps.read(), priceAlertsEnabled: enabled});
        } else {
          throw new PriceAlertsError('PRICE_ALERTS_REQUEST_FAILED');
        }
      }
    } finally {
      if (this.desiredEnabled.get(ticket.key) === enabled) {
        this.desiredEnabled.delete(ticket.key);
      }
    }
  }

  catalogChanged() {
    this.refreshCatalog();
    const ticket = this.activate();
    if (!ticket) {
      return;
    }
    const context = this.context(ticket);
    if (!context.unresolved.length) {
      return;
    }
    this.reconcile(
      ticket,
      {
        registration: context.registration || {registered: false},
        alerts: [
          ...Object.values(context.alerts).map(value => value.alert),
          ...context.unresolved,
        ],
      },
      context.unresolvedOrder ?? this.deps.read().order,
      false,
    );
  }
}
