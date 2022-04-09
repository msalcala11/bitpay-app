import React, {useMemo, useState} from 'react';
import DraggableFlatList, {
  RenderItemParams,
  ScaleDecorator,
} from 'react-native-draggable-flatlist';
import {
  ActiveOpacity,
  CtaContainerAbsolute,
} from '../../../../../../components/styled/Containers';
import {H7} from '../../../../../../components/styled/Text';
import HamburgerSvg from '../../../../../../../assets/img/hamburger.svg';
import Button from '../../../../../../components/button/Button';
import {FlatList} from 'react-native';
import {useAppDispatch, useAppSelector} from '../../../../../../utils/hooks';
import {
  dismissOnGoingProcessModal,
  setHomeCarouselConfig,
  setHomeCarouselLayoutType,
  showOnGoingProcessModal,
} from '../../../../../../store/app/app.actions';
import {useNavigation} from '@react-navigation/native';
import {OnGoingProcessMessages} from '../../../../../../components/modal/ongoing-process/OngoingProcess';
import {sleep} from '../../../../../../utils/helper-methods';
import haptic from '../../../../../../components/haptic-feedback/haptic';
import {createMaterialTopTabNavigator} from '@react-navigation/material-top-tabs';
import {ScreenOptions} from '../../../../../../styles/tabNavigator';
import {useTheme} from 'styled-components';
import {
  CarouselSvg,
  createCustomizeCardList,
  CustomizeCard,
  CustomizeCardContainer,
  CustomizeHomeContainer,
  CustomizeItem,
  HamburgerContainer,
  LayoutToggleContainer,
  ListFooterButtonContainer,
  ListHeader,
  ListViewSvg,
} from './Shared';
import {useAndroidBackHandler} from 'react-navigation-backhandler';

enum LayoutTypes {
  CAROUSEL = 'Carousel',
  LIST_VIEW = 'List View',
}

// Layout selector
const Noop = () => null;

const CustomizeHome = () => {
  useAndroidBackHandler(() => true);
  const dispatch = useAppDispatch();
  const keys = useAppSelector(({WALLET}) => WALLET.keys);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig)!;
  const defaultLayoutType = useAppSelector(
    ({APP}) => APP.homeCarouselLayoutType,
  );
  const [layoutType, setLayoutType] = useState(defaultLayoutType);
  const navigation = useNavigation();
  const theme = useTheme();
  const [_visible, _hidden] = createCustomizeCardList({
    keys: Object.values(keys),
    homeCarouselConfig,
  });
  const [visibleList, setVisibleList] = useState(_visible);
  const [dirty, setDirty] = useState(false);
  const [hiddenList, setHiddenList] = useState(_hidden);
  const Tab = createMaterialTopTabNavigator();

  const toggle = (item: CustomizeItem) => {
    const {show, key} = item;
    item.show = !show;
    setDirty(true);
    if (show) {
      setVisibleList(visibleList.filter(vi => vi.key !== key));
      setHiddenList(hiddenList.concat(item));
    } else {
      setHiddenList(hiddenList.filter(hi => hi.key !== key));
      setVisibleList(visibleList.concat(item));
    }
  };

  const visibleRenderItem = ({item, drag, isActive}: RenderItemParams<any>) => {
    return (
      <ScaleDecorator>
        <CustomizeCardContainer
          delayLongPress={100}
          onLongPress={() => {
            haptic('soft');
            drag();
          }}
          disabled={isActive}
          activeOpacity={ActiveOpacity}>
          <HamburgerContainer>
            <HamburgerSvg />
          </HamburgerContainer>
          <CustomizeCard item={item} toggle={() => toggle(item)} />
        </CustomizeCardContainer>
      </ScaleDecorator>
    );
  };

  const ListFooterComponent = () => {
    return (
      <ListFooterButtonContainer>
        <Button
          disabled={!dirty}
          style={{marginTop: 100}}
          onPress={async () => {
            dispatch(
              showOnGoingProcessModal(OnGoingProcessMessages.SAVING_LAYOUT),
            );
            await sleep(1000);
            const list = [...visibleList, ...hiddenList].map(({key, show}) => ({
              id: key,
              show,
            }));
            dispatch(setHomeCarouselConfig(list));
            dispatch(setHomeCarouselLayoutType(layoutType));
            navigation.goBack();
            dispatch(dismissOnGoingProcessModal());
          }}
          buttonStyle={'primary'}>
          Save Layout
        </Button>
      </ListFooterButtonContainer>
    );
  };

  const memoizedFooterList = useMemo(() => {
    return (
      <FlatList
        ListHeaderComponent={() => {
          return hiddenList.length ? <ListHeader>Hidden</ListHeader> : null;
        }}
        contentContainerStyle={{paddingBottom: 250}}
        data={hiddenList}
        renderItem={({item}: any) => {
          return (
            <CustomizeCardContainer activeOpacity={ActiveOpacity}>
              <CustomizeCard item={item} toggle={() => toggle(item)} />
            </CustomizeCardContainer>
          );
        }}
        keyExtractor={item => item.key}
      />
    );
  }, [hiddenList]);

  return (
    <CustomizeHomeContainer>
      <LayoutToggleContainer>
        <H7>Home Layout</H7>
        <Tab.Navigator
          initialRouteName={
            layoutType === 'carousel'
              ? LayoutTypes.CAROUSEL
              : LayoutTypes.LIST_VIEW
          }
          style={{marginTop: 20}}
          screenOptions={{
            ...ScreenOptions(150),
            tabBarItemStyle: {
              flexDirection: 'row',
            },
            tabBarIconStyle: {
              justifyContent: 'center',
            },
          }}
          screenListeners={{
            tabPress: tab => {
              haptic('soft');
              if (tab.target) {
                setDirty(true);
                setLayoutType(
                  tab.target.includes('Carousel') ? 'carousel' : 'listView',
                );
              }
            },
          }}>
          <Tab.Screen
            name={LayoutTypes.CAROUSEL}
            component={Noop}
            options={{
              tabBarIcon: ({focused}) => (
                <CarouselSvg focused={focused} theme={theme} />
              ),
            }}
          />
          <Tab.Screen
            name={LayoutTypes.LIST_VIEW}
            component={Noop}
            options={{
              tabBarIcon: ({focused}) => (
                <ListViewSvg focused={focused} theme={theme} />
              ),
            }}
          />
        </Tab.Navigator>
      </LayoutToggleContainer>

      <DraggableFlatList
        ListHeaderComponent={() =>
          visibleList.length ? <ListHeader>Favorites</ListHeader> : null
        }
        ListFooterComponent={memoizedFooterList}
        contentContainerStyle={{paddingTop: 20, paddingBottom: 250}}
        onDragEnd={({data}) => {
          if (!dirty) {
            setDirty(true);
          }
          setVisibleList(data);
        }}
        data={visibleList}
        renderItem={visibleRenderItem}
        keyExtractor={item => item.key}
      />
      <CtaContainerAbsolute
        background={true}
        style={{
          shadowColor: '#000',
          shadowOffset: {width: 0, height: 4},
          shadowOpacity: 0.1,
          shadowRadius: 12,
          elevation: 5,
        }}>
        <ListFooterComponent />
      </CtaContainerAbsolute>
    </CustomizeHomeContainer>
  );
};

export default CustomizeHome;
