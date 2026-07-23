import * as react from 'react';
import { ComponentPropsWithoutRef } from 'react';

type LogoColor = "green" | "sky" | "pine" | "white";
type LogoVariant = "square" | "line";
type LogoProps = {
    /** Size of the logo in pixels. Defaults to 32px */
    size?: number;
    /** Additional CSS classes to apply to the logo */
    className?: string;
    /**
     * Rendering treatment. Decentral Park has a single official mark; `"white"`
     * knocks it out to white for use on a colored/dark background (e.g. the
     * footer). Other values render the standard full-color logo.
     */
    color?: LogoColor;
    /** `"square"` sets the mark on a rounded paper tile. */
    variant?: LogoVariant;
    /** Optional text to display next to the logo */
    text?: string;
} & Omit<ComponentPropsWithoutRef<"img">, "color" | "width" | "height">;
/**
 * The official Decentral Park logo — a tree inside a dashed ring — rendered
 * from a self-contained, optimized image (no external asset required).
 *
 * @param size - Size of the logo in pixels (default: 32)
 * @param className - Additional CSS classes
 * @param color - `"white"` for a knockout on colored backgrounds; otherwise full color
 * @param variant - `"square"` places the mark on a rounded paper tile
 * @param text - Optional text to display next to the logo
 */
declare function Logo({ size, className, color, variant, text, style, ...rest }: LogoProps): react.JSX.Element;

export { type LogoColor, type LogoProps, type LogoVariant, Logo as default };
