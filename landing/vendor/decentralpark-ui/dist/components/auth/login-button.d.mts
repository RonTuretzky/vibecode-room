import * as react from 'react';
import { LoginButtonPrivyProps } from './login-button-privy.mjs';
import '../../interface/app.mjs';

declare const LoginButton: ({ label, ...props }: LoginButtonPrivyProps) => react.JSX.Element;

export { LoginButton };
