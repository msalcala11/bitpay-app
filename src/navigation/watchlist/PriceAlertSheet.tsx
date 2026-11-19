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
  Air,
  Black,
  LightBlack,
  LinkBlue,
  Midnight,
  White,
  Slate30,
  SlateDark,
} from '../../styles/colors';
import {
  selectAlertContext,
  selectAlertsAvailable,
} from '../../store/watchlist/watchlist.selectors';

import {
  closePriceAlert,
  finishPriceAlert,
  showPriceAlertError,
  showWatchlistFull,
  saveAlertFromUi,
  turnOffAlertFromUi,
  skipPriceAlert,
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
        gap: 10,
      }}>
      {([5, 10, 15, 20] as const).map(threshold => (
        <TouchableOpacity
          key={threshold}
          disabled={disabled}
          accessibilityRole="radio"
          accessibilityState={{checked: value === threshold, disabled}}
          accessibilityLabel={t('{{threshold}}%', {threshold})}
          onPress={() => onChange(threshold)}
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: 50,
            backgroundColor:
              value === threshold
                ? theme.dark
                  ? LinkBlue
                  : Action
                : theme.dark
                ? Midnight
                : Air,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 18,
          }}>
          <BaseText
            style={{
              fontSize: 16,
              lineHeight: 21,
              fontWeight: value === threshold ? '700' : '500',
              fontVariant: ['tabular-nums'],
              color:
                value === threshold
                  ? theme.dark
                    ? Black
                    : White
                  : theme.dark
                  ? White
                  : Action,
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
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, []);
  const save = async () => {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setButtonState('loading');
    try {
      const saved = await dispatch(
        saveAlertFromUi(sheet.coin, threshold, sheet.context),
      );
      if (!mounted.current) {
        return;
      }
      if (!saved) {
        dispatch(closePriceAlert(false, sheet.nonce));
        return;
      }
      setButtonState('success');
      timer.current = setTimeout(
        () => dispatch(closePriceAlert(true, sheet.nonce)),
        900,
      );
    } catch (error) {
      if (!mounted.current) {
        return;
      }
      busy.current = false;
      setButtonState(null);
      if ((error as {code?: string}).code === 'WATCHLIST_FULL') {
        dispatch(closePriceAlert(false, sheet.nonce));
        dispatch(showWatchlistFull(sheet.context));
      } else {
        dispatch(showPriceAlertError());
      }
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
                await dispatch(turnOffAlertFromUi(sheet.coin, sheet.context));
                dispatch(closePriceAlert(false, sheet.nonce));
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
          {sheet.isEdit ? t('Edit Price Alert') : t('Set Price Alert')}
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
          <Button state={buttonState} onPress={save}>
            {t('Save Price Alert')}
          </Button>
        </View>
        {sheet.isEdit ? (
          <Button buttonType="link" disabled={!!buttonState} onPress={turnOff}>
            {t('Turn Off Price Alert')}
          </Button>
        ) : sheet.afterAdd ? (
          <Button
            buttonType="link"
            disabled={!!buttonState}
            onPress={() => dispatch(skipPriceAlert(sheet.coin))}>
            {t('Not Now')}
          </Button>
        ) : null}
      </View>
    </SheetContainer>
  );
};
export default function PriceAlertSheet() {
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const sheet = useAppSelector(state => state.WATCHLIST.alertSheet);
  const available = useAppSelector(selectAlertsAvailable);
  useEffect(() => {
    if (!available && sheet?.open) {
      dispatch(closePriceAlert());
    }
  }, [available, dispatch, sheet?.open]);
  return (
    <SheetModal
      isVisible={!!sheet?.open && available}
      onBackdropPress={() => dispatch(closePriceAlert())}
      onModalHide={() => dispatch(finishPriceAlert())}
      enableBackdropDismiss
      modalLibrary="bottom-sheet"
      borderRadius={17}
      backgroundColor={theme.dark ? LightBlack : White}>
      {sheet ? <AlertForm key={sheet.nonce} sheet={sheet} /> : null}
    </SheetModal>
  );
}
