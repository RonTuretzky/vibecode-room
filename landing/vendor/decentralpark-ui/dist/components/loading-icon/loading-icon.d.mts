import * as react from 'react';
import { App } from '../../interface/app.mjs';

/**
 * LoadingIcon — the Decentral Park spinner: the logo's dashed outer ring,
 * rotating. Tinted per app (`fund` = green, `stacks` = sky, `net` = pine).
 */
declare function LoadingIcon({ app, className, }: {
    app: App;
    className?: string;
}): react.JSX.Element;

export { LoadingIcon };
