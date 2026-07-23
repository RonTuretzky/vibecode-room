import * as react from 'react';

interface FooterProps {
    className?: string;
    topClassName?: string;
    infoClassName?: string;
    mode?: "colored" | "transparent";
}
declare function Footer({ className, topClassName, infoClassName, mode, }: FooterProps): react.JSX.Element;

export { Footer as default };
