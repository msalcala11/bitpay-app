import {useMemo} from 'react';
import {useAppSelector} from '../../../utils/hooks';

export function usePortfolioPopulateJob() {
  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);

  return useMemo(() => {
    return {
      populateDisabled: !!portfolio.populateDisabled,
      populateStatus: portfolio.populateStatus,
      inProgress: !!portfolio.populateStatus?.inProgress,
      lastPopulatedAt: portfolio.lastPopulatedAt,
      stopReason: portfolio.populateStatus?.stopReason,
      lastError:
        portfolio.populateStatus?.errors?.length
          ? portfolio.populateStatus.errors[
              portfolio.populateStatus.errors.length - 1
            ]
          : undefined,
    };
  }, [portfolio]);
}

export default usePortfolioPopulateJob;
