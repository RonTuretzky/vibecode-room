import * as react from 'react';
import { App } from '../../interface/app.mjs';

interface NavSolidarityAppsProps {
    current?: App;
    className?: string;
    showTitle?: boolean;
    showSelected?: boolean;
    rearranged?: boolean;
}
declare const NavSolidarityApps: ({ current, className, showTitle, showSelected, rearranged, }: NavSolidarityAppsProps) => react.JSX.Element;
declare const NavSolidarityAppsDesktop: ({ label, app, }: {
    app: App;
    label: string;
}) => react.JSX.Element;

export { NavSolidarityApps, NavSolidarityAppsDesktop };
