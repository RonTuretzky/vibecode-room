type LiftedButtonColors = {
    bg: string;
    text: string;
    hoverBg: string;
    hoverText: string;
    shadowBg: string;
};
type LiftedButtonPreset = keyof typeof LIFTED_BUTTON_PRESETS;
declare const LIFTED_BUTTON_PRESETS: {
    primary: {
        bg: string;
        text: string;
        hoverBg: string;
        hoverText: string;
        shadowBg: string;
    };
    secondary: {
        bg: string;
        text: string;
        hoverBg: string;
        hoverText: string;
        shadowBg: string;
    };
    destructive: {
        bg: string;
        text: string;
        hoverBg: string;
        hoverText: string;
        shadowBg: string;
    };
    positive: {
        bg: string;
        text: string;
        hoverBg: string;
        hoverText: string;
        shadowBg: string;
    };
    stroke: {
        bg: string;
        text: string;
        hoverBg: string;
        hoverText: string;
        shadowBg: string;
    };
    burn: {
        bg: string;
        text: string;
        hoverBg: string;
        hoverText: string;
        shadowBg: string;
    };
};
declare function colorsToStyleVars(c: LiftedButtonColors): React.CSSProperties;

export { LIFTED_BUTTON_PRESETS, type LiftedButtonColors, type LiftedButtonPreset, colorsToStyleVars };
