import Clipboard from '@react-native-clipboard/clipboard';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {TouchableOpacity, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import styled, {useTheme} from 'styled-components/native';
import {BaseText} from '../styled/Text';
import {
  clearPerfLogs,
  formatPerfLogsForExport,
  perfLogger,
  recordPerfEvent,
  TEMP_PERF_LOGGING_ENABLED,
} from '../../utils/perfLogger';

const FloatingContainer = styled(View)`
  position: absolute;
  right: 16px;
  z-index: 9999;
  align-items: flex-end;
`;

const FloatingButton = styled(TouchableOpacity)<{$backgroundColor: string}>`
  min-width: 132px;
  border-radius: 14px;
  padding: 12px 14px;
  background-color: ${({$backgroundColor}) => $backgroundColor};
  shadow-color: #000;
  shadow-opacity: 0.18;
  shadow-radius: 12px;
  shadow-offset: 0px 4px;
  elevation: 10;
`;

const FloatingButtonLabel = styled(BaseText)`
  font-size: 13px;
  font-weight: 700;
  line-height: 18px;
  color: #fff;
`;

const FloatingButtonMeta = styled(BaseText)`
  margin-top: 4px;
  font-size: 11px;
  line-height: 14px;
  color: rgba(255, 255, 255, 0.78);
`;

type PerfLogsFloatingButtonProps = {
  getCurrentRouteName?: () => string | undefined;
};

const EVENT_LOOP_SAMPLE_MS = 250;
const EVENT_LOOP_LAG_THRESHOLD_MS = 120;
const FLOATING_BUTTON_BOTTOM_OFFSET = -80;

const PerfLogsFloatingButton = ({
  getCurrentRouteName,
}: PerfLogsFloatingButtonProps) => {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [entryCount, setEntryCount] = useState(perfLogger.getLogData().count);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!TEMP_PERF_LOGGING_ENABLED) {
      return;
    }

    return perfLogger.subscribe(data => {
      setEntryCount(data.count);
    });
  }, []);

  useEffect(() => {
    if (!TEMP_PERF_LOGGING_ENABLED) {
      return;
    }

    let expectedAtMs = Date.now() + EVENT_LOOP_SAMPLE_MS;

    const interval = setInterval(() => {
      const nowMs = Date.now();
      const lagMs = nowMs - expectedAtMs;

      if (lagMs > EVENT_LOOP_LAG_THRESHOLD_MS) {
        recordPerfEvent('js.event_loop_lag', {
          lagMs,
          route: getCurrentRouteName?.(),
          sampleIntervalMs: EVENT_LOOP_SAMPLE_MS,
        });
      }

      expectedAtMs = nowMs + EVENT_LOOP_SAMPLE_MS;
    }, EVENT_LOOP_SAMPLE_MS);

    return () => {
      clearInterval(interval);
    };
  }, [getCurrentRouteName]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const onPress = () => {
    const route = getCurrentRouteName?.();
    const exportText = formatPerfLogsForExport({
      currentRoute: route,
    });

    Clipboard.setString(exportText);
    recordPerfEvent('perf_logs.copied', {
      currentRoute: route,
      copiedEntryCount: perfLogger.getLogData().count,
    });

    setStatusLabel('Copied');
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setStatusLabel(null);
    }, 2200);
  };

  const onLongPress = () => {
    clearPerfLogs();
    setStatusLabel('Cleared');
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => {
      setStatusLabel(null);
    }, 2200);
  };

  const metaLabel = useMemo(() => {
    if (statusLabel) {
      return `${statusLabel} | ${entryCount} entries`;
    }

    return `${entryCount} entries`;
  }, [entryCount, statusLabel]);

  if (!TEMP_PERF_LOGGING_ENABLED) {
    return null;
  }

  return (
    <FloatingContainer
      pointerEvents="box-none"
      style={{
        bottom: Math.max(
          insets.bottom + FLOATING_BUTTON_BOTTOM_OFFSET,
          76,
        ),
      }}>
      <FloatingButton
        $backgroundColor={theme.dark ? '#173757' : '#1a3b8b'}
        activeOpacity={0.86}
        delayLongPress={350}
        onLongPress={onLongPress}
        onPress={onPress}>
        <FloatingButtonLabel>Copy perf logs</FloatingButtonLabel>
        <FloatingButtonMeta>{metaLabel}</FloatingButtonMeta>
      </FloatingButton>
    </FloatingContainer>
  );
};

export default PerfLogsFloatingButton;
