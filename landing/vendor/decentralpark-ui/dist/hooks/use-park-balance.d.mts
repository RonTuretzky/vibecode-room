import * as viem from 'viem';
import { Address } from 'viem';
import * as _tanstack_query_core from '@tanstack/query-core';

declare const useParkBalance: ({ address }: {
    address: Address;
}) => {
    PARK: string;
    refetchBalance: (options?: _tanstack_query_core.RefetchOptions) => Promise<_tanstack_query_core.QueryObserverResult<bigint, viem.ReadContractErrorType>>;
    isLoading: boolean;
};

export { useParkBalance };
