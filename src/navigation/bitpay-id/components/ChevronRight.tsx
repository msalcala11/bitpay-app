import React from 'react';
import {useTheme} from '@react-navigation/native';
import Svg, {Path} from 'react-native-svg';
import {Action} from '../../../styles/colors';

const ChevronRight = () => {
  const theme = useTheme();
  return (
    <Svg width="9" height="16" viewBox="0 0 9 16" fill="none">
      <Path
        d="M8.62421 7.04093L2.20673 0.374282C1.70311 -0.131013 0.90259 -0.123787 0.407503 0.390524C-0.087585 0.904834 -0.0945413 1.73644 0.391868 2.25961L5.90192 7.9836L0.391868 13.7076C0.0582148 14.0424 -0.0755974 14.5381 0.0418623 15.0043C0.159322 15.4704 0.509774 15.8345 0.958522 15.9565C1.40727 16.0785 1.88448 15.9395 2.20673 15.5929L8.62421 8.92626C9.12526 8.4056 9.12526 7.5616 8.62421 7.04093Z"
        fill={theme.dark ? '#9BA3AE' : Action}
      />
    </Svg>
  );
};

export default ChevronRight;
