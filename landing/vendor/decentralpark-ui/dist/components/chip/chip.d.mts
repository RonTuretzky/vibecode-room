import * as react from 'react';
import { ReactNode } from 'react';

interface ChipProps {
    size?: "small" | "regular";
    children: ReactNode;
    icon?: boolean;
    className?: string;
}
declare const Chip: ({ size, icon, className, children, }: ChipProps) => react.JSX.Element;

export { Chip as default };
