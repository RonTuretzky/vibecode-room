import { LogoColor } from '../components/Logo/Logo.mjs';
import 'react';

interface SolidarityTool {
    id: string;
    title: string;
    shortDescription: string;
    description: string;
    color: LogoColor;
    buttonClass: string;
    colorOverrides?: {
        bg: string;
        hoverBg: string;
    };
    webLink?: string;
    comingSoon: boolean;
}
declare const SOLIDARITY_TOOLS: SolidarityTool[];
declare function getSolidarityToolsByIds(ids: string[]): SolidarityTool[];
declare function getVisibleSolidarityTools(hiddenIds?: string[]): SolidarityTool[];

export { SOLIDARITY_TOOLS, type SolidarityTool, getSolidarityToolsByIds, getVisibleSolidarityTools };
