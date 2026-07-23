import * as react from 'react';
import { ReactNode, ComponentType, AnchorHTMLAttributes } from 'react';
import { App } from '../../interface/app.mjs';
import { NavAccountDetailsProps } from './account-widget.mjs';
import 'wagmi';
import '@wagmi/core';
import 'viem';

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children?: React.ReactNode;
};
interface NavbarProps extends Pick<NavAccountDetailsProps, "widgetItems" | "actionItems"> {
    app: App;
    children: ReactNode;
    className?: string;
    /**
     * The link component of your framework (next/link, react-router-dom Link, etc).
     * Must accept `href`.
     */
    Link: ComponentType<LinkProps>;
}
declare function Navbar({ app, children, className, widgetItems, actionItems, Link, }: NavbarProps): react.JSX.Element;

export { Navbar };
