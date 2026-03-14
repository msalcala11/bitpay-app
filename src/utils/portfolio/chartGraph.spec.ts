import type {GraphPoint} from 'react-native-graph';
import {
  GRAPH_DRAWABLE_EPSILON,
  normalizeGraphPointsForChart,
  recomputeMinMaxFromGraphPoints,
} from './chartGraph';

describe('chartGraph', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns empty inputs unchanged and leaves min/max unset', () => {
    const points: GraphPoint[] = [];

    expect(normalizeGraphPointsForChart(points)).toBe(points);
    expect(recomputeMinMaxFromGraphPoints(points)).toEqual({
      minIndex: 0,
      maxIndex: 0,
      minPoint: undefined,
      maxPoint: undefined,
    });
  });

  it('replaces invalid timestamps with monotonic fallbacks', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);

    const normalized = normalizeGraphPointsForChart([
      {date: new Date('invalid'), value: 10},
      {date: 'bad-ts' as unknown as Date, value: 20},
      {date: new Date(5_000), value: 30},
    ]);

    expect(normalized.map(point => point.date.getTime())).toEqual([
      1_000, 1_001, 5_000,
    ]);
  });

  it('forces duplicate and descending timestamps to stay strictly increasing', () => {
    const normalized = normalizeGraphPointsForChart([
      {date: new Date(100), value: 1},
      {date: new Date(100), value: 2},
      {date: new Date(99), value: 3},
    ]);

    expect(normalized.map(point => point.date.getTime())).toEqual([
      100, 101, 102,
    ]);
  });

  it('adds the drawable epsilon only to the last point for flat series', () => {
    const normalized = normalizeGraphPointsForChart([
      {date: new Date(100), value: 7},
      {date: new Date(200), value: 7},
      {date: new Date(300), value: 7},
    ]);

    expect(normalized.map(point => point.value)).toEqual([
      7,
      7,
      7 + GRAPH_DRAWABLE_EPSILON,
    ]);

    expect(recomputeMinMaxFromGraphPoints(normalized)).toMatchObject({
      minIndex: 0,
      maxIndex: 2,
      minPoint: normalized[0],
      maxPoint: normalized[2],
    });
  });
});
