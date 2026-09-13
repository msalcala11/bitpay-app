import React from 'react';
import {View} from 'react-native';
import {act, render} from '@testing-library/react-native';
import {BottomSheetModal, BottomSheetModalProvider} from '@gorhom/bottom-sheet';

jest.unmock('@gorhom/bottom-sheet');

const mockSheets = new Map<
  string,
  {
    props: any;
    close: jest.Mock;
    forceClose: jest.Mock;
    snapToIndex: jest.Mock;
  }
>();

// Keep Gorhom's actual modal and provider/stack implementations. Only replace
// the native animation boundary so callbacks can be delivered in native order.
jest.mock('@gorhom/bottom-sheet/lib/commonjs/components/bottomSheet', () => {
  const MockReact = require('react');
  const NativeView = require('react-native').View;
  return {
    __esModule: true,
    default: MockReact.forwardRef((props: any, ref: any) => {
      const methods = MockReact.useMemo(
        () => ({
          close: jest.fn(),
          forceClose: jest.fn(),
          snapToIndex: jest.fn(),
        }),
        [],
      );
      mockSheets.set(props.testID, {props, ...methods});
      MockReact.useImperativeHandle(ref, () => methods);
      return <NativeView testID={props.testID}>{props.children}</NativeView>;
    }),
  };
});

describe('Gorhom stacked modal callbacks', () => {
  beforeEach(() => {
    mockSheets.clear();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  function mountPair(stackBehavior?: 'push' | 'replace') {
    const first = React.createRef<BottomSheetModal>();
    const second = React.createRef<BottomSheetModal>();
    const firstDismiss = jest.fn();
    const secondDismiss = jest.fn();
    const view = render(
      <BottomSheetModalProvider>
        <BottomSheetModal
          ref={first}
          name="first"
          testID="first"
          onDismiss={firstDismiss}>
          <View />
        </BottomSheetModal>
        <BottomSheetModal
          ref={second}
          name="second"
          testID="second"
          stackBehavior={stackBehavior}
          onDismiss={secondDismiss}>
          <View />
        </BottomSheetModal>
      </BottomSheetModalProvider>,
    );
    const present = (ref: typeof first) => {
      act(() => ref.current!.present());
      act(() => jest.runOnlyPendingTimers());
    };
    const arrive = (id: string, index: number) =>
      act(() => {
        const props = mockSheets.get(id)!.props;
        props.onChange(index, 0, 0);
        if (index === -1) props.onClose();
      });
    present(first);
    arrive('first', 0);
    return {first, second, firstDismiss, secondDismiss, present, arrive, view};
  }

  it('minimizes the first sheet without dismissing it and restores it after the second closes', () => {
    const pair = mountPair();
    pair.present(pair.second);
    expect(mockSheets.get('first')!.close).toHaveBeenCalledTimes(1);
    pair.arrive('first', -1);
    pair.arrive('second', 0);
    expect(pair.firstDismiss).not.toHaveBeenCalled();
    expect(pair.view.getByTestId('first')).toBeTruthy();

    act(() => pair.second.current!.dismiss());
    expect(mockSheets.get('first')!.snapToIndex).toHaveBeenCalledWith(0);
    pair.arrive('first', 0);
    pair.arrive('second', -1);
    expect(pair.secondDismiss).toHaveBeenCalledTimes(1);
    expect(pair.firstDismiss).not.toHaveBeenCalled();
  });

  it('can dismiss a minimized underlying sheet without restoring it later', () => {
    const pair = mountPair();
    pair.present(pair.second);
    pair.arrive('first', -1);
    pair.arrive('second', 0);
    expect(pair.firstDismiss).not.toHaveBeenCalled();
    act(() => pair.first.current!.dismiss());
    expect(pair.firstDismiss).toHaveBeenCalledTimes(1);
    act(() => pair.second.current!.dismiss());
    pair.arrive('second', -1);
    expect(mockSheets.get('first')!.snapToIndex).not.toHaveBeenCalled();
  });

  it('preserves a real dismissal when closing while minimization is in progress', () => {
    const pair = mountPair();
    pair.present(pair.second);
    act(() => pair.first.current!.dismiss());
    pair.arrive('first', -1);
    expect(pair.firstDismiss).toHaveBeenCalledTimes(1);
  });

  it('push keeps the underlying sheet open', () => {
    const pair = mountPair('push');
    pair.present(pair.second);
    pair.arrive('second', 0);
    expect(mockSheets.get('first')!.close).not.toHaveBeenCalled();
    expect(pair.firstDismiss).not.toHaveBeenCalled();
  });

  it('replace dismisses the underlying sheet exactly once', () => {
    const pair = mountPair('replace');
    pair.present(pair.second);
    expect(mockSheets.get('first')!.forceClose).toHaveBeenCalledTimes(1);
    pair.arrive('first', -1);
    expect(pair.firstDismiss).toHaveBeenCalledTimes(1);
  });
});
