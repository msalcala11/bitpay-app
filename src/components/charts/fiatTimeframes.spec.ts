import {getSelectedPointLabelFormatMode} from './fiatTimeframes';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('getSelectedPointLabelFormatMode', () => {
  it('keeps short bounded windows on their existing formats', () => {
    expect(getSelectedPointLabelFormatMode({selectedTimeframe: '1D'})).toBe(
      'time',
    );
    expect(getSelectedPointLabelFormatMode({selectedTimeframe: '1W'})).toBe(
      'dateTime',
    );
    expect(getSelectedPointLabelFormatMode({selectedTimeframe: '1M'})).toBe(
      'dateTime',
    );
    expect(getSelectedPointLabelFormatMode({selectedTimeframe: '3M'})).toBe(
      'date',
    );
  });

  it('formats ALL like 1D when the visible span is under a day', () => {
    expect(
      getSelectedPointLabelFormatMode({
        selectedTimeframe: 'ALL',
        displayedRangeMs: DAY_MS - 1,
      }),
    ).toBe('time');
  });

  it('formats ALL like 1W/1M when the visible span is under three months', () => {
    expect(
      getSelectedPointLabelFormatMode({
        selectedTimeframe: 'ALL',
        displayedRangeMs: 30 * DAY_MS,
      }),
    ).toBe('dateTime');
  });

  it('keeps ALL on date-only formatting for long spans or unknown ranges', () => {
    expect(
      getSelectedPointLabelFormatMode({
        selectedTimeframe: 'ALL',
        displayedRangeMs: 90 * DAY_MS,
      }),
    ).toBe('date');
    expect(getSelectedPointLabelFormatMode({selectedTimeframe: 'ALL'})).toBe(
      'date',
    );
  });
});
