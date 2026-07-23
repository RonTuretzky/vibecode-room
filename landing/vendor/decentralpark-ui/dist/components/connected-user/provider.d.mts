import * as react from 'react';
import { ReactNode } from 'react';

interface IConnectedUserProviderProps {
    children: ReactNode;
}
declare function ConnectedUserProvider({ children }: IConnectedUserProviderProps): react.JSX.Element;

export { ConnectedUserProvider };
