import * as react from 'react';
import { ReactNode } from 'react';
import { Icon } from '@phosphor-icons/react';

declare const NavAccountWidgetItem: ({ I, label, children, appIconColor, }: {
    I: Icon;
    appIconColor: string;
    label: string;
    children: ReactNode;
}) => react.JSX.Element;

export { NavAccountWidgetItem as default };
