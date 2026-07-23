import * as react from 'react';
import { ReactNode } from 'react';

interface IConnectedUserProviderPrivyProps {
    children: ReactNode;
    chainId: number;
}
declare function ConnectedUserProviderPrivy({ chainId, children, }: IConnectedUserProviderPrivyProps): react.JSX.Element;

export { ConnectedUserProviderPrivy };
