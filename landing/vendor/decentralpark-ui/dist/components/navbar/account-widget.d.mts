import * as react from 'react';
import { ReactNode } from 'react';
import { UseEnsNameReturnType } from 'wagmi';
import { GetEnsNameReturnType } from '@wagmi/core';
import { App } from '../../interface/app.mjs';
import { Address } from 'viem';

interface NavAccountDetailsProps {
    userAddress: Address;
    ensNameResult: UseEnsNameReturnType<GetEnsNameReturnType> | {
        data: string | undefined;
        isLoading: boolean;
        isError: boolean;
    };
    className?: string;
    app: App;
    widgetItems?: ReactNode;
    actionItems?: ReactNode;
}
declare const NavAccountDetails: ({ className, userAddress, ensNameResult, app, widgetItems, actionItems, }: NavAccountDetailsProps) => react.JSX.Element;

export { type NavAccountDetailsProps, NavAccountDetails as default };
