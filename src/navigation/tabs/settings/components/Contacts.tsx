import React from 'react';
import {H6, Link} from '../../../../components/styled/Text';
import {RootState} from '../../../../store';
import {useAppSelector} from '../../../../utils/hooks';
import {SettingsComponent} from '../SettingsRoot';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {
  ActiveOpacity,
  Hr,
  Setting,
} from '../../../../components/styled/Containers';
import {View} from 'react-native';
import styled from 'styled-components/native';
import {useTranslation} from 'react-i18next';
import ContactRow from '../../../../components/list/ContactRow';
import {SettingsDetailsParamList} from '../SettingsDetails';
import * as Svg from 'react-native-svg';
import {useTheme} from 'styled-components/native';

const SeeAllLink = styled(Link)`
  font-weight: 500;
  font-size: 18px;
`;

const PlusIconContainer = styled.View`
  margin-right: 15px;
`;

const AddIcon = () => {
  const theme = useTheme();
  return (
    <Svg.Svg width="43px" height="43px" fill="none">
      <Svg.Rect
        width="43"
        height="43"
        rx="12"
        fill={theme.dark ? '#383838' : '#edf0f4'}
      />
      <Svg.Path
        fill={theme.dark ? '#fff' : '#434d5a'}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M22.5 21.5V27H20.5V21.5H15V19.5H20.5V14H22.5V19.5H28V21.5H22.5Z"
      />
    </Svg.Svg>
  );
};

type Props = NativeStackScreenProps<SettingsDetailsParamList, 'Contacts'>;

const Contacts: React.FC<Props> = ({navigation}) => {
  const {t} = useTranslation();
  const contacts = useAppSelector(({CONTACT}: RootState) => CONTACT.list);
  
  return (
    <SettingsComponent>
      {contacts.length
        ? contacts.slice(0, 2).map((item, index) => (
            <View key={index}>
              <ContactRow
                contact={item}
                onPress={() => {
                  navigation.navigate('ContactsDetails', {contact: item});
                }}
              />
              <Hr />
            </View>
          ))
        : null}

      <Setting
        activeOpacity={ActiveOpacity}
        onPress={() => {
          navigation.navigate('ContactsAdd');
        }}>
        <PlusIconContainer>
          <AddIcon />
        </PlusIconContainer>

        <H6 medium={true}>{t('Add Contact')}</H6>
      </Setting>

      {contacts.length > 2 ? (
        <Setting
          style={{justifyContent: 'center'}}
          onPress={() => navigation.navigate('ContactsRoot')}
          activeOpacity={ActiveOpacity}>
          <SeeAllLink>
            {t('View All Contacts', {contactsLength: contacts.length})}
          </SeeAllLink>
        </Setting>
      ) : null}
    </SettingsComponent>
  );
};

export default Contacts;
