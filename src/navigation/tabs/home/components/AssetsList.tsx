import React from 'react';
import styled from 'styled-components/native';
import {ScreenGutter} from '../../../../components/styled/Containers';
import AssetRow from './AssetRow';
import {AssetRowItem} from './AssetsMockData';

const List = styled.View`
  margin: 10px ${ScreenGutter} 10px;
`;

interface Props {
  items: AssetRowItem[];
  onRowPress?: (item: AssetRowItem) => void;
}

const AssetsList: React.FC<Props> = ({items, onRowPress}) => {
  return (
    <List>
      {items.map((item, index) => (
        <AssetRow
          key={item.key}
          item={item}
          isLast={index === items.length - 1}
          onPress={onRowPress ? () => onRowPress(item) : undefined}
        />
      ))}
    </List>
  );
};

export default AssetsList;
