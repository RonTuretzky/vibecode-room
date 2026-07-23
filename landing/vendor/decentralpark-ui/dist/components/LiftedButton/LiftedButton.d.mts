import react__default from 'react';
import { LiftedButtonPreset, LiftedButtonColors } from './LiftedButtonPresets.mjs';

type LiftedButtonProps = {
    children: react__default.ReactNode;
    leftIcon?: react__default.ReactNode;
    rightIcon?: react__default.ReactNode;
    disabled?: boolean;
    preset?: LiftedButtonPreset;
    colorOverrides?: Partial<LiftedButtonColors>;
    offsetPx?: number;
    durationMs?: number;
    className?: string;
    width?: "full" | "auto" | "mobile-full";
    scrollTo?: string;
} & react__default.ComponentPropsWithoutRef<"button">;
/**
 * LiftedButton — a square-edged button that floats up-left of a dark base layer.
 * - Preset: Choose "primary" (default), "secondary", "destructive", or "positive"
 * - ColorOverrides: Pass in a dict specifying manual colours
 * - Hover: fades to alternate colors.
 * - Active: depresses button and colors return to normal.
 * - Transition duration defaults to 500ms.
 * - Icons can be rendered on the right or left.
 */
declare function LiftedButton({ children, leftIcon, rightIcon, disabled, preset, colorOverrides, offsetPx, durationMs, className, type, width, scrollTo, ...rest }: LiftedButtonProps): react__default.JSX.Element;

export { type LiftedButtonProps, LiftedButton as default };
