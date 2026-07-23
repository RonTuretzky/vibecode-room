import * as react from 'react';
import { ReactNode } from 'react';
import { App } from '../../interface/app.mjs';

interface LoginButtonPrivyProps {
    app: App;
    status: "CONNECTED" | "LOADING" | "UNSUPPORTED_CHAIN" | "NOT_CONNECTED";
    label?: string;
    rightIcon?: ReactNode;
}
declare const LoginButtonPrivy: ({ app, status, label, rightIcon, }: LoginButtonPrivyProps) => react.JSX.Element | null;

export { LoginButtonPrivy, type LoginButtonPrivyProps };
