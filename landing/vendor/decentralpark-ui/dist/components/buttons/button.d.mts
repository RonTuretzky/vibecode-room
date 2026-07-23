import * as react from 'react';
import { ElementType, ReactNode, ComponentPropsWithoutRef } from 'react';
import { App } from '../../interface/app.mjs';

type Variant = "primary" | "secondary" | "destructive" | "positive" | "light" | "burn";
type ButtonOwnProps<E extends ElementType = "button"> = {
    as?: E;
    app?: App;
    size?: "sm" | "default" | "icon";
    variant?: Variant;
    rightIcon?: ReactNode;
    leftIcon?: ReactNode;
    isLoading?: boolean;
    showChildrenWhenLoading?: boolean;
    withBorder?: boolean;
};
type ButtonProps<E extends ElementType = "button"> = ButtonOwnProps<E> & Omit<ComponentPropsWithoutRef<E>, keyof ButtonOwnProps<E>>;
declare const Button: <E extends ElementType = "button">({ as, app, size, variant, rightIcon, leftIcon, children, disabled, className, isLoading, showChildrenWhenLoading, withBorder, ...rest }: ButtonProps<E>) => react.JSX.Element;

export { type ButtonProps, Button as default };
