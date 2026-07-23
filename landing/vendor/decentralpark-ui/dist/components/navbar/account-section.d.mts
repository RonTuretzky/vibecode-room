import * as react from 'react';
import { App } from '../../interface/app.mjs';
import { NavAccountDetailsProps } from './account-widget.mjs';
import 'wagmi';
import '@wagmi/core';
import 'viem';

interface AccountSectionProps extends Pick<NavAccountDetailsProps, "widgetItems" | "actionItems"> {
    app: App;
}
declare const AccountSection: ({ app, widgetItems, actionItems }: AccountSectionProps) => react.JSX.Element;

export { AccountSection as default };
