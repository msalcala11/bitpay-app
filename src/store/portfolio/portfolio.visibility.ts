const PORTFOLIO_POPULATE_VISIBILITY_POLL_MS = 250;

const visiblePortfolioPopulateScreens = new Set<string>();

export const setPortfolioPopulateScreenVisible = (
  screenId: string,
  visible: boolean,
) => {
  if (!screenId) {
    return;
  }

  if (visible) {
    visiblePortfolioPopulateScreens.add(screenId);
    return;
  }

  visiblePortfolioPopulateScreens.delete(screenId);
};

export const isPortfolioPopulateScreenVisible = (): boolean =>
  visiblePortfolioPopulateScreens.size > 0;

export const waitForPortfolioPopulateScreenVisible = async (args?: {
  shouldAbort?: () => boolean;
  pollIntervalMs?: number;
}): Promise<boolean> => {
  const pollIntervalMs = Math.max(
    1,
    Math.floor(
      args?.pollIntervalMs ?? PORTFOLIO_POPULATE_VISIBILITY_POLL_MS,
    ),
  );

  while (!isPortfolioPopulateScreenVisible()) {
    if (args?.shouldAbort?.()) {
      return false;
    }

    await new Promise<void>(resolve => setTimeout(resolve, pollIntervalMs));
  }

  return !args?.shouldAbort?.();
};
