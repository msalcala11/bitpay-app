import {getTimeframeSelectorWidth} from './timeframeSelectorWidth';

describe('getTimeframeSelectorWidth', () => {
  it('subtracts the horizontal screen gutter from the window width', () => {
    expect(getTimeframeSelectorWidth(320, '12px')).toBe(296);
  });

  it('clamps the width at zero for narrow windows', () => {
    expect(getTimeframeSelectorWidth(20, '12px')).toBe(0);
  });

  it('does not clamp wider layouts', () => {
    expect(getTimeframeSelectorWidth(600, '12px')).toBe(576);
  });
});
