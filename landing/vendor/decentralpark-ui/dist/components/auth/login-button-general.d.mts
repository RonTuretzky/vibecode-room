import * as react from 'react';
import { ReactNode } from 'react';
import { App } from '../../interface/app.mjs';

interface LoginButtonProps {
    app: App;
    status: "CONNECTED" | "LOADING" | "UNSUPPORTED_CHAIN" | "NOT_CONNECTED";
    label?: string;
    rightIcon?: ReactNode;
}
declare const LoginButtonGeneral: ({ app, status, label, rightIcon, }: LoginButtonProps) => react.JSX.Element | null;

export { LoginButtonGeneral };
