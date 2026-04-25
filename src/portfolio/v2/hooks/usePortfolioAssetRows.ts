import type {AssetGroupRowShell} from '../model';
import {usePortfolioSlice} from './usePortfolioSlice';

export function usePortfolioAssetRows(): readonly AssetGroupRowShell[] {
  return usePortfolioSlice(state => state.rowShells);
}
