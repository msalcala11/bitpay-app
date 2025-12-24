import React, {useCallback, useMemo, useRef, useState} from 'react';
import {Dimensions, Modal, Pressable, View} from 'react-native';
import styled from 'styled-components/native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {ActiveOpacity} from '../../../../components/styled/Containers';
import {BaseText} from '../../../../components/styled/Text';
import {LightBlack, Slate30, SlateDark, White} from '../../../../styles/colors';
import ChevronDown from './ChevronDown';

const Container = styled(TouchableOpacity)`
  flex-direction: row;
  align-items: center;
  border-radius: 50px;
  padding: 10px 14px;
  border: 1px solid ${({theme: {dark}}) => (dark ? SlateDark : Slate30)};
  background-color: ${({theme: {dark}}) => (dark ? 'transparent' : White)};
`;

const Label = styled(BaseText)`
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  line-height: 15px;
  margin-right: 10px;
  color: ${({theme: {dark}}) => (dark ? White : SlateDark)};
`;

const Menu = styled.View`
  width: 190px;
  border-radius: 10px;
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : White)};
  shadow-color: #000;
  shadow-offset: 0px 0px;
  shadow-opacity: 0.15;
  shadow-radius: 32px;
  elevation: 16;
`;

const MenuItem = styled(TouchableOpacity)`
  padding: 16px;
`;

const MenuItemText = styled(BaseText)`
  font-size: 14px;
  font-weight: 400;
  color: ${({theme}) => theme.colors.text};
`;

const Divider = styled.View`
  height: 1px;
  background-color: ${({theme: {dark}}) => (dark ? SlateDark : Slate30)};
`;

interface Props {
  onPress?: () => void;
  onChange?: (value: 'today' | 'total') => void;
}

const AssetsGainLossDropdown: React.FC<Props> = ({onPress, onChange}) => {
  const anchorRef = useRef<View>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [anchor, setAnchor] = useState<{x: number; y: number; w: number; h: number} | null>(
    null,
  );
  const [value, setValue] = useState<'today' | 'total'>('today');

  const displayLabel = useMemo(() => {
    return value === 'today' ? "Today’s Gain/Loss" : 'Total Gain/Loss';
  }, [value]);

  const open = useCallback(() => {
    onPress?.();
    if (!anchorRef.current?.measureInWindow) {
      setIsVisible(true);
      return;
    }
    anchorRef.current.measureInWindow((x: number, y: number, w: number, h: number) => {
      setAnchor({x, y, w, h});
      setIsVisible(true);
    });
  }, [onPress]);

  const close = useCallback(() => {
    setIsVisible(false);
  }, []);

  const select = useCallback(
    (next: 'today' | 'total') => {
      setValue(next);
      onChange?.(next);
      close();
    },
    [close, onChange],
  );

  const menuPosition = useMemo(() => {
    const menuWidth = 190;
    const margin = 12;
    const screenWidth = Dimensions.get('window').width;

    if (!anchor) {
      return {left: margin, top: margin};
    }

    // Align the menu to the right edge of the pill (like the screenshot), then clamp.
    const preferredLeft = anchor.x + anchor.w - menuWidth;
    const left = Math.max(margin, Math.min(preferredLeft, screenWidth - menuWidth - margin));
    const top = anchor.y + anchor.h + 8;
    return {left, top};
  }, [anchor]);

  return (
    <>
      <View ref={anchorRef} collapsable={false}>
        <Container activeOpacity={ActiveOpacity} onPress={open}>
          <Label>{displayLabel}</Label>
          <ChevronDown />
        </Container>
      </View>

      <Modal
        visible={isVisible}
        transparent
        animationType="fade"
        onRequestClose={close}>
        <View style={{flex: 1}}>
          <Pressable
            style={{position: 'absolute', top: 0, right: 0, bottom: 0, left: 0}}
            onPress={close}
          />
          <View style={{position: 'absolute', ...menuPosition}}>
            <Menu>
              <MenuItem activeOpacity={ActiveOpacity} onPress={() => select('today')}>
                <MenuItemText>Today's gain/loss</MenuItemText>
              </MenuItem>
              <Divider />
              <MenuItem activeOpacity={ActiveOpacity} onPress={() => select('total')}>
                <MenuItemText>Total gain/loss</MenuItemText>
              </MenuItem>
            </Menu>
          </View>
        </View>
      </Modal>
    </>
  );
};

export default AssetsGainLossDropdown;
