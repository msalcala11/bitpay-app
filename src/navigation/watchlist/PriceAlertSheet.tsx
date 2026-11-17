import React, {useRef, useState, useEffect} from 'react';
import {View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useTheme} from '../../contexts';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {BaseText, H5} from '../../components/styled/Text';
import {SheetContainer} from '../../components/styled/Containers';
import SheetModal from '../../components/modal/base/sheet/SheetModal';
import Button, {ButtonState} from '../../components/button/Button';
import {TouchableOpacity} from '../../components/base/TouchableOpacity';
import {
  Action,
  White,
  Slate30,
  SlateDark,
  LightBlack,
} from '../../styles/colors';
import {
  selectAlertContext,
  selectAlertsAvailable,
} from '../../store/watchlist/watchlist.selectors';
import {
  savePriceAlert,
  turnOffPriceAlert,
} from '../../store/watchlist/watchlist.effects';
import {
  closePriceAlert,
  finishPriceAlert,
  showPriceAlertError,
} from './watchlistUi.effects';
import type {PriceAlertThreshold} from '../../api/price-alerts/price-alerts.types';
import type {WatchlistState} from '../../store/watchlist/watchlist.models';
import {showBottomNotificationModal} from '../../store/app/app.actions';

export const ThresholdChips = ({
  value,
  onChange,
  disabled,
}: {
  value: PriceAlertThreshold;
  onChange: (value: PriceAlertThreshold) => void;
  disabled: boolean;
}) => {
  const {t} = useTranslation();
  const theme = useTheme();
  return (
    <View
      accessibilityLabel={t('Alert threshold')}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 8,
      }}>
      {([5, 10, 15, 20] as const).map(threshold => (
        <TouchableOpacity
          key={threshold}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityState={{selected: value === threshold, disabled}}
          accessibilityLabel={t('{{threshold}}%', {threshold})}
          onPress={() => onChange(threshold)}
          style={{
            minWidth: 58,
            minHeight: 44,
            borderRadius: 50,
            borderWidth: 1,
            borderColor: value === threshold ? Action : Slate30,
            backgroundColor:
              value === threshold ? Action : theme.dark ? LightBlack : White,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 12,
          }}>
          <BaseText
            style={{
              fontSize: 16,
              color: value === threshold ? White : theme.colors.text,
            }}>
            {t('{{threshold}}%', {threshold})}
          </BaseText>
        </TouchableOpacity>
      ))}
    </View>
  );
};

const AlertForm = ({
  sheet,
}: {
  sheet: NonNullable<WatchlistState['alertSheet']>;
}) => {
  const {t} = useTranslation();
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const alert = useAppSelector(
    state => selectAlertContext(state)?.alerts[sheet.coin.id]?.alert,
  );
  const [threshold, setThreshold] = useState<PriceAlertThreshold>(
    alert?.thresholdPct || 10,
  );
  const [buttonState, setButtonState] = useState<ButtonState>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      mounted.current = false;
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );
  const save = async () => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setButtonState('loading');
    try {
      const saved = await dispatch(savePriceAlert(sheet.coin, threshold));
      if (!mounted.current) {
        return;
      }
      if (!saved) {
        dispatch(closePriceAlert());
        return;
      }
      setButtonState('success');
      timer.current = setTimeout(() => dispatch(closePriceAlert(true)), 900);
    } catch {
      if (!mounted.current) {
        return;
      }
      busy.current = false;
      setButtonState(null);
      dispatch(showPriceAlertError());
    }
  };
  const turnOff = () =>
    dispatch(
      showBottomNotificationModal({
        type: 'warning',
        title: t('Turn off price alert?'),
        message: t('You won’t get price alerts for {{coin}}.', {
          coin: sheet.coin.name,
        }),
        modalLibrary: 'bottom-sheet',
        enableBackdropDismiss: true,
        actions: [
          {
            text: t('Turn Off'),
            primary: true,
            action: async () => {
              try {
                await dispatch(turnOffPriceAlert(sheet.coin));
                dispatch(closePriceAlert());
              } catch {
                dispatch(showPriceAlertError());
              }
            },
          },
          {text: t('Cancel'), action: () => {}},
        ],
      }),
    );
  return (
    <SheetContainer>
      <View style={{alignItems: 'center', gap: 16, paddingBottom: 20}}>
        <H5 style={{fontSize: 18, lineHeight: 24, fontWeight: '700'}}>
          {alert ? t('Edit Price Alert') : t('Set Price Alert')}
        </H5>
        <BaseText
          style={{
            fontSize: 16,
            lineHeight: 25,
            textAlign: 'center',
            color: theme.dark ? Slate30 : SlateDark,
          }}>
          {t('When the price moves by')}
        </BaseText>
        <ThresholdChips
          value={threshold}
          onChange={setThreshold}
          disabled={!!buttonState}
        />
        <View style={{alignSelf: 'stretch', marginTop: 8}}>
          <Button state={buttonState} disabled={!!buttonState} onPress={save}>
            {t('Save Price Alert')}
          </Button>
        </View>
        {alert ? (
          <Button buttonType="link" disabled={!!buttonState} onPress={turnOff}>
            {t('Turn Off Price Alert')}
          </Button>
        ) : sheet.afterAdd ? (
          <Button
            buttonType="link"
            disabled={!!buttonState}
            onPress={() => dispatch(closePriceAlert())}>
            {t('Not Now')}
          </Button>
        ) : null}
      </View>
    </SheetContainer>
  );
};
export default function PriceAlertSheet() {
  const dispatch = useAppDispatch();
  const sheet = useAppSelector(state => state.WATCHLIST.alertSheet);
  const available = useAppSelector(selectAlertsAvailable);
  return (
    <SheetModal
      isVisible={!!sheet?.open && available}
      onBackdropPress={() => dispatch(closePriceAlert())}
      onModalHide={() => dispatch(finishPriceAlert())}
      enableBackdropDismiss
      modalLibrary="bottom-sheet"
      backgroundColor="transparent">
      {sheet ? <AlertForm key={sheet.nonce} sheet={sheet} /> : null}
    </SheetModal>
  );
}
