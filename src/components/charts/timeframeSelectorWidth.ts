const MAX_TIMEFRAME_SELECTOR_WIDTH = 450;

export const getTimeframeSelectorWidth = (
  windowWidth: number,
  screenGutter: string,
): number =>
  Math.min(
    Math.max(windowWidth - Number.parseInt(screenGutter, 10) * 2, 0),
    MAX_TIMEFRAME_SELECTOR_WIDTH,
  );

