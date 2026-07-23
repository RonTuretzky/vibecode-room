import * as react from 'react';
import { ReactNode } from 'react';

interface IConnectedUserProviderGeneralProps {
    children: ReactNode;
    chainId: number;
}
declare function ConnectedUserProviderGeneral({ chainId, children }: IConnectedUserProviderGeneralProps): react.JSX.Element;

export { ConnectedUserProviderGeneral };
