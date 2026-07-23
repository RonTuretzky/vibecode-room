import * as react from 'react';
import { ReactNode } from 'react';

interface NavbarMenuProps {
    textClassName: string;
    mobileHeader: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
}
declare function NavbarMenu({ textClassName, mobileHeader, children, footer, }: NavbarMenuProps): react.JSX.Element;

export { NavbarMenu };
