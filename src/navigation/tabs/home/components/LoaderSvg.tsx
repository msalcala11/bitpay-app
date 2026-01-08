import React from 'react';
import {
  ClipPath,
  Defs,
  G,
  LinearGradient,
  Path,
  Stop,
  Svg,
} from 'react-native-svg';
import {useTheme} from 'styled-components/native';

type LoaderSvgProps = {
  size?: number;
};

const loaderPath =
  'M28.9794 16C30.6476 16 32.0288 17.3641 31.7157 19.0027C31.3156 21.0966 30.4991 23.0998 29.3035 24.8891C27.5454 27.5203 25.0466 29.5711 22.1229 30.7821C19.1993 31.9931 15.9823 32.3099 12.8786 31.6926C9.77486 31.0752 6.92393 29.5513 4.68629 27.3137C2.44865 25.0761 0.924799 22.2251 0.307435 19.1214C-0.309928 16.0177 0.00692538 12.8007 1.21793 9.87706C2.42893 6.95345 4.47969 4.45459 7.11088 2.69649C8.90024 1.50087 10.9034 0.684358 12.9973 0.284275C14.6359 -0.0288074 16 1.35235 16 3.02056C16 4.68877 14.6176 5.99745 13.0255 6.49571C12.1235 6.77799 11.2615 7.18873 10.4671 7.7195C8.82942 8.81379 7.55296 10.3692 6.7992 12.1889C6.04544 14.0086 5.84822 16.011 6.23248 17.9429C6.61675 19.8747 7.56524 21.6492 8.95801 23.042C10.3508 24.4348 12.1253 25.3833 14.0571 25.7675C15.989 26.1518 17.9914 25.9546 19.8111 25.2008C21.6308 24.447 23.1862 23.1706 24.2805 21.5329C24.8113 20.7385 25.222 19.8765 25.5043 18.9745C26.0025 17.3824 27.3112 16 28.9794 16Z';

const variants = {
  dark: {
    gradientId: 'loaderSvgGradientDark',
    clipId: 'loaderSvgClipDark',
    stops: [
      {offset: '0%', color: 'rgba(73, 137, 255, 0)'},
      {offset: '100%', color: 'rgba(73, 137, 255, 1)'},
    ],
    rimOpacity: 0.25,
  },
  light: {
    gradientId: 'loaderSvgGradientLight',
    clipId: 'loaderSvgClipLight',
    stops: [
      {offset: '0%', color: 'rgba(34, 64, 196, 0)'},
      {offset: '100%', color: 'rgba(34, 64, 196, 1)'},
    ],
    rimOpacity: 0.2,
  },
};

const LoaderSvg: React.FC<LoaderSvgProps> = ({size = 32}) => {
  const theme = useTheme();
  const variant = theme.dark ? variants.dark : variants.light;
  const gradientFill = `url(#${variant.gradientId})`;

  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <Defs>
        <LinearGradient
          id={variant.gradientId}
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse">
          {variant.stops.map(stop => (
            <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
          ))}
        </LinearGradient>
        <ClipPath id={variant.clipId}>
          <Path d={loaderPath} />
        </ClipPath>
      </Defs>
      <G clipPath={`url(#${variant.clipId})`}>
        <Path d={loaderPath} fill={gradientFill} />
      </G>
      <Path
        d={loaderPath}
        fill={variant.stops[variant.stops.length - 1].color}
        opacity={variant.rimOpacity}
      />
    </Svg>
  );
};

export default LoaderSvg;
