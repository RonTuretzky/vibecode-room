import * as react from 'react';
import { Address } from 'viem';
import { NavAccountDetailsProps } from './account-widget.mjs';
import { App } from '../../interface/app.mjs';
import 'wagmi';
import '@wagmi/core';

interface AccountMenuProps extends Pick<NavAccountDetailsProps, "widgetItems" | "ensNameResult" | "actionItems"> {
    userAddress: Address;
    app: App;
}
declare const AccountMenu: ({ userAddress, ensNameResult, app, widgetItems, actionItems }: AccountMenuProps) => react.JSX.Element;

export { type AccountMenuProps, AccountMenu as default };
