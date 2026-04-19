import * as fs from 'fs';
import * as path from 'path';

const repoRoot = process.cwd();
const homeAssetRowPathFiles = [
  'src/navigation/tabs/home/components/AssetsSection.tsx',
  'src/navigation/tabs/home/components/AssetsList.tsx',
  'src/navigation/tabs/home/components/AssetRow.tsx',
  'src/navigation/tabs/home/screens/AllAssets.tsx',
  'src/navigation/tabs/home/hooks/usePortfolioAssetRows.ts',
  'src/portfolio/ui/hooks/usePortfolioAssetRows.ts',
  'src/portfolio/ui/selectors/formatAssetRowsFromRpc.ts',
];

describe('Home / All Assets asset-row PnL wiring', () => {
  it('does not import the legacy JS-side PnL analysis or asset-row aggregation path', () => {
    for (const relativePath of homeAssetRowPathFiles) {
      const contents = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

      expect(contents).not.toContain('buildAssetRowsFromAnalysis');
      expect(contents).not.toContain('buildPnlAnalysisSeries');
      expect(contents).not.toContain("from './usePortfolioAnalysis'");
      expect(contents).not.toContain("from '../hooks/usePortfolioAnalysis'");
      expect(contents).not.toContain("from '../../../portfolio/ui/hooks/usePortfolioAnalysis'");
    }
  });

  it('uses the compact async asset-row RPC as the Home / All Assets source of truth', () => {
    const hookSource = fs.readFileSync(
      path.join(repoRoot, 'src/portfolio/ui/hooks/usePortfolioAssetRows.ts'),
      'utf8',
    );
    const commonSource = fs.readFileSync(
      path.join(repoRoot, 'src/portfolio/ui/common.ts'),
      'utf8',
    );
    const clientSource = fs.readFileSync(
      path.join(repoRoot, 'src/portfolio/runtime/portfolioClient.ts'),
      'utf8',
    );

    expect(hookSource).toContain('runPortfolioAssetRowsQuery');
    expect(commonSource).toContain('computeAssetRows');
    expect(clientSource).toContain("analysis.computeAssetRows");
  });
});
