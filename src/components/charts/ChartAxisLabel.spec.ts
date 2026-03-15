import {
  getChartAxisLabelPointRatio,
  getChartAxisLabelTranslateX,
} from './chartLayout';

describe('ChartAxisLabel layout helpers', () => {
  it('uses the midpoint for single-point series', () => {
    expect(getChartAxisLabelPointRatio(0, 1)).toBe(0.5);
    expect(getChartAxisLabelPointRatio(10, 1)).toBe(0.5);
  });

  it('clamps translated labels within a narrow chart width', () => {
    expect(
      getChartAxisLabelTranslateX({
        index: 0,
        arrayLength: 5,
        chartWidth: 240,
        textWidth: 80,
      }),
    ).toBe(5);

    expect(
      getChartAxisLabelTranslateX({
        index: 4,
        arrayLength: 5,
        chartWidth: 240,
        textWidth: 80,
      }),
    ).toBe(160);
  });

  it('spreads positions across wider chart widths', () => {
    expect(
      getChartAxisLabelTranslateX({
        index: 2,
        arrayLength: 5,
        chartWidth: 420,
        textWidth: 80,
      }),
    ).toBe(170);
  });
});
